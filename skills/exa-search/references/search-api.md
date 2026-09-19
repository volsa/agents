# Exa Search CLI and request reference

Current endpoint: `POST https://api.exa.ai/search`. Canonical documentation: <https://exa.ai/docs/reference/search>.

## CLI options

Run `node scripts/exa-search.mjs --help` for the authoritative list. Common mappings are:

| CLI | Request field | Use when |
|---|---|---|
| `--type TYPE` | `type` | Select latency/research depth |
| `-n N` | `numResults` | Control breadth (1–100) |
| `--highlights` | `contents.highlights: true` | Default evidence view |
| `--text` | `contents.text: true` | Full-page context is needed |
| `--text-max-chars N` | `contents.text.maxCharacters` | Bound full text (1–10000) |
| `--max-age-hours N` | `contents.maxAgeHours` | Control cached-content freshness |
| `--include-domain D` | `includeDomains[]` | Hard source allowlist |
| `--exclude-domain D` | `excludeDomains[]` | Hard source blocklist |
| `--start-published DATE` | `startPublishedDate` | Publication lower bound |
| `--end-published DATE` | `endPublishedDate` | Publication upper bound |
| `--category C` | `category` | Focus company/publication/news/personal site/financial report/people |
| `--location CC` | `userLocation` | Localize with a two-letter country code |
| `--additional-query Q` | `additionalQueries[]` | Distinct starting directions for deep search |
| `--system-prompt P` | `systemPrompt` | Guide research/synthesis behavior |
| `--output-text D` | text `outputSchema` | Grounded prose synthesis |
| `--output-schema FILE` | `outputSchema` | Grounded structured synthesis |
| `--moderation` | `moderation: true` | Filter unsafe content |
| `--stream` | `stream: true` | SSE synthesis output |
| `--beta FLAG` | `Exa-Beta` header | Explicitly enable a documented beta |

`--request-file FILE` (or `-` for stdin) sends a complete request body and is the escape hatch for every API field. It cannot be combined with request-building flags.

## Complete request fields

The Search API currently accepts:

- Retrieval: `query`, `type`, `numResults`, `category`, `userLocation`, `moderation`, `compliance`
- Filters: `includeDomains`, `excludeDomains`, `startPublishedDate`, `endPublishedDate`
- Deep search: `additionalQueries`
- Result content under `contents`: `text`, `highlights`, `summary`, `extras`, `maxAgeHours`, `snapshotAsOf`, `subpages`, `subpageTarget`, plus deprecated compatibility fields
- Synthesis: `outputSchema`, `systemPrompt`, `stream`

Use request-file mode for advanced content objects such as highlight guidance, summary schemas, text rendering/sections, extras, snapshots, subpages, compliance, or beta features. It also keeps the CLI forward-compatible with newly added request fields.

Important constraints:

- `additionalQueries` supports at most 10 values and only deep search types.
- `company` and `people` do not support `startPublishedDate`, `endPublishedDate`, or `excludeDomains`.
- `stream` currently matters only with `outputSchema`.
- Dynamic Highlights requires its documented `Exa-Beta` header; beta names may change, so consult the canonical docs.
- Avoid deprecated crawl-date, context, and livecrawl fields in new requests.
- Search has no pagination.
