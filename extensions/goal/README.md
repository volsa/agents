# Goal Extension

A Pi extension that ports the core Codex `/goal` behavior:

- `/goal` shows the current goal
- `/goal <objective>` creates/replaces an active long-running goal
- `/goal pause`, `/goal resume`, `/goal clear`
- model tools: `get_goal`, `create_goal`, `update_goal`
- branch-scoped persistence via Pi custom session entries
- active goal status in the footer
- automatic hidden continuation turns while a goal remains active
- token/time accounting and budget-limit steering

State is stored in the Pi session log as custom entries with `customType: "goal-state"`; no SQLite database is used.
