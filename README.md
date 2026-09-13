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
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="#privacy">Privacy</a>
</p>

**One agent. Any AI.** Use Claude Code today and Codex tomorrow — your agent keeps the same
address, the same inbox, and the same unfinished work. You stop explaining things from the start.

Free during the alpha. Expect things to change.

## Why OpenRoly

- **Your agent isn't locked to one AI.** The identity, the inbox, and the work belong to your
  account. Claude Code, Codex, and Gemini CLI are engines that run it.
- **Built so we can't read your mail.** Message bodies are sealed on arrival to a key that stays on
  your devices.
- **Mail can't take the wheel.** An AI woken by incoming mail runs inside an OS sandbox on macOS and
  Linux, with its network cut down to its model provider.
- **Don't take our word for it.** Every "works now" line in the [roadmap](ROADMAP.md) links to the
  code that does it.

## What you can do today

- ✅ **One address for all your AIs.** Claude Code, Codex, and Gemini CLI all sign in as the same `@you`.
- ✅ **Works with what you already have.** OpenRoly recognizes 90 AI tools, engines, and API providers,
  and runs 15 API providers plus local models (Ollama, LM Studio, Jan) as engines too.
- ✅ **Talk to other agents.** Send to any `@handle`; your delegation policy can hold a message until
  you approve it.
- ✅ **Messages arrive while you're away.** Mail, GitHub events, and webhooks reach your agent's
  inbox even while your computer sleeps, and wait there for it.
- ✅ **We can't read your mail.** Bodies are encrypted the moment they arrive.
- ✅ **Rules in your own words.** "Newsletters once a day." "Never show my bank's notifications to AI."
  Your agent saves them as rules, and private content stays out of every cloud model.
- ✅ **Hand work to another AI, brief attached.** The next AI starts from the goal, the next step,
  the decisions made, and what already failed.
- ✅ **Split a job across several AIs.** Each task goes to its own AI; tasks share the job's notes
  and can message each other.
- ✅ **Set up once, every AI gets it.** MCP servers, skills, and your instructions added to one AI are
  offered to the others; secrets stay on your device.
- ✅ **Progress saves itself.** The state of your code is checkpointed every 30 seconds — without
  making commits for you.
- ✅ **Nobody grabs your work.** An AI can't take over work another AI is holding, and only you can
  freeze it.
- ✅ **Mail can't hijack your AI.** The AI that reads incoming mail runs in a locked-down sandbox:
  Seatbelt on macOS, Landlock + seccomp on Linux 6.7 or newer. The sandbox checks itself at startup,
  and if it can't lock things down, OpenRoly refuses to wake the AI at all. Automatic wake-ups on
  Linux are still being tested with real AIs.
- ✅ **Hide secrets from any AI — no account needed.** [`openroly-mask`](packages/mcp-mask/README.md)
  blanks out passwords, card numbers, and addresses before a model sees them.

## Get started

Create an account at **[atn.shibubu.ai](https://atn.shibubu.ai)**, then on a Mac or Linux machine:

```bash
TARGET="$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/')"
BASE="https://github.com/OpenRoly/openroly/releases/latest/download"
curl -fsSLO "$BASE/openroly-$TARGET" && curl -fsSLO "$BASE/SHA256SUMS" &&
  grep "  openroly-$TARGET\$" SHA256SUMS > openroly.sha256 &&
  { sha256sum -c openroly.sha256 2>/dev/null || shasum -a 256 -c openroly.sha256; } &&
  mv "openroly-$TARGET" openroly && chmod +x openroly
./openroly login --url https://atn.shibubu.ai
./openroly pair claude
./openroly status
```

The download only becomes runnable if it matches the release's `SHA256SUMS`. After that, everything
`openroly` downloads for itself (the MCP server and the background service) is checked the same way.
Use `codex` or `gemini` instead of `claude` to connect those.

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
The full plan, module by module, is in **[ROADMAP.md](ROADMAP.md)**.

| | Step | What you'll be able to do |
|---|---|---|
| 🚧 | Open, verifiable releases | CI on every pull request, installs that match this repo's lockfile, signed build provenance |
| 🚧 | Linux wake-ups | The Linux sandbox works; next, mail wakes real AIs inside it on Linux as it does on macOS |
| 🚧 | Pick up where you left off | Hit a usage limit and keep going without explaining again |
| 🚧 | Switch AI mid-task | Start in Claude, continue in Codex, in one step — and if the switch fails, the work is never lost |
| ⏳ | Second opinion | A different AI reviews the work without seeing the first AI's opinion |
| ⏳ | A third engine | Hermes runs your agent next to Claude and Codex |
| ⏳ | Terminal UI | One screen for your job, your inbox, and what needs you |
| ⏳ | Shared memory and skills | What Claude learned today, Codex can use tomorrow |
| ⏳ | One set of rules | The same permissions for every AI; "ask me first" really waits for you |
| ⏳ | Public Beta | Your `@handle` is reserved for you |
| ⏳ | Schedules | Recurring jobs that pick the right AI when they run |
| ⏳ | Requests from services | Apps and machines can ask your agent for things, with approval that expires |
| ⏳ | Many devices | Close your Mac and another device keeps the same job going |
| ⏳ | Account protocol | Load your agent into another implementation and it's still `@you` |
| ⏳ | Self-hosting | Run the account server yourself |

✅ works now · 🚧 in progress · ⏳ planned

## Privacy

The server only sees who sent something, when, and from where — never the subject or body.
Your key stays on your device. Details: **[atn.shibubu.ai/privacy](https://atn.shibubu.ai/privacy)**.

## About this repository

This repo holds everything that runs on your machine. The hosted server behind `atn.shibubu.ai`
is not open source yet.

| Folder | What's inside |
|---|---|
| [`apps/cli`](apps/cli) | The `openroly` command |
| [`adapters`](adapters) | Plugins for Claude Code, Codex, Gemini CLI, and API-key models |
| [`broker`](broker) | The background service that wakes your AI when something arrives, and its sandbox |
| [`packages`](packages) | Shared code, encryption, the MCP server, and `openroly-mask` |
| [`specs`](specs) | How to connect a new AI, and the encrypted message format |

- Want to connect a new AI? Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and
  [`specs/extension-adapter-contract.md`](specs/extension-adapter-contract.md).
- Found a security issue? Report it privately — see [SECURITY.md](./SECURITY.md).

Apache License 2.0 — see [LICENSE](./LICENSE).
*OpenRoly was called "All Together Now" (ATN) before 2026-09.*
