<p align="center">
  <img src="docs/logo/mascot-cutout-280.png" width="140" alt="OpenRoly mascot">
</p>

<h1 align="center">OpenRoly</h1>

<p align="center"><em>Your work outlives the context.</em></p>

<p align="center"><strong>Start with Claude. Finish with another AI. Never explain the task twice.</strong></p>

<p align="center">
  <img src="docs/demo/w1-continue.gif" width="720" alt="Claude Code stops at a usage limit, openroly continue hands the job to OpenCode, and OpenCode finishes the same job">
  <br><sub>The usage limit in this recording is triggered by running Claude Code's limit hook with the same input Claude Code gives it, not by a real limit. The seconds on screen are real; the recording skips the waiting.</sub>
</p>

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

**Your agent is not your model.** MCP made tools portable. A2A made agent communication portable.
OpenRoly makes the agent itself portable.

Start a job in Claude Code; when Claude stops, OpenCode can continue it — your agent keeps the same
address, the same inbox, and the same unfinished work. You stop explaining things from the start. Codex next.

Expect things to change.

## Why OpenRoly

- **Your agent isn't locked to one AI.** The identity, the inbox, and the work belong to your
  account. Claude Code, Codex, and OpenCode are engines that run it.
- **Built so we can't read your mail.** Message bodies are sealed on arrival to a key that stays on
  your devices.
- **Mail can't take the wheel.** An AI woken by incoming mail runs inside an OS sandbox on macOS and
  Linux, with its network cut down to its model provider.
- **Don't take our word for it.** Every "works now" line in the [roadmap](ROADMAP.md) links to the
  code that does it.

## Me, Work, Place

OpenRoly asks you to learn three things, and nothing more until you need it.

| | What it is | Example |
|---|---|---|
| **Me** | Your agent — yours, whichever AI is running it | `@alice` |
| **Work** | A job in progress. It outlives sessions, usage limits, and the AI that started it | *Fix duplicate charge* |
| **Place** | Where a job belongs | *Personal* |

**You keep your agent. A job stays with whoever owns its place. The AI doing the work can change at any time.**
Today every place is *Personal*. Recording each job's owner separately from your agent comes next, so shared
places can arrive later without moving your work — and an AI working in one place is never handed another place's notes.

## What you can do today

- ✅ **One address for all your AIs.** Claude Code and Codex both sign in as the same `@you`.
- ✅ **Works with what you already have.** OpenRoly recognizes 91 AI tools, engines, and API providers,
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
Use `codex` instead of `claude` to connect Codex.

Already inside Claude Code or Codex? Add the plugin (you still need `login` and `pair` above):

```bash
claude plugin marketplace add OpenRoly/openroly
```

```bash
codex plugin marketplace add OpenRoly/openroly
```

