---
name: start
description: Start an OpenRoly Work from this terminal and put this session on it
argument-hint: what this work is, in one line
allowed-tools: Bash(openroly:*)
---

Start an OpenRoly Work for: $ARGUMENTS

<!-- openroly:preflight -->
Before the first step, and after every command below:

- `openroly: command not found` -> answer with this one line and stop: `OpenRoly isn't on your PATH - install it, then run 'openroly login'`
- the CLI says `not paired` / `human_only` / `Run 'openroly login' first` -> answer with this one line and stop: `Run 'openroly login' first`
- any other non-zero exit -> show the first line of its stderr unchanged and stop. Do not translate it, do not guess a cause, and never report a step you did not run.
<!-- /openroly:preflight -->

Steps:

1. If `$ARGUMENTS` is empty or only whitespace, start nothing. Ask exactly `何をする Work か 1 行で` and stop.
2. Run `openroly work start "<title>" --json`, with the person's own words as the title.
   Use the CLI, not an MCP tool: only a person can start a Work, and the credential
   `openroly login` left in this terminal is the person's own (an MCP call is the runtime's
   and comes back 403 human_only).
3. Read `.data.work.id` from that JSON, then run `openroly work handoff <id> --to claude --json`
   so this session is the one on it. `/openroly:give` reads exactly this later.
4. Run `openroly work get <id> --json` and read `.data.work.place`.
5. Answer with this one line and nothing else:

   `New Work — <title> in <place> · Claude is on it`

   `<title>` is `.data.work.title`, `<place>` is `.data.work.place` (`Personal` when it is your own account).
   Do not print the Work id, and do not add a summary, a next step or an offer.
