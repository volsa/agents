# Ghostty Notify

Sends a native Ghostty notification when Pi has fully settled and is waiting for input.

The extension always emits an OSC 777 notification. Ghostty decides whether to display it:

- The current Ghostty surface is focused: suppressed.
- Another split, tab, or Ghostty window is focused: displayed.
- Another application is focused: displayed.

This intentionally relies on Ghostty's surface-level focus handling rather than terminal focus-reporting sequences, which only describe application/window focus and cannot reliably distinguish splits.

## Requirements

- macOS
- Ghostty
- Pi running in interactive TUI mode
- Ghostty desktop notifications enabled (the default)

After installing or changing the extension, run `/reload` in Pi.
