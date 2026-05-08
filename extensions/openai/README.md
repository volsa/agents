# OpenAI extension

OpenAI subscription helpers for pi.

## Features

- `/fast` toggles OpenAI Fast mode on/off; Fast mode starts enabled by default.
- Fast mode only applies to `openai-codex` models authenticated through an OpenAI/ChatGPT subscription.
- When enabled, provider payloads get `service_tier: "priority"`.
- Compact footer shows `fast` / `slow` and usage limits such as `5h: 55% (~2h), 7d: 70% (~3d)` on the first footer line; only `fast` is highlighted white.
- OpenAI footer is hidden automatically when switching to non-OpenAI subscription providers.
- Usage limits refresh on OpenAI session/model activation and then every 5 completed agent turns.

## Reference

OpenAI/Codex harness behavior is tracked in the Codex repo:

https://github.com/openai/codex

If this extension needs updating, clone that repo with `--depth=1` into a temporary directory and inspect it as the source of truth for OpenAI-specific harness behavior.
