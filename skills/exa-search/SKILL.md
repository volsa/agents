---
name: exa-search
description: Search the web with Exa when current, external, or uncertain information would help; useful for coding research and general questions.
---

# Exa Search

Use this skill when current web information, external docs, source-backed clarification, recent releases, API behavior, bugs, pricing, benchmarks, or general factual lookup would improve the answer.

Prefer local repository inspection for questions answerable from workspace files. Do not search when the user asks not to.

## Command

Run the helper from this skill directory:

```bash
./exa-search.mjs "query" --purpose "why this search is needed"
```

Useful options:

```bash
./exa-search.mjs "query" --type auto --num 5
./exa-search.mjs "query" --fresh              # force livecrawl: contents.maxAgeHours=0
./exa-search.mjs "query" --text --max-chars 12000
./exa-search.mjs "query" --deep               # type=deep
./exa-search.mjs "query" --domains react.dev,nodejs.org
./exa-search.mjs "query" --category news
./exa-search.mjs "query" --json
```

## Defaults

- Default search type: `auto`.
- Default content mode: `contents.highlights: true`.
- Use `fast`/`instant` for latency-sensitive lookups.
- Use `deep-lite`, `deep`, or `deep-reasoning` for complex multi-source research or synthesis.
- Use `--text` only when full context is needed.
- Use `--fresh` only when cached content is unacceptable.

## Requirements

- Requires `EXA_API_KEY` in the environment. The helper tries `~/.zshrc` via `zsh` if the variable is missing.
- Uses Node.js with built-in `fetch` and ESM support.

## Workflow

1. Turn the need into a concise, source-seeking query.
2. Prefer official/primary sources for engineering questions; use `--domains` when useful.
3. Start with default `auto` + highlights; escalate only as needed.
4. Use the returned sources to answer; preserve important URLs.
5. If sources disagree, say so.
6. If search fails because `EXA_API_KEY` is missing or invalid, keep working without Exa; avoid further Exa calls for that task, and end the response with a bold notice that Exa search failed. Highlight message in bold style.

## Docs refresh

If Exa behavior may have changed, refresh docs as markdown:

```bash
curl -L -H "Accept: text/markdown" 'https://exa.ai/docs/reference/search-api-guide-for-coding-agents'
curl -L -H "Accept: text/markdown" 'https://exa.ai/docs/reference/search-best-practices'
curl -L -H "Accept: text/markdown" 'https://exa.ai/docs/llms.txt'
```

## Gotchas

- Nest `highlights`, `text`, and `summary` under `contents`.
- Do not use deprecated `useAutoprompt`, top-level `text`, or top-level `highlights`.
- Use `includeDomains` / `excludeDomains`, not URL filters.
