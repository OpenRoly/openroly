---
name: give
description: Hand the Work this session is on to another AI - without typing an id
argument-hint: which AI takes over (e.g. codex)
allowed-tools: Bash(openroly:*)
---

Hand the current OpenRoly Work over to: $ARGUMENTS

<!-- openroly:preflight -->
Before the first step, and after every command below:

- `openroly: command not found` -> answer with this one line and stop: `OpenRoly isn't on your PATH - install it, then run 'openroly login'`
- the CLI says `not paired` / `human_only` / `Run 'openroly login' first` -> answer with this one line and stop: `Run 'openroly login' first`
- any other non-zero exit -> show the first line of its stderr unchanged and stop. Do not translate it, do not guess a cause, and never report a step you did not run.
<!-- /openroly:preflight -->

Steps:

1. `<runtime>` is `$ARGUMENTS`, trimmed. If it is empty, ask exactly `どの AI に渡しますか` and stop.
2. Run `openroly runtimes --json`. If `.data.runtimes` has no row whose `id` is `<runtime>` with
   `connected` true, answer with this one line and stop, having run no transfer:

   `<runtime> isn't connected — connect it with 'openroly connect <runtime>'`

   Never say a Work was handed over when it was not.
3. Find the Work without making the person type an id:
   - Run `openroly work current --json`. If `.data.work_id` is there, that is the Work.
   - Otherwise run `openroly work list --json` and use `.data.works`, dropping every row whose
     `status` is `done` (`--json` hands over the finished ones too, which the printed list hides).
     - no rows -> answer exactly `Nothing to give — start one with /openroly:start` and stop.
     - one row -> use it.
     - more than one -> print the **titles** only, numbered, in `work list` order, ask which one,
       and stop until the person answers. Never show a Work id in any of this.
4. Run `openroly work transfer <id> --to <runtime> --json`. Use the CLI, not the MCP tool: this
   terminal's credential is the person's, and a handover needs it.
5. If it stopped because the handover still needs the person (the reason names an explicit user
   intent / a confirmation), answer with this one line and stop - the Work has not moved yet:

   `Asked you to confirm on phone and web`

   Do not print the took-over lines below until a later run sees the transfer routed.
6. Run `openroly work context <id> --json`. In `.data.entries`, count the rows whose `kind` is
   `context` for each of the six well-known keys - `goal`, `next_step`, `decisions`,
   `open_questions`, `failed_attempts`, `verified_findings` - counting a row whose `key` is the
   key itself or starts with `<key>/`. Leave out a key with no rows; never write `0 decisions`, because that
   reads as "it will not travel" when it means "nothing was written". Read no values: the brief's
   contents live on this machine, and this line carries headings and counts only.
7. Answer with exactly these three lines:

   ```
   <runtime> took over <title>
   ⎿ brief: <the counted keys, joined with ·, or "nothing saved yet">
   ⎿ This session can still read the work. Changes now go through <runtime>.
   ```
