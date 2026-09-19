#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://api.exa.ai/search";
const TYPES = new Set(["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"]);

const HELP = `Usage:
  exa-search.mjs [options] <query>
  exa-search.mjs --request-file <path|-> [--beta <flag>] [--timeout <seconds>]

Common options:
  --type <type>                 instant|fast|auto|deep-lite|deep|deep-reasoning
  -n, --num-results <1-100>     Number of results (default: Exa's default)
  --highlights                  Return query-relevant excerpts (recommended)
  --text                        Return full page text
  --text-max-chars <1-10000>    Limit full text per result (implies --text)
  --max-age-hours <-1..720>     -1 cache only; 0 fresh fetch; positive max cache age
  --include-domain <domain>     Repeatable hard allowlist
  --exclude-domain <domain>     Repeatable hard blocklist
  --start-published <ISO-8601>  Only results published after this date
  --end-published <ISO-8601>    Only results published before this date
  --category <category>         company|publication|news|personal site|financial report|people
  --location <CC>               Two-letter user country code
  --additional-query <query>    Repeatable; deep modes only (maximum 10)
  --system-prompt <text>        Guide source selection or synthesis behavior
  --output-text <description>   Ask Exa for a grounded synthesized text answer
  --output-schema <path>        Complete outputSchema JSON object
  --moderation                  Enable unsafe-content filtering
  --stream                      Stream synthesized output as SSE; requires outputSchema
  --beta <flag>                 Repeatable Exa-Beta header value
  --request-file <path|->       Complete Search API request JSON; '-' reads stdin
  --timeout <seconds>           Request timeout (default: 120)
  --compact                     Emit compact rather than pretty JSON
  -h, --help                    Show this help

EXA_API_KEY must be present in the environment.`;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function take(args, i, option) {
  if (i + 1 >= args.length) fail(`${option} requires a value`, 2);
  return args[i + 1];
}

function integer(value, option, min, max) {
  if (!/^-?\d+$/.test(value)) fail(`${option} must be an integer`, 2);
  const n = Number(value);
  if (n < min || n > max) fail(`${option} must be between ${min} and ${max}`, 2);
  return n;
}

function addList(body, field, value) {
  (body[field] ??= []).push(value);
}

export async function parseArgs(args, stdin = process.stdin) {
  const body = {};
  const config = { betas: [], timeout: 120, compact: false, requestFile: null };
  const queryParts = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      queryParts.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      queryParts.push(arg);
      continue;
    }
    switch (arg) {
      case "-h": case "--help": config.help = true; break;
      case "--compact": config.compact = true; break;
      case "--highlights": (body.contents ??= {}).highlights = true; break;
      case "--text": (body.contents ??= {}).text = true; break;
      case "--moderation": body.moderation = true; break;
      case "--stream": body.stream = true; break;
      case "--type": {
        const value = take(args, i++, arg);
        if (!TYPES.has(value)) fail(`unknown search type: ${value}`, 2);
        body.type = value;
        break;
      }
      case "-n": case "--num-results": body.numResults = integer(take(args, i++, arg), arg, 1, 100); break;
      case "--text-max-chars": {
        const value = integer(take(args, i++, arg), arg, 1, 10000);
        const contents = (body.contents ??= {});
        contents.text = typeof contents.text === "object" ? contents.text : {};
        contents.text.maxCharacters = value;
        break;
      }
      case "--max-age-hours": (body.contents ??= {}).maxAgeHours = integer(take(args, i++, arg), arg, -1, 720); break;
      case "--include-domain": addList(body, "includeDomains", take(args, i++, arg)); break;
      case "--exclude-domain": addList(body, "excludeDomains", take(args, i++, arg)); break;
      case "--start-published": body.startPublishedDate = take(args, i++, arg); break;
      case "--end-published": body.endPublishedDate = take(args, i++, arg); break;
      case "--category": body.category = take(args, i++, arg); break;
      case "--location": body.userLocation = take(args, i++, arg); break;
      case "--additional-query": addList(body, "additionalQueries", take(args, i++, arg)); break;
      case "--system-prompt": body.systemPrompt = take(args, i++, arg); break;
      case "--output-text": body.outputSchema = { type: "text", description: take(args, i++, arg) }; break;
      case "--output-schema": {
        const path = take(args, i++, arg);
        try { body.outputSchema = JSON.parse(await readFile(path, "utf8")); }
        catch (error) { fail(`cannot read output schema '${path}': ${error.message}`, 2); }
        break;
      }
      case "--beta": config.betas.push(take(args, i++, arg)); break;
      case "--request-file": config.requestFile = take(args, i++, arg); break;
      case "--timeout": {
        const value = Number(take(args, i++, arg));
        if (!Number.isFinite(value) || value <= 0) fail("--timeout must be a positive number", 2);
        config.timeout = value;
        break;
      }
      default: fail(`unknown option: ${arg}`, 2);
    }
  }

  if (config.help) return { body, config };
  if (config.requestFile) {
    if (queryParts.length || Object.keys(body).length) fail("--request-file cannot be combined with a query or request-building options", 2);
    let source;
    try {
      source = config.requestFile === "-" ? await readStream(stdin) : await readFile(config.requestFile, "utf8");
      Object.assign(body, JSON.parse(source));
    } catch (error) {
      fail(`cannot read request JSON: ${error.message}`, 2);
    }
  } else {
    if (!queryParts.length) fail("missing search query", 2);
    body.query = queryParts.join(" ");
  }
  if (body.additionalQueries?.length > 10) fail("at most 10 --additional-query values are allowed", 2);
  if (body.stream && !body.outputSchema) fail("--stream requires --output-text or --output-schema", 2);
  return { body, config };
}

