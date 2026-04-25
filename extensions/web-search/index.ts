import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonRecord = Record<string, any>;

type ProviderId = "openai-codex";

type SearchRequest = {
  provider?: ProviderId;
  model?: string;
  query: string;
  purpose: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

type SearchResult = {
  provider: ProviderId;
  model: string;
  result: string;
  details?: JsonRecord;
};

type ProviderAdapter = {
  id: ProviderId;
  displayName: string;
  search(request: SearchRequest, auth: JsonRecord, authPath: string): Promise<SearchResult>;
};

function readJson(path: string, fallback: JsonRecord = {}): JsonRecord {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: JsonRecord) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfigValue(config: unknown): string | undefined {
  if (typeof config !== "string" || !config) return undefined;
  if (config.startsWith("!")) {
    try {
      const out = execSync(config.slice(1), {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  }
  return process.env[config] || config;
}

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured;
}

function decodeJwtAccountId(jwt: string | undefined): string | undefined {
  if (!jwt) return undefined;
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

function parseExpiryTimestamp(expires: unknown): number | undefined {
  if (typeof expires === "number" && Number.isFinite(expires)) {
    if (expires <= 0) return undefined;
    return expires < 1_000_000_000_000 ? expires * 1000 : expires;
  }

  if (typeof expires === "string") {
    const trimmed = expires.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return parseExpiryTimestamp(numeric);

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function getCachedOAuthAccess(entry: JsonRecord | undefined, now = Date.now()) {
  if (!entry || typeof entry !== "object") return undefined;

  const apiKey = resolveConfigValue(entry.access);
  if (!apiKey) return undefined;

  const expiresAt = parseExpiryTimestamp(entry.expires);
  if (!expiresAt) return undefined;
  if (now + 30_000 >= expiresAt) return undefined;

  return { apiKey, accountId: entry.accountId };
}

async function loadPiAi(): Promise<JsonRecord> {
  try {
    return await import("@mariozechner/pi-ai");
  } catch {
    return {};
  }
}

async function loadOAuthHelper(piAi: JsonRecord) {
  if (typeof piAi?.getOAuthApiKey === "function") {
    return piAi.getOAuthApiKey.bind(piAi);
  }

  try {
    const oauth = await import("@mariozechner/pi-ai/oauth");
    if (typeof oauth?.getOAuthApiKey === "function") {
      return oauth.getOAuthApiKey.bind(oauth);
    }
  } catch {
    // Fall back to cached token below.
  }

  return undefined;
}

async function resolveApiKey(provider: ProviderId, auth: JsonRecord, authPath: string, piAi: JsonRecord) {
  const entry = auth?.[provider];
  if (!entry) {
    throw new Error(`No credentials for provider '${provider}' in ${authPath}. Run /login in pi first.`);
  }

  const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);

  if (inferredType === "api_key") {
    const key = resolveConfigValue(entry.key);
    if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
    return { apiKey: key, accountId: entry.accountId };
  }

  if (inferredType !== "oauth") {
    throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);
  }

  const fallbackToken = getCachedOAuthAccess(entry);
  const getOAuthApiKey = await loadOAuthHelper(piAi);

  if (typeof getOAuthApiKey !== "function") {
    if (fallbackToken) return fallbackToken;
    throw new Error("Could not load @mariozechner/pi-ai OAuth helper, and cached OAuth token is missing or expired.");
  }

  const oauthCreds: JsonRecord = {};
  for (const [key, value] of Object.entries(auth || {})) {
    const candidate = value as JsonRecord;
    if (candidate && (candidate.type === "oauth" || (candidate.access && candidate.refresh && candidate.expires))) {
      oauthCreds[key] = candidate;
    }
  }

  try {
    const refreshed = await getOAuthApiKey(provider, oauthCreds);
    if (refreshed?.apiKey) {
      const mergedCred = { type: "oauth", ...(entry || {}), ...(refreshed.newCredentials || {}) };
      auth[provider] = mergedCred;
      writeJson(authPath, auth);
      return { apiKey: refreshed.apiKey, accountId: mergedCred.accountId };
    }
  } catch (err) {
    if (!fallbackToken) throw err;
  }

  if (fallbackToken) return fallbackToken;
  throw new Error(`No OAuth credentials available for provider '${provider}'.`);
}

function buildUserPrompt(query: string, purpose: string): string {
  return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt(): string {
  return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api"): string {
  const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function extractEventData(chunk: string): string | null {
  const payload = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  const signals = [a, b].filter(Boolean) as AbortSignal[];
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  return signals[0];
}

async function collectCodexStreamText(res: Response): Promise<string> {
  if (!res.body) throw new Error("Codex response had no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let fallbackText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf("\n\n");

      const data = extractEventData(chunk);
      if (!data) continue;

      let event: JsonRecord;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      }

      if (event.type === "response.output_item.done" && event.item?.type === "message") {
        const parts = Array.isArray(event.item?.content) ? event.item.content : [];
        const full = parts
          .filter((part: JsonRecord) => part.type === "output_text" && typeof part.text === "string")
          .map((part: JsonRecord) => part.text)
          .join("\n");
        if (full) fallbackText = full;
      }

      if (event.type === "error") {
        throw new Error(event.message || "Codex stream failed");
      }

      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message || "Codex response failed");
      }
    }
  }

  const finalText = (text || fallbackText || "").trim();
  if (!finalText) throw new Error("Codex returned an empty response");
  return finalText;
}

function pickOpenAiModel(requestedModel: string | undefined, piAi: JsonRecord) {
  const provider = "openai-codex";
  const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];

  if (!Array.isArray(models) || models.length === 0) {
    return { id: requestedModel || "gpt-5.4-mini", baseUrl: "https://chatgpt.com/backend-api" };
  }

  if (requestedModel) {
    const exact = models.find((model: JsonRecord) => model.id === requestedModel);
    if (exact) return exact;
    return { ...models[0], id: requestedModel };
  }

  for (const id of ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.1", "gpt-5.1-codex-mini"]) {
    const found = models.find((model: JsonRecord) => model.id === id);
    if (found) return found;
  }

  return models.find((model: JsonRecord) => /mini|spark|fast/i.test(model.id)) || models[0];
}

const openAiCodexAdapter: ProviderAdapter = {
  id: "openai-codex",
  displayName: "OpenAI Codex",

  async search(request, auth, authPath) {
    const piAi = await loadPiAi();
    const model = pickOpenAiModel(request.model, piAi);
    const { apiKey, accountId } = await resolveApiKey("openai-codex", auth, authPath, piAi);
    const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
    if (!tokenAccountId) {
      throw new Error("Could not determine ChatGPT account ID for openai-codex token.");
    }

    const body = {
      model: model.id,
      store: false,
      stream: true,
      instructions: buildSystemPrompt(),
      input: [{ role: "user", content: buildUserPrompt(request.query, request.purpose) }],
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    };

    const endpoint = resolveCodexUrl(model.baseUrl);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "chatgpt-account-id": tokenAccountId,
        "content-type": "application/json",
        accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        originator: "pi-native-web-search-extension",
      },
      body: JSON.stringify(body),
      signal: combineSignals(timeoutSignal(request.timeoutMs), request.signal),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Codex request failed (${res.status}): ${detail}`);
    }

    return {
      provider: "openai-codex",
      model: model.id,
      result: await collectCodexStreamText(res),
      details: { endpoint },
    };
  },
};

const adapters: Record<ProviderId, ProviderAdapter> = {
  "openai-codex": openAiCodexAdapter,
};

function pickProvider(requested: ProviderId | undefined, auth: JsonRecord): ProviderId {
  if (requested) return requested;
  if (auth?.["openai-codex"]) return "openai-codex";
  throw new Error("No OpenAI Codex credentials found. Run /login in pi, or pass provider once more providers are added.");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "native_web_search",
    label: "Native Web Search",
    description: "Run a fast provider model with native OpenAI web search enabled and return concise research with source URLs.",
    promptSnippet: "Run native OpenAI web search for current internet research with source URLs.",
    promptGuidelines: [
      "Use native_web_search when current internet information, recent releases, online documentation, prices, benchmarks, or external sources are needed.",
      "Do not use native_web_search for questions answerable from the local repository unless the user asks for external or current information.",
      "native_web_search returns concise findings with URLs; use those findings to answer the user and preserve important source URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The internet research question or search topic." }),
      purpose: Type.Optional(Type.String({ description: "Why this search is needed; helps tailor the summary." })),
      provider: Type.Optional(StringEnum(["openai-codex"] as const)),
      model: Type.Optional(Type.String({ description: "Optional OpenAI Codex model id to use for the research subcall." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds. Defaults to 120000.", minimum: 1000 })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const agentDir = getAgentDir();
      const authPath = join(agentDir, "auth.json");
      const auth = readJson(authPath, {});
      const provider = pickProvider(params.provider as ProviderId | undefined, auth);
      const adapter = adapters[provider];

      onUpdate?.({
        content: [{ type: "text", text: `Searching with ${adapter.displayName}: ${params.query}` }],
        details: { provider, query: params.query },
      });

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Search cancelled." }], details: { provider } };
      }

      const result = await adapter.search(
        {
          provider,
          model: params.model,
          query: params.query,
          purpose: params.purpose || "general research support",
          timeoutMs: Math.max(1000, Number(params.timeoutMs || 120_000)),
          signal,
        },
        auth,
        authPath,
      );

      return {
        content: [{ type: "text", text: result.result }],
        details: {
          provider: result.provider,
          model: result.model,
          query: params.query,
          purpose: params.purpose || "general research support",
          ...result.details,
        },
      };
    },
  });
}
