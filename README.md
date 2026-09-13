<p align="center">
  <img src="docs/logo/mascot-cutout-280.png" width="140" alt="OpenRoly mascot">
</p>

<h1 align="center">OpenRoly</h1>

<p align="center"><em>Your work outlives the context.</em></p>

<p align="center">
  <a href="https://github.com/OpenRoly/openroly/releases/latest"><img src="https://img.shields.io/github/v/release/OpenRoly/openroly" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/status-public%20alpha-FCBDD0" alt="Status: Public Alpha">
</p>

<p align="center">
  <a href="https://atn.shibubu.ai">Website</a> ·
  <a href="#what-you-can-do-today">What works</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#coming-next">Roadmap</a> ·
  <a href="#privacy">Privacy</a>
</p>

Use Claude Code today, Codex tomorrow — your AI assistant keeps the same address, the same inbox,
and the same unfinished work. You never have to explain things again from the start.

Free during the alpha. Expect things to change.

![Your Mac is asleep and mail still lands at your agent's address; Claude attaches and triages, the bank mail stays sealed; you say "handle this"; the runtime switches to Codex mid-task and the agent doesn't change](docs/hero.gif)

## What you can do today

- ✅ **One address for all your AIs.** Claude Code, Codex, and Gemini CLI all sign in as the same `@you`.
- ✅ **Messages arrive while you're away.** Mail, GitHub, and webhooks reach your agent even while your computer sleeps.
- ✅ **We can't read your mail.** Messages are locked the moment they arrive. Private ones (like bank mail) stay hidden from every AI.
- ✅ **Pass work to another AI without re-explaining.** The next AI starts with the goal, the next step, the decisions made, and what already failed.
- ✅ **Split a project across several AIs.** Each gets its own task, and they can message each other.
- ✅ **Progress is saved on its own.** Your code changes are checkpointed every 30 seconds, without making commits for you.
- ✅ **Big moves need your OK.** An AI can't stop or take over work on its own.
- ✅ **Mail can't hijack your AI.** The AI that reads incoming mail runs in a locked-down sandbox.
- ✅ **Hide secrets from any AI — no account needed.** [`openroly-mask`](packages/mcp-mask/README.md) blanks out passwords, card numbers, and addresses before a model sees them.

## Get started

Create an account at **[atn.shibubu.ai](https://atn.shibubu.ai)**, then on a Mac or Linux machine:

```bash
TARGET="$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/')"
curl -fsSL "https://github.com/OpenRoly/openroly/releases/latest/download/openroly-$TARGET" -o openroly
chmod +x openroly
./openroly login --url https://atn.shibubu.ai
./openroly pair claude
./openroly status
```

Use `codex` or `gemini` instead of `claude` to connect those. Everything downloaded is checked
against the release's `SHA256SUMS` first.

Already inside Claude Code or Codex? Add the plugin (you still need `login` and `pair` above):

```bash
claude plugin marketplace add OpenRoly/openroly
```

```bash
codex plugin marketplace add OpenRoly/openroly
```

**Windows / iPhone / Android:** use the web app at [atn.shibubu.ai](https://atn.shibubu.ai).
Connecting an AI still needs a Mac or Linux machine.

## Coming next

In order. Each step counts as done only when you can actually see it working.

| | Step | What you'll be able to do |
|---|---|---|
| 🚧 | Reliable releases | Every update goes live safely with one click |
| 🚧 | Pick up where you left off | Hit a usage limit and keep going without explaining again |
| ⏳ | Switch AI mid-task | Start in Claude, continue in Codex, in one step |
| ⏳ | Second opinion | A different AI reviews the work without seeing the first AI's opinion |
| ⏳ | Many AIs, one job | Claude, Codex, and Hermes working on the same account |
| ⏳ | Dashboard | See in one screen what's waiting for you |
| ⏳ | Shared memory and skills | What Claude learned today, Codex can use tomorrow |
| ⏳ | One set of rules | The same permissions for every AI; "ask me first" really waits for you |
| ⏳ | Public Beta | Your `@handle` is reserved for you |
| ⏳ | Schedules | Recurring jobs that pick the right AI when they run |
| ⏳ | Requests from services | Apps and machines can ask your agent for things, with approval that expires |

✅ works now · 🚧 in progress · ⏳ planned

## Privacy

The server only sees who sent something, when, and from where — never the subject or body.
Your key stays on your device. Details: **[atn.shibubu.ai/privacy](https://atn.shibubu.ai/privacy)**.

## About this repository

This repo holds everything that runs on your machine. The hosted server behind `atn.shibubu.ai`
is not open source.

| Folder | What's inside |
|---|---|
| [`apps/cli`](apps/cli) | The `openroly` command |
| [`adapters`](adapters) | Plugins for Claude Code, Codex, Gemini CLI, and API-key models |
| [`broker`](broker) | The background service that wakes your AI when something arrives |
| [`packages`](packages) | Shared code, encryption, the MCP server, and `openroly-mask` |
| [`specs`](specs) | How to connect a new AI, and the encrypted message format |

- Want to connect a new AI? Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and
  [`specs/runtime-adapter-contract.md`](specs/runtime-adapter-contract.md).
- Found a security issue? Report it privately — see [SECURITY.md](./SECURITY.md).
- Develop: `bun install && bun run check`. Rust for `broker/`.

Apache License 2.0 — see [LICENSE](./LICENSE).
*OpenRoly was called "All Together Now" (ATN) before 2026-09.*
