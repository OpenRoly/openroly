---
name: follow
description: Watch the AI that has the Work, from inside Claude Code
argument-hint: (nothing - it follows the Work this session handed over)
allowed-tools: Bash(openroly:*)
---

Follow what the AI holding the current OpenRoly Work is doing.

<!-- openroly:preflight -->
Before the first step, and after every command below:

- `openroly: command not found` -> answer with this one line and stop: `OpenRoly isn't on your PATH - install it, then run 'openroly login'`
- the CLI says `not paired` / `human_only` / `Run 'openroly login' first` -> answer with this one line and stop: `Run 'openroly login' first`
- any other non-zero exit -> show the first line of its stderr unchanged and stop. Do not translate it, do not guess a cause, and never report a step you did not run.
<!-- /openroly:preflight -->

Steps:

1. Find the Work the same way `/openroly:give` does - `openroly work current --json` first, then
   `openroly work list --json` (`.data.works`, dropping every row whose `status` is `done`):
   - no rows -> answer exactly `Nothing to follow — start one with /openroly:start` and stop.
   - one row -> use it. More than one -> print the **titles** only, numbered, ask which one, stop
     until the person answers. Never show a Work id.
2. Run `openroly work get <id> --json`. Take the title, `.data.work.handled_runtime_id` as `<runtime>`,
   and treat the Work as live when `.data.work.lease_holder_run` is set and its lease has not expired.
3. Run `openroly peek --list` to find the newest session and whether it is `running`. If there is
   no session on this machine yet, say so in one line (`<runtime> hasn't been woken on this Mac yet`)
   and stop.
4. Run `openroly peek <session-id> --follow`, bounded to about 60 seconds. It tails the session
   until that session ends, so it will not return on its own while the AI is still working - let
   the bound end it, and read what it printed.
5. Fill the two counts from the Work itself, not from the tail:
   - changed files: `openroly work capsule show <id> --json` -> `.data.payload.git_state.dirty`
   - tests: `openroly work events <id> --json` -> the newest proof event's `passed` and `failed`
   Leave a line out when its source is missing. Do not estimate either number.
6. Answer with the summary only - never paste the raw terminal output you just read:

   ```
   <runtime> · <title> · <live or done>
   │ <one line on what it actually did, from the tool calls in the tail>
   │ Changed <n> files
   │ Tests <passed> / <passed + failed>
   Esc to stop following · <runtime> keeps working
   ```
