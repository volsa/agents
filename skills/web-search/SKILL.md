---
name: web-search
description: Run native OpenAI Codex web search from Pi credentials for current internet research, recent releases, online documentation, prices, benchmarks, or external sources.
---

# Web Search

Use this skill when the user needs current internet information, recent releases, online documentation, prices, benchmarks, or other external/current facts.

Prefer local repository inspection for questions answerable from files in the workspace. Do not use web search for purely local code questions unless the user asks for external/current information.

## Command

Run the helper from this skill directory:

```bash
./web-search.mjs "query" --purpose "why this search is needed"
```

Useful options:

```bash
./web-search.mjs --query "query" --purpose "reason"
./web-search.mjs "query" --model gpt-5.4-mini
./web-search.mjs "query" --timeout-ms 120000
./web-search.mjs "query" --json
```

## Requirements

- Requires OpenAI Codex credentials in Pi auth; run `/login` in Pi first.
- Reads credentials from `$PI_CODING_AGENT_DIR/auth.json`, or `~/.pi/agent/auth.json` by default.
- Uses Node.js with built-in `fetch`, `AbortSignal.timeout`, and ESM support.

## Workflow

1. Convert the user's need into a concise search query.
2. Include `--purpose` to tailor the results to the task.
3. Run `./web-search.mjs` with the query and purpose.
4. Use the returned findings to answer the user.
5. Preserve important source URLs from the search output in the final answer.
6. If sources disagree, call that out.

## Examples

```bash
./web-search.mjs "latest stable Node.js release and LTS schedule" --purpose "confirm supported runtime versions"
./web-search.mjs "OpenAI Responses API web_search tool documentation" --purpose "verify current API parameters"
```
