# OpenRoly Roadmap

**Where this is going:** one agent account that any AI can run. One identity, one inbox, one body
of work, one memory, one set of rules — carried across Claude Code, Codex, Gemini CLI, Hermes, and
whatever comes next. You pick the engine for the moment; the agent stays the same.

The end goal goes one step further: an open account protocol, so your agent can outlive any single
product — including OpenRoly.

✅ works now · 🚧 in progress · ⏳ planned

A step counts as done only when you can see it working, not when the code merges. Every ✅ below
links to the code in this repository that does it, so you can check instead of trusting.
Features that live on the hosted server say *(hosted)*.

## The destination, in 60 seconds

1. You start an issue in **Claude Code**. It works as your agent, `@you`.
2. You kill it halfway. **Codex** picks up and says what changed: "these files, 32 of 34 tests pass,
   and here is what you told Claude last week."
3. You say "check CI every morning at 8". Tomorrow a **Hermes** run handles it, because that's the
   engine that's awake and allowed.
4. All three used the same permissions, the same memory, and the same history.

Steps 1 and 2 are the next two milestones. Step 3 comes with schedules.

## Milestones, in order

| | Milestone | What you'll notice |
|---|---|---|
| 🚧 | Open, verifiable releases | CI on every pull request, installs that match this repo's lockfile, signed build provenance on every binary |
| 🚧 | Linux sandbox | Incoming mail wakes your AI on Linux too, inside a locked-down sandbox |
| ⏳ | Self-hosting | Run the account server yourself |
| 🚧 | Pick up where you left off | Hit a usage limit and keep going without explaining again |
| ⏳ | Switch AI mid-task | Start in Claude, continue in Codex, in one step |
| ⏳ | Second opinion | A different AI reviews the work without seeing the first AI's opinion |
| ⏳ | A third engine | Hermes runs your agent next to Claude and Codex |
| ⏳ | Terminal UI | One screen for your job, your inbox, and what needs you |
| ⏳ | Shared memory and skills | What Claude learned today, Codex can use tomorrow |
| ⏳ | One set of rules | The same permissions for every AI; "ask me first" really waits for you |
| ⏳ | Public Beta | Your `@handle` is reserved for you |
| ⏳ | Schedules and chat apps | Recurring jobs pick the right AI; WhatsApp, Telegram, Discord, and Slack reach your agent |
| ⏳ | Requests from services | Apps and machines can ask your agent for things, with approval that expires |
| ⏳ | Many devices | Close your Mac and another device keeps the same job going; open it from two places and it never runs twice |
| ⏳ | Account protocol | Load your agent into another implementation and it's still `@you`, with its memory, skills, and history |

## By module

### 1. Identity and address

Your agent is `@you`, no matter which AI is running it.

| | What | Code |
|---|---|---|
| ✅ | One `@handle` for every connected AI: Claude Code, Codex, Gemini CLI, and API-key models | [`adapters/official`](adapters/official) |
| ✅ | Connect an AI with one command: `openroly pair <runtime>` | [`apps/cli`](apps/cli) |
| ⏳ | A handle always resolves to exactly one account, with strict name normalization | |
| ⏳ | Clear recovery: what you get back after losing a device, and what you don't | |
| ⏳ | Export your whole agent — identity, projects, memory, skills, relationships, policies, schedules, receipts — as one `.capsule` with no secret values in it, plus a count of the secrets you'd re-enter elsewhere | |
| ⏳ | Public Beta: your `@handle` reserved | |

### 2. Inbox and attention

Everything that wants your agent's attention lands in one place, sealed, and waits.

| | What | Code |
|---|---|---|
| ✅ | Mail to your agent's address, GitHub events, and webhooks arrive while your computer sleeps; the background service wakes a session when you're back *(hosted + broker)* | [`broker/src/triggers.rs`](broker/src/triggers.rs) |
| ✅ | Bodies sealed on arrival; the server keeps only sender, time, and source | [`packages/crypto-envelope`](packages/crypto-envelope), [`specs/e2ee-envelope-format.md`](specs/e2ee-envelope-format.md) |
| ✅ | Per-source AI visibility — full, masked, local models only, or none — set by telling your agent a rule | [`packages/mcp/src/schemas.ts`](packages/mcp/src/schemas.ts), [`packages/core/src/content.ts`](packages/core/src/content.ts) |
| ✅ | Triage: needs action, FYI, or discard | [`packages/core/src/content.ts`](packages/core/src/content.ts) |
| ⏳ | The "needs you" number counts what's unhandled, not just unread | |
| ⏳ | Quiet hours for notifications | |
| ⏳ | Every item shows which AI handled it | |
| ⏳ | Hand an incoming message to a running job: you always see it; the AI only gets it when you say so or the sender is one you trust | |
| ⏳ | An Android app that forwards phone notifications | |
| ⏳ | WhatsApp, Telegram, Discord, and Slack through an OpenClaw sidecar — no chat-app code inside OpenRoly | |