**Windows / iPhone / Android:** use the web app at [atn.shibubu.ai](https://atn.shibubu.ai).
Connecting an AI still needs a Mac or Linux machine.

## PAAP Continuity Benchmark

When one AI hands an unfinished job to another, does the next AI start the right next step without anyone
explaining the job again? Each run is judged only by what the next AI does — its tool calls, and the tests run
after it stops — not by what it says. For comparison, the same job is also handed over as a summary the first AI
writes, and as the first AI's full transcript.

<!-- paap-continuity-benchmark:start -->

| Metric | PAAP handoff | Summary by the source AI | Full transcript | Measured on |
|---|---|---|---|---|
| Continuation success | 93.3% (95% 78.7–98.2% · n=30) | 73.3% (95% 55.6–85.8% · n=30) | 93.3% (95% 78.7–98.2% · n=30) | measured pairs: Claude Code → OpenCode · one medium task |
| Median time to useful work | 21.1s (p90 24.8s · n=28) | 15.6s (p90 31.8s · n=22) | 42.8s (p90 53.7s · n=28) | measured pairs: Claude Code → OpenCode · one medium task |
| Human re-explanation | 0.0% (95% 0.0–27.8% · n=10) | 0.0% (95% 0.0–27.8% · n=10) | 0.0% (95% 0.0–27.8% · n=10) | measured pairs: Claude Code → OpenCode · one medium task · a scripted person: a nudge, then the task restated |
| State loss | 0.0% (95% 0.0–11.4% · n=30) | 100.0% (95% 88.6–100.0% · n=30 · lost: work id 30, checkpoint id 30) | 100.0% (95% 88.6–100.0% · n=30 · lost: work id 30, checkpoint id 30) | measured pairs: Claude Code → OpenCode · one medium task |
| Recovery after failed handoff | 🚧 | 🚧 | 🚧 | measured pairs: none · we can no longer check which judge produced the last run, so its number is not published until it is measured again |
| Final task success | 86.7% (95% 70.3–94.7% · n=30) | 66.7% (95% 48.8–80.8% · n=30) | 93.3% (95% 78.7–98.2% · n=30) | measured pairs: Claude Code → OpenCode · one medium task |
| Session cut off | 30.0% (95% 10.8–60.3% · n=10 · woken once more 3/10, finished after the rewake 3/3) | 🚧 | 🚧 | measured pairs: Claude Code → OpenCode · one medium task · measured on the runs that had a scripted person standing by |
| Cost per finished job | 46.1k tokens + 477.0k cached · 60.7 credits (n=26 · 4 unfinished runs also spent) | 63.4k tokens + 490.8k cached · 70.2 credits (n=20 · 10 unfinished runs also spent) | 53.5k tokens + 560.6k cached · 70.9 credits (n=28 · 2 unfinished runs also spent) | measured pairs: Claude Code → OpenCode · one medium task · everything the measured runs spent, over the runs that finished |

Runs measured 2026-09-15 to 2026-09-16 at `b4cae9e`, `7a7623b` (some runs not recorded); judged with the code at `2d7cf64`; recovery measured 2026-09-16 at `3809332`. Not measured yet: OpenCode → Claude Code, Claude Code → Codex, Codex → Claude Code, Claude Code → openai-compatible endpoint (Z.AI stand-in), Claude Code → Gemini, a summary written by a person. 🚧 = not measured.
Rates leave out runs whose tool calls could not be recorded. Definitions: [specs/paap/benchmark.md](specs/paap/benchmark.md).

<!-- paap-continuity-benchmark:end -->

The "engineering smoke benchmark" lines under [Coming next](#coming-next) are an earlier, simpler check: the
handoff reached the other AI and it acted on the checkpoint.

## Coming next

In order. Each step counts as done only when you can actually see it working.
The full plan, module by module, is in **[ROADMAP.md](ROADMAP.md)**.

| | Step | What you'll be able to do |
|---|---|---|
| 🚧 | Open, verifiable releases | CI on every pull request, installs that match this repo's lockfile, signed build provenance |
| 🚧 | Linux wake-ups | The Linux sandbox works; next, mail wakes real AIs inside it on Linux as it does on macOS |
| ✅ | Pick up where you left off | Hit a usage limit and keep going in another session — engineering smoke benchmark (the handoff reached the other AI and it acted on the checkpoint): 3 of 3 live runs, picked up in 14.1s (median), no handoff left the work without an owner |
| ✅ | Switch AI mid-task | Start in Claude, continue in OpenCode, in one step — engineering smoke benchmark (the handoff reached the other AI and it acted on the checkpoint): 6 of 6 live runs, picked up in 13.1s (median), no handoff left the work without an owner. Codex next |
| ⏳ | Shared memory and skills | What Claude learned today, another AI can use tomorrow |
| ✅ | Account protocol v0.1 | Identity, work, checkpoints, and handoffs as an open spec ([`specs/paap/`](specs/paap/)), read by two small independent implementations and checked on every push |
| ⏳ | Add your AI | A small engine interface, and a guide to connect a new AI in about 30 minutes |
| ⏳ | Self-hosting | Run the account server yourself |
| ⏳ | Second opinion | A different AI reviews the work without seeing the first AI's opinion |
| ⏳ | Places | Every job records who it belongs to — *Personal* today — and an AI working in one place never gets another place's notes |
| ⏳ | One set of rules | The same permissions for every AI; "ask me first" really waits for you |
| ⏳ | Public Beta | Your `@handle` is reserved for you |
| ⏳ | Share a job by link | Send a read-only snapshot to someone without an account; the server still can't read it |
| ⏳ | Schedules | Recurring jobs that pick the right AI when they run |
| ⏳ | Requests from services | Apps and machines can ask your agent for things, with approval that expires |
| ⏳ | Terminal UI | One screen for your job, your inbox, and what needs you |
| ⏳ | Many devices | Close your Mac and another device keeps the same job going |

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
| [`adapters`](adapters) | Plugins for Claude Code, Codex, and API-key models |
| [`broker`](broker) | The background service that wakes your AI when something arrives, and its sandbox |
| [`packages`](packages) | Shared code, encryption, the MCP server, and `openroly-mask` |
| [`specs`](specs) | How to connect a new AI, and the encrypted message format |

- Want to connect a new AI? Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and
  [`specs/extension-adapter-contract.md`](specs/extension-adapter-contract.md).
- Found a security issue? Report it privately — see [SECURITY.md](./SECURITY.md).

Apache License 2.0 — see [LICENSE](./LICENSE).
*OpenRoly was called "All Together Now" (ATN) before 2026-09.*
