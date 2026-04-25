---
name: commit
description: Generate and create a conventional commit from staged git changes, warning about unstaged changes while never staging files automatically.
---

Create a git commit for the user's already-staged changes using a conventional commit message.

Commit message format:

```text
<type>: <title>

<summary with more details>
```

Rules:

- Never stage files yourself. Do not run `git add`, `git restore --staged`, or any command that changes what is staged.
- Only commit changes that are already staged by the user.
- If there are no staged changes, stop and ask the user to stage the files they want to commit, then invoke this skill again.
- If there are unstaged or untracked files, explicitly warn the user that those files are not staged and will not be included in the commit.
- Do not ask for confirmation before committing. Generate the message, run the commit, then report what was committed.
- Do not modify the working tree except by running `git commit` for the staged changes.
- Base the commit message on staged changes, not unstaged changes.

Workflow:

1. Inspect repository state:

   ```bash
   git status --short
   git diff --cached --stat
   git diff --cached
   ```

2. Determine whether staged changes exist.
   - If `git diff --cached --quiet` indicates no staged changes, stop and ask the user to stage changes manually.
   - If unstaged or untracked files exist, warn the user before committing.

3. Infer the conventional commit type from the staged changes.

   Common types:

   - `feat`: user-facing or API-facing new functionality
   - `fix`: bug fix
   - `docs`: documentation-only changes
   - `style`: formatting-only changes with no behavior change
   - `refactor`: code restructuring without intended behavior change
   - `perf`: performance improvement
   - `test`: adding or updating tests
   - `build`: build system, dependency, packaging, or lockfile changes
   - `ci`: continuous integration configuration changes
   - `chore`: maintenance, tooling, cleanup, or repository housekeeping
   - `revert`: reverting a previous change

4. Write a concise title:
   - Less than 72 characters total, including the `<type>: ` prefix.
   - Imperative or concise descriptive style.
   - No trailing period.

5. Write a short summary body:
   - Explain the important staged changes in one or more sentences.
   - Mention notable behavior, files, modules, or user-visible effects when useful.
   - Do not include unstaged changes in the summary.

6. Commit immediately using the generated message:

   ```bash
   git commit -m "<type>: <title>" -m "<summary with more details>"
   ```

7. After committing, report the result to the user:

   ```text
   Committed staged changes with the following message:

   <type>: <title>

   <summary with more details>
   ```

If the staged diff is very large, use the available `git diff --cached --stat` and representative diff hunks to produce the best accurate message. If the staged changes appear to contain multiple unrelated changes, still create a single best-fit conventional commit message for the staged set, but mention in the final response that the commit contained multiple areas of work.
