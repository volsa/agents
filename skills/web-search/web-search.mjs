#!/usr/bin/env node
/*
 * Native web search helper for Pi skills.
 * Uses OpenAI Codex credentials from Pi auth.json and the Codex Responses API
 * with the native web_search tool enabled.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_TIMEOUT_MS = 120_000;

function usage(exitCode = 0) {
  const out = `Usage:
  ./web-search.mjs "query" [options]
  ./web-search.mjs --query "query" [options]

Options:
  -q, --query <text>        Internet research question or search topic
  -p, --purpose <text>      Why this search is needed (default: general research support)
      --provider <id>       Provider id (default: openai-codex)
  -m, --model <id>          Optional OpenAI Codex model id
      --timeout-ms <ms>     Request timeout in milliseconds (default: 120000)
      --json                Emit JSON with provider/model/result/details
  -h, --help                Show this help

Examples:
  ./web-search.mjs "latest Node.js LTS release" --purpose "verify current version"
  ./web-search.mjs --query "Pi coding agent skills docs" --model gpt-5.4-mini
`;
  (exitCode === 0 ? console.log : console.error)(out.trimEnd());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === "-h" || arg === "--help") usage(0);
    else if (arg === "-q" || arg === "--query") args.query = next();
    else if (arg === "-p" || arg === "--purpose") args.purpose = next();
    else if (arg === "--provider") args.provider = next();
    else if (arg === "-m" || arg === "--model") args.model = next();
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else args.positional.push(arg);
  }

  if (!args.query && args.positional.length) args.query = args.positional.join(" ");
  if (!args.query) throw new Error("Missing query. Pass a positional query or --query.");
  args.purpose ||= "general research support";
  args.provider ||= DEFAULT_PROVIDER;
  args.timeoutMs = Math.max(1000, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS));
  if (!Number.isFinite(args.timeoutMs)) throw new Error("--timeout-ms must be a number");
  return args;
}

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfigValue(config) {
  if (typeof config !== "string" || !config) return undefined;
  if (config.startsWith("!")) {
    try {
      return execSync(config.slice(1), {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return process.env[config] || config;
}

function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured;
}

function decodeJwtAccountId(jwt) {
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

function parseExpiryTimestamp(expires) {
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

function getCachedOAuthAccess(entry, now = Date.now()) {
  if (!entry || typeof entry !== "object") return undefined;
  const apiKey = resolveConfigValue(entry.access);
  if (!apiKey) return undefined;
  const expiresAt = parseExpiryTimestamp(entry.expires);
  if (!expiresAt || now + 30_000 >= expiresAt) return undefined;
  return { apiKey, accountId: entry.accountId };
}

function tryImport(specifier) {
  return import(specifier).catch(() => undefined);
}

async function importFromGlobalPackage(specifier) {
  let root;
  try {
    root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
  try {
    return await import(require.resolve(specifier, { paths: [root] }));
  } catch {
    return undefined;
  }
}

async function loadPiAi() {
  return (await tryImport("@mariozechner/pi-ai")) || (await importFromGlobalPackage("@mariozechner/pi-ai")) || {};
}

async function loadOAuthHelper(piAi) {
  if (typeof piAi?.getOAuthApiKey === "function") return piAi.getOAuthApiKey.bind(piAi);
  const oauth = (await tryImport("@mariozechner/pi-ai/oauth")) || (await importFromGlobalPackage("@mariozechner/pi-ai/oauth"));
  if (typeof oauth?.getOAuthApiKey === "function") return oauth.getOAuthApiKey.bind(oauth);
  return undefined;
}

async function resolveApiKey(provider, auth, authPath, piAi) {
  const entry = auth?.[provider];
  if (!entry) throw new Error(`No credentials for provider '${provider}' in ${authPath}. Run /login in pi first.`);

  const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);
  if (inferredType === "api_key") {
    const key = resolveConfigValue(entry.key);
    if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
    return { apiKey: key, accountId: entry.accountId };
  }
  if (inferredType !== "oauth") throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);

  const fallbackToken = getCachedOAuthAccess(entry);
  const getOAuthApiKey = await loadOAuthHelper(piAi);
  if (typeof getOAuthApiKey !== "function") {
    if (fallbackToken) return fallbackToken;
    throw new Error("Could not load @mariozechner/pi-ai OAuth helper, and cached OAuth token is missing or expired.");
  }

  const oauthCreds = {};
  for (const [key, value] of Object.entries(auth || {})) {
    if (value && (value.type === "oauth" || (value.access && value.refresh && value.expires))) oauthCreds[key] = value;
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

function buildUserPrompt(query, purpose) {
  return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
  const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function extractEventData(chunk) {
  const payload = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

async function collectCodexStreamText(res) {
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

      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
      if (event.type === "response.output_item.done" && event.item?.type === "message") {
        const parts = Array.isArray(event.item?.content) ? event.item.content : [];
        const full = parts
          .filter((part) => part.type === "output_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        if (full) fallbackText = full;
      }
      if (event.type === "error") throw new Error(event.message || "Codex stream failed");
      if (event.type === "response.failed") throw new Error(event.response?.error?.message || "Codex response failed");
    }
  }

  const finalText = (text || fallbackText || "").trim();
  if (!finalText) throw new Error("Codex returned an empty response");
  return finalText;
}

function pickOpenAiModel(requestedModel, piAi) {
  const models = typeof piAi.getModels === "function" ? piAi.getModels(DEFAULT_PROVIDER) : [];
  if (!Array.isArray(models) || models.length === 0) return { id: requestedModel || "gpt-5.4-mini", baseUrl: "https://chatgpt.com/backend-api" };
  if (requestedModel) {
    const exact = models.find((model) => model.id === requestedModel);
    if (exact) return exact;
    return { ...models[0], id: requestedModel };
  }
  for (const id of ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.1", "gpt-5.1-codex-mini"]) {
    const found = models.find((model) => model.id === id);
    if (found) return found;
  }
  return models.find((model) => /mini|spark|fast/i.test(model.id)) || models[0];
}

function pickProvider(requested, auth) {
  if (requested && requested !== DEFAULT_PROVIDER) throw new Error(`Unsupported provider '${requested}'. Supported providers: ${DEFAULT_PROVIDER}`);
  if (requested) return requested;
  if (auth?.[DEFAULT_PROVIDER]) return DEFAULT_PROVIDER;
  throw new Error("No OpenAI Codex credentials found. Run /login in pi.");
}

async function search(args) {
  const agentDir = getAgentDir();
  const authPath = join(agentDir, "auth.json");
  const auth = readJson(authPath, {});
  const provider = pickProvider(args.provider, auth);
  const piAi = await loadPiAi();
  const model = pickOpenAiModel(args.model, piAi);
  const { apiKey, accountId } = await resolveApiKey(provider, auth, authPath, piAi);
  const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
  if (!tokenAccountId) throw new Error("Could not determine ChatGPT account ID for openai-codex token.");

  const endpoint = resolveCodexUrl(model.baseUrl);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "chatgpt-account-id": tokenAccountId,
      "content-type": "application/json",
      accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi-native-web-search-skill",
    },
    body: JSON.stringify({
      model: model.id,
      store: false,
      stream: true,
      instructions: "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).",
      input: [{ role: "user", content: buildUserPrompt(args.query, args.purpose) }],
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  if (!res.ok) throw new Error(`Codex request failed (${res.status}): ${await res.text()}`);
  return { provider, model: model.id, result: await collectCodexStreamText(res), details: { endpoint, query: args.query, purpose: args.purpose } };
}

try {
  const args = parseArgs(process.argv.slice(2));
  console.error(`Searching with OpenAI Codex: ${args.query}`);
  const result = await search(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.result);
} catch (err) {
  console.error(`web-search: ${err?.message || err}`);
  process.exit(1);
}
