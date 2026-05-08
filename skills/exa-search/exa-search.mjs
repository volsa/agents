#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const ENDPOINT = "https://api.exa.ai/search";
const DEFAULT_TIMEOUT_MS = 60_000;

function usage(exitCode = 0) {
  const out = `Usage:
  ./exa-search.mjs "query" [options]
  ./exa-search.mjs --query "query" [options]

Options:
  -q, --query <text>          Search query
  -p, --purpose <text>        Why this search is needed
      --type <type>           auto|fast|instant|deep-lite|deep|deep-reasoning (default: auto)
      --deep                  Shortcut for --type deep
  -n, --num <count>           Number of results, 1-100 (default: 10)
      --text                  Return full text instead of highlights
      --max-chars <count>     Max chars per result when using --text (default: 12000)
      --fresh                 Force livecrawl: contents.maxAgeHours=0
      --cache-only            Never livecrawl: contents.maxAgeHours=-1
      --domains <csv>         Include only these domains
      --include-domains <csv> Include only these domains
      --exclude-domains <csv> Exclude these domains
      --category <category>   company|people|research paper|news|personal site|financial report
      --timeout-ms <ms>       Request timeout (default: 60000)
      --json                  Emit raw JSON response
  -h, --help                  Show this help

Examples:
  ./exa-search.mjs "React 19 useActionState official docs" --domains react.dev
  ./exa-search.mjs "latest Node.js LTS release" --fresh --num 5
  ./exa-search.mjs "compare current hosted vector databases" --deep
`;
  (exitCode === 0 ? console.log : console.error)(out.trimEnd());
  process.exit(exitCode);
}

function readValue(argv, i, name) {
  if (i + 1 >= argv.length) throw new Error(`Missing value for ${name}`);
  return argv[i + 1];
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage(0);
    else if (arg === "-q" || arg === "--query") args.query = readValue(argv, i++, arg);
    else if (arg === "-p" || arg === "--purpose") args.purpose = readValue(argv, i++, arg);
    else if (arg === "--type") args.type = readValue(argv, i++, arg);
    else if (arg === "--deep") args.type = "deep";
    else if (arg === "-n" || arg === "--num") args.numResults = Number(readValue(argv, i++, arg));
    else if (arg === "--text") args.text = true;
    else if (arg === "--max-chars") args.maxCharacters = Number(readValue(argv, i++, arg));
    else if (arg === "--fresh") args.maxAgeHours = 0;
    else if (arg === "--cache-only") args.maxAgeHours = -1;
    else if (arg === "--domains" || arg === "--include-domains") args.includeDomains = csv(readValue(argv, i++, arg));
    else if (arg === "--exclude-domains") args.excludeDomains = csv(readValue(argv, i++, arg));
    else if (arg === "--category") args.category = readValue(argv, i++, arg);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(readValue(argv, i++, arg));
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else args.positional.push(arg);
  }

  if (!args.query && args.positional.length) args.query = args.positional.join(" ");
  if (!args.query) throw new Error("Missing query. Pass a positional query or --query.");

  args.type ||= "auto";
  args.numResults ||= 10;
  args.maxCharacters ||= 12_000;
  args.timeoutMs ||= DEFAULT_TIMEOUT_MS;
  args.purpose ||= "web research support";

  const types = new Set(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"]);
  if (!types.has(args.type)) throw new Error(`Invalid --type: ${args.type}`);
  if (!Number.isInteger(args.numResults) || args.numResults < 1 || args.numResults > 100) throw new Error("--num must be an integer from 1 to 100");
  if (!Number.isInteger(args.maxCharacters) || args.maxCharacters < 1) throw new Error("--max-chars must be a positive integer");
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000) throw new Error("--timeout-ms must be an integer >= 1000");
  return args;
}

function getApiKey() {
  if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
  try {
    const key = execFileSync("zsh", ["-lc", "source ~/.zshrc >/dev/null 2>&1 || true; print -r -- $EXA_API_KEY"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (key) return key;
  } catch {}
  throw new Error("EXA_API_KEY is not set. Export it or add it to ~/.zshrc.");
}

function buildPayload(args) {
  const contents = args.text
    ? { text: { maxCharacters: args.maxCharacters } }
    : { highlights: true };

  if (args.maxAgeHours !== undefined) contents.maxAgeHours = args.maxAgeHours;

  const payload = {
    query: args.query,
    type: args.type,
    numResults: args.numResults,
    contents,
  };

  if (args.includeDomains?.length) payload.includeDomains = args.includeDomains;
  if (args.excludeDomains?.length) payload.excludeDomains = args.excludeDomains;
  if (args.category) payload.category = args.category;
  return payload;
}

function trim(s, max = 1200) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatMarkdown(data, args) {
  const lines = [];
  lines.push(`# Exa search results`);
  lines.push("");
  lines.push(`Query: ${args.query}`);
  lines.push(`Purpose: ${args.purpose}`);
  if (data.requestId) lines.push(`Request ID: ${data.requestId}`);
  if (data.costDollars?.total !== undefined) lines.push(`Cost: $${data.costDollars.total}`);
  lines.push("");

  if (data.output?.content) {
    lines.push(`## Synthesized output`);
    lines.push("");
    lines.push(typeof data.output.content === "string" ? data.output.content : JSON.stringify(data.output.content, null, 2));
    lines.push("");
  }

  const results = Array.isArray(data.results) ? data.results : [];
  lines.push(`## Results (${results.length})`);
  for (const [idx, r] of results.entries()) {
    lines.push("");
    lines.push(`### ${idx + 1}. ${r.title || "Untitled"}`);
    lines.push(r.url || r.id || "");
    if (r.publishedDate) lines.push(`Published: ${r.publishedDate}`);
    if (r.author) lines.push(`Author: ${r.author}`);

    if (Array.isArray(r.highlights) && r.highlights.length) {
      lines.push("");
      for (const h of r.highlights.slice(0, 5)) lines.push(`- ${trim(h, 900)}`);
    } else if (r.text) {
      lines.push("");
      lines.push(trim(r.text, 1800));
    } else if (r.summary) {
      lines.push("");
      lines.push(trim(r.summary, 1200));
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = getApiKey();
  const payload = buildPayload(args);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Exa returned non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    const msg = data.error || data.message || JSON.stringify(data);
    throw new Error(`Exa request failed (${res.status}): ${msg}`);
  }

  if (args.json) console.log(JSON.stringify(data, null, 2));
  else console.log(formatMarkdown(data, args));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