async function readStream(stream) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

function redact(value, secret) {
  return secret ? String(value).split(secret).join("[REDACTED]") : String(value);
}

function errorDetail(status, payload) {
  const tag = payload?.tag;
  const apiMessage = payload?.error;
  let explanation;
  if (status === 401 || tag === "INVALID_API_KEY") {
    explanation = "EXA_API_KEY was rejected; it is invalid, expired, revoked, or no longer accepted. Create or rotate the key and update the environment.";
  } else if (status === 402 || ["NO_MORE_CREDITS", "API_KEY_BUDGET_EXCEEDED", "TEAM_BUDGET_EXCEEDED"].includes(tag)) {
    explanation = "Exa refused billing: the account has no available credits or an API-key/team budget was exceeded.";
  } else if (status === 429 || tag?.includes("RATE_LIMIT")) {
    explanation = "Exa rate-limited the request. Wait before trying again or reduce request frequency.";
  } else if (status === 400) {
    explanation = "Exa rejected the search request. Check the query, options, and JSON schema.";
  } else if (status === 403 || ["INSUFFICIENT_SCOPE", "TEAM_BLOCKED", "FEATURE_DISABLED"].includes(tag)) {
    explanation = "The key or team lacks access to this operation or feature.";
  } else if (status >= 500) {
    explanation = "Exa's service failed while processing the search; try again later.";
  } else {
    explanation = "Exa search failed.";
  }
  const details = [explanation, `HTTP ${status}`];
  if (tag) details.push(`tag ${tag}`);
  if (apiMessage) details.push(apiMessage);
  if (payload?.requestId) details.push(`request ${payload.requestId}`);
  return details.join("; ");
}

export async function search(body, config, env = process.env) {
  const key = env.EXA_API_KEY;
  if (!key) fail("Exa search failed: EXA_API_KEY is missing from the environment.");

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: body.stream ? "text/event-stream" : "application/json",
  };
  if (config.betas.length) headers["Exa-Beta"] = config.betas.join(",");

  let response;
  try {
    response = await fetch(env.EXA_API_URL || DEFAULT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeout * 1000),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      fail(`Exa search failed: request timed out after ${config.timeout} seconds.`);
    }
    fail(`Exa search failed: network, DNS, or TLS error: ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 500) || response.statusText }; }
    fail(`Exa search failed: ${redact(errorDetail(response.status, payload), key)}`);
  }

  if (body.stream) {
    if (!response.body) fail("Exa search failed: streaming response had no body.");
    for await (const chunk of response.body) process.stdout.write(chunk);
    return;
  }

  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { fail("Exa search failed: API returned malformed JSON."); }
  process.stdout.write(JSON.stringify(payload, null, config.compact ? 0 : 2) + "\n");
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { body, config } = await parseArgs(args);
    if (config.help) {
      process.stdout.write(HELP + "\n");
      return;
    }
    await search(body, config);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
