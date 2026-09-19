---
name: exa-search
description: Search the live web with Exa and return ranked sources, relevant excerpts, full text, or grounded synthesized answers. Use for current facts, web research, documentation, news, papers, companies, and people.
compatibility: Requires Node.js 18+ and EXA_API_KEY in the environment.
---

# Exa Search

Run commands from this skill's directory. The CLI prints JSON to stdout and actionable failures to stderr.

```bash
node scripts/exa-search.mjs --highlights "natural-language query"
```

## Choose options

Start with `--highlights`: it returns query-relevant evidence with low context usage.

- Search mode: omit `--type`/use `auto` normally; `fast` for interactive latency; `instant` for autocomplete/voice; `deep-lite` for brief research; `deep` for iterative multi-source research; `deep-reasoning` only when difficult conflicting evidence needs extra reasoning.
- Content: use `--highlights` normally. Use `--text --text-max-chars N` only when broader page context is necessary. Do not request both unless both views are genuinely needed.
- Scope: `-n N` controls result count. Add repeatable `--include-domain`/`--exclude-domain` only for hard constraints. Use `--start-published`/`--end-published` for publication windows, not page freshness.
- Freshness: `--max-age-hours 0` forces fresh page content, `-1` uses cache only, and a positive value accepts cache up to that age.
- Deep: repeat `--additional-query` only for distinct subtopics and only with a deep mode.
- Synthesis: `--output-text "format instructions"` requests a grounded prose answer. For structured output, put the complete Exa `outputSchema` in a file and use `--output-schema FILE`; prefer `--type deep` for complex/multi-item output.
- `--system-prompt` guides source preferences, novelty, or deduplication; it does not replace the search query.
- Use `--stream` only with an output schema when incremental SSE output is useful.

Examples:

```bash
node scripts/exa-search.mjs --type fast -n 5 --highlights "latest Node.js security releases"
node scripts/exa-search.mjs --type deep --highlights \
  --additional-query "vendor documentation" --additional-query "independent benchmarks" \
  "compare current vector databases for hybrid retrieval"
node scripts/exa-search.mjs --type deep --output-text "Answer in five bullets with key disagreements" \
  "How do recent studies assess AI coding assistant productivity?"
node scripts/exa-search.mjs --include-domain docs.exa.ai --text --text-max-chars 8000 \
  "Search API outputSchema documentation"
```

For uncommon Search API fields, write a complete request JSON and run:

```bash
node scripts/exa-search.mjs --request-file request.json
# or: printf '%s' "$json" | node scripts/exa-search.mjs --request-file -
```

This passthrough supports every field accepted by `POST /search`. See [the option reference](references/search-api.md) before using uncommon fields. Never expose `EXA_API_KEY` or place it in arguments/files.

If the command fails, report its error explicitly. Do not claim a search succeeded and do not silently switch to another source. A missing environment key, rejected/invalid key, exhausted credits, budget limit, bad request, rate limit, service error, timeout, and network failure are distinguished by the CLI.