### 3. Work and handoff

The job outlives the session, the usage limit, and the AI that started it.

| | What | Code |
|---|---|---|
| ✅ | Jobs with one writer at a time; an AI holding an outdated lease can't overwrite newer work | [`packages/core/src/work.ts`](packages/core/src/work.ts) |
| ✅ | A checkpoint every 30 seconds of your code's state, dirty working tree included, without making commits | [`packages/mcp/src/checkpoint.ts`](packages/mcp/src/checkpoint.ts) |
| ✅ | Hand off with a brief: goal, next step, decisions, open questions, failed attempts, verified findings — values stay on your device | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_handoff`) |
| ✅ | Split a job into tasks for different AIs, with shared notes and task-to-task messages | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_team`, `work_message`) |
| ✅ | The next AI fetches only the notes it needs, within a token budget | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_context_search`) |
| ✅ | Facts recorded on their own — git state, files touched, tests run — with no LLM and without reading your conversation | [`packages/mcp/src`](packages/mcp/src) |
| ✅ | Only you can freeze a job; an AI can't take over work another AI holds | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_freeze`) |
| 🚧 | Pick up after a usage limit without explaining again | |
| ⏳ | Switch AI mid-task in one step (Claude → Codex): checkpoint, freeze, package, hand over, claim. If any step fails, the work stays ready — never lost | |
| ⏳ | Fork and review: a second AI reviews a read-only snapshot without being told the first AI's opinion | |
| ⏳ | Each task in its own git worktree, merged back only when it applies cleanly, never committed for you | |
| ⏳ | Task notes stay in the task until you publish them to the job; unread markers for task messages | |
| ⏳ | Codex's activity recorded automatically too | |
| ⏳ | Job notes follow you across devices, still sealed | |
| ⏳ | Closed questions stay closed, so an AI doesn't retry an idea that already failed | |
| ⏳ | Borrow another model's judgment at the risky moments (security, schema changes, the same failure twice) without leaving the job | |

### 4. Engines (runtimes)

Bring the AI you already pay for. OpenRoly starts it, fences it in, and brings the result home.

| | What | Code |
|---|---|---|
| ✅ | Claude Code, Codex, Gemini CLI, and API-key models | [`adapters/official`](adapters/official) |
| ✅ | A dedicated session woken when something arrives (macOS) | [`broker/src/launch.rs`](broker/src/launch.rs) |
| ✅ | A catalog entry per engine: how to start it headless and which hosts it may talk to | [`packages/core/registry`](packages/core/registry) |
| ✅ | MCP servers and skills you add to one AI are proposed for the others | [`packages/adapter/src/share.ts`](packages/adapter/src/share.ts) |
| 🚧 | Dedicated sessions on Linux | |
| ⏳ | Start engines through the Agent Client Protocol (ACP) | |
| ⏳ | Hermes as a third engine | |
| ⏳ | The background service on Windows | |
| ⏳ | Chat subscriptions (like ChatGPT) connected through a remote MCP endpoint — they can read and act, but can't be woken | |

### 5. Safety and authority

Incoming content is untrusted. Big moves need you.

| | What | Code |
|---|---|---|
| ✅ | An OS sandbox for woken sessions on macOS: writes only inside the job's folder, secret paths unreadable (`~/.ssh`, cloud credentials, GnuPG, keychains) | [`broker/src/sandbox.rs`](broker/src/sandbox.rs) |
| ✅ | Network limited to the engine's model provider and OpenRoly, through an egress proxy that denies everything else | [`broker/src/egress.rs`](broker/src/egress.rs) |
| ✅ | Each engine's own built-in tools switched off for the session that reads untrusted mail | [`broker/src/launch.rs`](broker/src/launch.rs) |
| ✅ | Fail closed: no sandbox, no automatic wake | [`broker/src/sandbox.rs`](broker/src/sandbox.rs) |
| ✅ | Outgoing actions can wait for your approval | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`approval_get`) |
| ✅ | `openroly-mask`: passwords, card numbers, and addresses blanked before any model sees them — no account needed | [`packages/mcp-mask`](packages/mcp-mask) |
| 🚧 | The same sandbox on Linux, and the sandbox's actual strength shown in `openroly doctor` | |
| ⏳ | One set of rules for every AI: allow, ask, or deny per action; "ask" holds the call until you decide | |
| ⏳ | Irreversible actions (send, merge, delete, pay) can never be set to "always allow"; approvals expire | |
| ⏳ | The engines' own permission prompts answered by the same rules | |
| ⏳ | Per-session limits on tool calls, outside actions, and run time that drop back to "ask" and can stop a session | |

### 6. Memory and skills

What one AI learns, every AI can use — and you decide what sticks.

