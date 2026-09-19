# OpenAI status

A Pi extension for the `openai-codex` provider. It adds a footer status such as:

```text
fast: on, 5h: 19% (resets in 03:12), 7d: 3% (resets in 06:15:54)
```

- The OpenAI status is right-aligned on the working-directory row rather than added as a third footer row.
- `fast: on` is yellow; off uses normal text.
- Usage comes from the same authenticated ChatGPT Codex usage endpoint as the Codex CLI.
- The status is hidden for every other provider.
- Reset countdowns refresh every minute. Usage follows Codex's own strategy: response-header updates when available plus adaptive polling every 60 seconds below 75% usage, 30 seconds at 75%, 15 seconds at 90%, and 5 seconds at 99%.

## Fast mode

Run:

```text
/openai-fast
```

The choice is global and persists in `~/.pi/agent/openai-status.json` (or Pi's configured agent directory). Fast mode adds `service_tier: "priority"` to OpenAI Codex requests. Turning it off stops the extension from adding that field.

Codex calls this Fast mode. Pi's OpenAI transport currently accounts for the priority tier at 2x cost for most models (2.5x for `gpt-5.5`). Actual latency improvement is service-dependent; the extension does not assume or display a fixed speed multiplier.

## Install

This repository can be loaded directly:

```bash
pi -e ./openai-status/index.ts
```

For automatic global loading, copy or symlink the directory to:

```text
~/.pi/agent/extensions/openai-status/
```

Then run `/reload` in Pi.

## Scope and authentication

The extension intentionally activates only when `ctx.model.provider === "openai-codex"`. A regular API-key-backed `openai` provider does not expose the ChatGPT subscription's 5-hour and 7-day quota windows.

It uses Pi's resolved OpenAI Codex OAuth token in memory and does not store or log credentials. If usage cannot be fetched, the last successful snapshot remains visible and polling retries quietly.

## Implementation provenance and debugging

The extension's OpenAI-specific behavior is derived from the open-source [OpenAI Codex CLI](https://github.com/openai/codex). In particular, the usage endpoint, authentication headers, rate-limit payload fields, reset timestamps, and Fast mode's `service_tier: "priority"` request value follow the Codex CLI implementation. These are implementation details rather than a stable public API and may change as Codex evolves.

When investigating a bug or reported incompatibility, do not debug this extension in isolation. Contributors and coding assistants should:

1. Inspect [`index.ts`](./index.ts) and reproduce the extension's behavior.
2. Clone or update the current Codex repository in a temporary directory, for example:

   ```bash
   git clone --depth=1 https://github.com/openai/codex.git /tmp/openai-codex
   ```

3. Compare the extension against the current Codex CLI source, especially its backend usage client, rate-limit types/parsing, authentication and account-routing headers, and service-tier/Fast mode handling.
4. Inspect the installed Pi extension and TUI APIs when the issue concerns provider context, request mutation, authentication resolution, lifecycle events, or footer rendering.
5. Fix and validate the extension against both implementations rather than guessing the backend contract.

Useful Codex source searches include `wham/usage`, `rate_limit`, `primary_window`, `secondary_window`, `ChatGPT-Account-Id`, `service_tier`, and `priority`.
