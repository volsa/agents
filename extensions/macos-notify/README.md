# macOS Notify

Sends a native macOS notification when Pi finishes an agent turn while the terminal is unfocused.

- Enables terminal focus reporting for Pi UI sessions on macOS.
- Debounces notifications to avoid spam.
- Uses OSC 777 notifications where supported, with AppleScript fallback.
- Configure sound with `PI_MACOS_NOTIFY_SOUND` (default: `Glass`, use `none` to disable).
- Force transport with `PI_MACOS_NOTIFY_TRANSPORT=osc777` or `osascript`.
