# Tokens per second

Adds a dim statistics line below each completed model turn in Pi's transcript:

```text
3.1 tok/s, in 268, out 5, cache r/w 17,664/0, 1.6s
```

The timer starts immediately before Pi sends the provider request and ends when the assistant response is finalized. The resulting rate therefore includes network latency and time-to-first-token, rather than measuring decode speed alone.

- Each statistic is attached to its turn as a custom session entry.
- Entries persist with the session and reappear when the session is resumed.
- Statistics are not added to the model's context.
- A statistic is recorded after every completed model response, including responses around tool calls.
- Input, output, cache-read, and cache-write counts are the provider-reported values for that call.
- Cache reads and writes are always shown, including zero values.
- Failed and aborted calls do not produce a statistic.

## Install

Load the extension directly:

```bash
pi -e ./tokens-per-second/index.ts
```

For automatic global loading, copy or symlink the directory to:

```text
~/.pi/agent/extensions/tokens-per-second/
```

Then run `/reload` in Pi.