| | What | Code |
|---|---|---|
| ✅ | Skills and MCP servers already travel between engines (see Engines) | [`packages/adapter/src/share.ts`](packages/adapter/src/share.ts) |
| ⏳ | Shared account memory: facts learned in one engine show up in the next, imported from each engine's own memory files | |
| ⏳ | You approve what gets remembered; every memory keeps where it came from; old facts are superseded, not silently deleted | |
| ⏳ | Memory search runs on your device — the server can't search your memory | |
| ⏳ | Anything from an unknown sender is never remembered automatically | |
| ⏳ | Skills in the shared `SKILL.md` format, with lint and a diff to review before you approve | |

### 7. Where you run it from

| | What | Code |
|---|---|---|
| ✅ | The `openroly` command | [`apps/cli`](apps/cli) |
| ✅ | A web app for your phone and for Windows, with push notifications *(hosted)* | |
| ⏳ | Every command answers in machine-readable JSON with stable exit codes | |
| ⏳ | A terminal UI that opens straight into your last job as a conversation | |
| ⏳ | One "needs you" number across terminal, web, and phone | |

### 8. Schedules and requests from machines

| | What | Code |
|---|---|---|
| ⏳ | Schedules belong to your account, written in plain words ("every morning at 8, check CI") | |
| ⏳ | At run time, OpenRoly picks an engine that's installed, awake, and allowed — and tells you why | |
| ⏳ | Apps and machines send requests to your address; approvals expire; results go back to the sender | |
| ⏳ | A tamper-evident log of what was requested and what was done | |

### 9. Open source and releases

| | What | Code |
|---|---|---|
| ✅ | Everything that runs on your machine is Apache-2.0: CLI, adapters, MCP server, background service, encryption | [`LICENSE`](LICENSE) |
| ✅ | Release binaries checked against `SHA256SUMS` by the installer and by every download `openroly` makes | [`packages/adapter/src/binary.ts`](packages/adapter/src/binary.ts) |
| 🚧 | CI on every pull request in this repository: typecheck, tests, and broker tests on macOS and Linux | |
| 🚧 | Installs that match this repository's lockfile exactly | |
| 🚧 | Build provenance attestations on release binaries | |
| ⏳ | The account server's source, and a way to run it yourself | |

### 10. Many devices

Start on your Mac, keep going on another machine — still one job, still `@you`.

| | What | Code |
|---|---|---|
| ⏳ | Close your Mac and another device's AI continues the same job as the same `@you` | |
| ⏳ | Open one job from two devices without it running twice: one device executes, the others watch, and you pick **Take over here** or **Fork here** | |
| ⏳ | Only structured state syncs (job manifests, events, snapshots), sealed so the server can't read it. Terminal output, secrets, keys, and repository files stay on the device; apps on the same device never go through the cloud | |
| ⏳ | Move a running job to another machine with the same AI: freeze, checkpoint, resume there | |
| ⏳ | Devices say what they can do — installed AIs, projects, remaining usage, local GPU — so coding goes to your MacBook's Codex and GPU work to your Linux box | |
| ⏳ | When a device disappears (lid closed), the job pauses or moves to another runner under your rules | |
| ⏳ | Skills that live on one device (like Xcode on your MacBook) are offered only while that device is online | |
| ⏳ | One owner per terminal session, with room for other terminal drivers to plug in | |

### 11. An account that outlives OpenRoly

The last step: your agent doesn't depend on this product either.

| | What | Code |
|---|---|---|
| ⏳ | Load a `.capsule` into another implementation — or another OpenRoly server — and the same `@handle` works, with its memory, skills, policies, relationships, schedules, and receipts; only the secrets to re-enter are listed | |
| ⏳ | A published Personal Agent Account Protocol — identity, memory, skills, capabilities, project state, encrypted messaging, receipts — with a conformance test that OpenRoly itself must pass in CI | [`specs`](specs) (today: the adapter contract and the envelope format) |
| ⏳ | Encrypted messages between accounts on different servers | |
| ⏳ | Proof by switching: move an agent from one agent OS to another and keep its identity, memory, contacts, skills, schedules, permissions, and work history | |

## What we won't build

Saying no keeps OpenRoly small enough to trust.

- **Our own agent loop.** Claude Code, Codex, Gemini CLI, and Hermes do the thinking and the tool
  calls. OpenRoly decides which one runs, with what authority, and brings the result back to your
  account.
- **Chat-app code in the core.** Webhooks and MCP are the way in.
- **More than one address.** You have one `@handle`. Senders don't need to know which job or which
  AI will handle their message.
- **Guessing what a message is about and pushing it into a job.** You, or a sender you trust, decide.
- **Chat rooms.**
- **A knowledge graph or home-made embeddings for memory.** Plain on-device full-text search first.
- **Commits made on your behalf.** Checkpoints and handoffs never write to your git history.
- **Terminal scrollback synced between devices.** Jobs move between devices; raw terminal output
  stays where it ran.

Something here doesn't match what the code does? That's a bug —
[open an issue](https://github.com/OpenRoly/openroly/issues/new?template=spec_mismatch.yml).
