# OpenAI extension

OpenAI subscription helpers for pi.

## Features

- `/fast` toggles OpenAI Fast mode on/off; Fast mode starts enabled by default.
- Fast mode only applies to `openai-codex` models authenticated through an OpenAI/ChatGPT subscription.
- When enabled, provider payloads get `service_tier: "priority"`.
- Compact footer shows `fast` / `slow`, usage limits, and subscription time remaining, such as `5h: 55% (~2h), 7d: 70% (~3d), expires in ~12d`, on the first footer line; only `fast` is highlighted white.
- Subscription expiration comes primarily from the entitlement returned by ChatGPT's undocumented `/backend-api/accounts/check/v4-2023-04-27` endpoint, with `/backend-api/subscriptions` as a fallback. If both requests fail or neither response has a recognized expiration timestamp, the footer shows `expiration API failed` in red.
- OpenAI footer is hidden automatically when switching to non-OpenAI subscription providers.
- Usage limits and subscription expiration refresh on OpenAI session/model activation and asynchronously whenever the user submits a message, without delaying agent processing.

## Reference

OpenAI/Codex harness behavior is tracked in the Codex repo:

https://github.com/openai/codex

If this extension needs updating, clone that repo with `--depth=1` into a temporary directory and inspect it as the source of truth for OpenAI-specific harness behavior.
