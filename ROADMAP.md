# OpenRoly Roadmap

**Where this is going:** one agent account that any AI can run. One identity, one inbox, one body
of work, one memory, one set of rules — carried across Claude Code, Codex, Gemini CLI, Hermes, and
whatever comes next. You pick the engine for the moment; the agent stays the same.

The end goal goes one step further: an open account protocol, so your agent can outlive any single
product — including OpenRoly.

✅ works now · 🚧 in progress · ⏳ planned

A step counts as done only when you can see it working, not when the code merges. Every ✅ below
links to the code in this repository that does it, so you can check instead of trusting.
Features that live on the hosted server say *(hosted)*. This page lists everything that is built
and everything that is planned — if something is missing here, it isn't on the plan.

## The destination, in 60 seconds

1. You start an issue in **Claude Code**. It works as your agent, `@you`.
2. You kill it halfway. **Codex** picks up and says what changed: "these files, 32 of 34 tests pass,
   and here is what you told Claude last week."
3. You say "check CI every morning at 8". Tomorrow a **Hermes** run handles it, because that's the
   engine that's awake and allowed.
4. All three used the same permissions, the same memory, and the same history.

Steps 1 and 2 are the next milestones. Step 3 comes with schedules.

## Milestones, in order

| | Milestone | What you'll notice |
|---|---|---|
| 🚧 | Open, verifiable releases | CI on every pull request, installs that match this repo's lockfile, signed build provenance on every binary |
| 🚧 | Linux wake-ups | The Linux sandbox works; next, incoming mail wakes real AIs inside it on Linux |
| ⏳ | Self-hosting | Run the account server yourself |
| 🚧 | Pick up where you left off | Hit a usage limit and keep going without explaining again |
| 🚧 | Switch AI mid-task | Start in Claude, continue in Codex, in one step |
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

1. [Identity and address](#1-identity-and-address)
2. [Inbox and attention](#2-inbox-and-attention)
3. [Work and handoff](#3-work-and-handoff)
4. [Engines](#4-engines)
5. [Safety and authority](#5-safety-and-authority)
6. [Memory](#6-memory)
7. [Skills, tools, and instructions](#7-skills-tools-and-instructions)
8. [Where you run it from](#8-where-you-run-it-from)
9. [Schedules and routing](#9-schedules-and-routing)
10. [Requests from machines and other agents](#10-requests-from-machines-and-other-agents)
11. [Many devices](#11-many-devices)
12. [An account that outlives OpenRoly](#12-an-account-that-outlives-openroly)
13. [Open source, releases, and reliability](#13-open-source-releases-and-reliability)

### 1. Identity and address

Your agent is `@you`, no matter which AI is running it.

| | What | Code |
|---|---|---|
| ✅ | One `@handle` for every connected AI: Claude Code, Codex, Gemini CLI, and API-key models | [`adapters/official`](adapters/official) |
| ✅ | Connect an AI with one command: `openroly pair <runtime>` or `openroly install <runtime>` | [`apps/cli`](apps/cli) |
| ✅ | Message other people's agents by `@handle`; your delegation policy can hold a message until you approve it | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`send`, `agents_list`) |
| ⏳ | A handle always resolves to exactly one account — never two servers answering the same name — with strict name normalization | |
| ⏳ | Clear recovery: what you get back after losing a device, and what you don't | |
| ⏳ | Export your whole agent — identity, projects, memory, skills, relationships, policies, schedules, receipts — as one `.capsule` with no secret values in it, plus a count of the secrets you'd re-enter elsewhere | |
| ⏳ | Public Beta: your `@handle` reserved | |

### 2. Inbox and attention

Everything that wants your agent's attention lands in one place, sealed, and waits.

| | What | Code |
|---|---|---|
| ✅ | Mail to your agent's address, GitHub events, and webhooks arrive while your computer sleeps; the background service wakes a session when you're back *(hosted + broker)* | [`broker/src/triggers.rs`](broker/src/triggers.rs) |
| ✅ | Bodies sealed on arrival; the server keeps only sender, time, and source | [`packages/crypto-envelope`](packages/crypto-envelope), [`specs/e2ee-envelope-format.md`](specs/e2ee-envelope-format.md) |
| ✅ | Rules in your own words — "newsletters once a day", "throw away build alerts", "never show my bank's notifications to AI": deliver now, daily digest, or discard, plus per-source AI visibility (full, masked, local models only, none) | [`packages/mcp/src/schemas.ts`](packages/mcp/src/schemas.ts) (`rules_put`) |
| ✅ | Triage: needs action, FYI, or discard | [`packages/core/src/content.ts`](packages/core/src/content.ts) |
| ⏳ | The "needs you" number counts what's unhandled, not just unread | |
| ⏳ | Quiet hours for notifications | |
| ⏳ | Every item shows which AI handled it, and who is working on it right now ("Codex is on it") | |
| ⏳ | The first line of each item is the AI's verdict on it | |
| ⏳ | "Sealed" split into precise, named guarantees, so you know exactly what each kind of item protects | |
| ⏳ | One generic way in for every service, GitHub included — adding a source needs no special code | |
| ⏳ | Items that already live in another app (GitHub, Slack, Calendar, Gmail) are referenced, not copied; your AI reads them through that app's MCP server | |
| ⏳ | Hand an incoming message to a running job: you always see it; the AI only gets it when you say so or the sender is one you trust | |
| ⏳ | One contact per person across mail, chat, and GitHub | |
| ⏳ | A trust level per source, with untrusted content read by an isolated reader | |
| ⏳ | Gmail push notifications instead of polling | |
| ⏳ | Progress replies to the sender: received → queued → running on Codex → waiting for approval → done | |
| ⏳ | Sensible group-chat behavior (respond only when mentioned) and one message format across channels | |
| ⏳ | An Android app that forwards phone notifications | |
| ⏳ | WhatsApp, Telegram, Discord, and Slack through an OpenClaw sidecar — no chat-app code inside OpenRoly | |
| ⏳ | Run a job from a chat app: approve, redirect, or stop it from the card you receive | |

### 3. Work and handoff

The job outlives the session, the usage limit, and the AI that started it.

| | What | Code |
|---|---|---|
| ✅ | Jobs with one writer at a time; an AI holding an outdated lease can't overwrite newer work | [`packages/core/src/work.ts`](packages/core/src/work.ts) |
| ✅ | Immutable snapshots of a job's state (goal, decisions, open questions, git state) — never the conversation itself | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_capsule`) |
| ✅ | A checkpoint every 30 seconds of your code's state, dirty working tree included, without making commits | [`packages/mcp/src/checkpoint.ts`](packages/mcp/src/checkpoint.ts) |
| ✅ | Hand off with a brief: goal, next step, decisions, open questions, failed attempts, verified findings — values stay on your device | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_handoff`) |
| ✅ | Split a job into tasks for different AIs, with shared notes and task-to-task messages | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_task_create`, `work_team`, `work_message`) |
| ✅ | The next AI fetches only the notes it needs, within a token budget | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_context_search`) |
| ✅ | Facts recorded on their own — git state, files touched, tests run — with no LLM and without reading your conversation | [`packages/mcp/src`](packages/mcp/src) |
| ✅ | Every AI starts from the same compact context package (under 1,000 tokens): who you are, your constraints, the current job | [`packages/core/src/context.ts`](packages/core/src/context.ts) (`openroly context show`) |
| ✅ | An event log and test results per job (`openroly work events`, `openroly work proof`) | [`apps/cli`](apps/cli) |
| ✅ | Only you can freeze a job; an AI can't take over work another AI holds | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`work_freeze`) |
| 🚧 | Pick up after a usage limit without explaining again | |
| 🚧 | Switch AI mid-task in one step (Claude → Codex): checkpoint, freeze, package, hand over, claim. If any step fails, the work stays ready — never lost | |
| 🚧 | See exactly what the model received in a session, masked the way the model saw it (`openroly peek`) | |
| ⏳ | Fork and review: a second AI reviews a read-only snapshot without being told the first AI's opinion | |
| ⏳ | Each task in its own git worktree, merged back only when it applies cleanly, never committed for you | |
| ⏳ | Finished tasks fold back into the parent job | |
| ⏳ | Task notes stay in the task until you publish them to the job; unread markers for task messages | |
| ⏳ | Codex's activity recorded automatically too | |
| ⏳ | Job notes follow you across devices, still sealed | |
| ⏳ | Versioned notes: each AI running in parallel knows what it has and hasn't been told, and gets only what changed | |
| ⏳ | Parallel AIs publish findings to the job — not broadcast to everyone — and the job settles them into verified, rejected, or still open | |
| ⏳ | Closed questions stay closed, so an AI doesn't retry an idea that already failed | |
| ⏳ | A check before risky actions that usually costs no extra model call | |
| ⏳ | Borrow another model's judgment at the risky moments (security, schema changes, the same failure twice) without leaving the job | |

### 4. Engines

Bring the AI you already pay for. OpenRoly starts it, fences it in, and brings the result home.

| | What | Code |
|---|---|---|
| ✅ | Claude Code, Codex, and Gemini CLI as full engines | [`adapters/official`](adapters/official) |
| ✅ | 15 API providers — OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Cerebras, Moonshot, Zhipu, DashScope, Perplexity — and local models through Ollama, LM Studio, and Jan (`openroly agent <provider>`) | [`adapters/official/api`](adapters/official/api), [`apps/cli`](apps/cli) |
| ✅ | Detects 90 AI tools and engines on your machine (`openroly runtimes`) | [`packages/core/registry`](packages/core/registry) |
| ✅ | A catalog entry per engine: how to start it headless and which hosts it may talk to | [`packages/core/registry`](packages/core/registry) |
| ✅ | A dedicated session woken when something arrives (macOS) | [`broker/src/launch.rs`](broker/src/launch.rs) |
| ✅ | Stop a live session and everything it started (`openroly cancel`) | [`broker/src/procgroup.rs`](broker/src/procgroup.rs) |
| ✅ | About 30 MCP tools for the AI: inbox, send and reply, contacts, rules, approvals, and jobs | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) |
| 🚧 | Dedicated sessions on Linux — the sandbox is in; waking real AIs inside it is being tested | |
| 🚧 | The same engine on a different provider, listed as its own profile (for example Claude Code on another API endpoint) | |
| ⏳ | Start engines through the Agent Client Protocol (ACP) | |
| ⏳ | Which engines can be stopped mid-action, measured per engine and shown honestly | |
| ⏳ | Apps you can connect but not wake (desktop apps) marked as such | |
| ⏳ | Separate catalogs for engines, providers, models, and capabilities | |
| ⏳ | A project passport (`.openroly/project.json`) that says what a project needs, so any engine can pick it up | |
| ⏳ | A portability check: `openroly project verify-portable` runs the same project on Claude, Codex, and Hermes | |
| ⏳ | Hermes as a third engine | |
| ⏳ | The background service on Windows, and no Bun required there | |
| ⏳ | Chat subscriptions (like ChatGPT) connected through a remote MCP endpoint — they can read and act, but can't be woken | |

### 5. Safety and authority

Incoming content is untrusted. Big moves need you.

| | What | Code |
|---|---|---|
| ✅ | An OS sandbox for woken sessions: writes only inside the job's folder, secret paths unreadable (`~/.ssh`, cloud credentials, GnuPG, keychains) | [`broker/src/sandbox.rs`](broker/src/sandbox.rs) |
| ✅ | The same walls on Linux 6.7+: Landlock for files and TCP ports, seccomp so only TCP sockets can be opened (no UDP, raw, or unix sockets), checked by a self-test at startup | [`broker/src/sandbox.rs`](broker/src/sandbox.rs) |
| ✅ | Network limited to the engine's model provider and OpenRoly, through an egress proxy that denies everything else | [`broker/src/egress.rs`](broker/src/egress.rs) |
| ✅ | Each engine's own built-in tools switched off for the session that reads untrusted mail | [`broker/src/launch.rs`](broker/src/launch.rs) |
| ✅ | Fail closed: no sandbox, no automatic wake | [`broker/src/sandbox.rs`](broker/src/sandbox.rs) |
| ✅ | Outgoing actions can wait for your approval | [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) (`approval_get`) |
| ✅ | `openroly-mask`: passwords, card numbers, and addresses blanked before any model sees them — no account needed | [`packages/mcp-mask`](packages/mcp-mask) |
| 🚧 | The network rule tied to the proxy itself, not just its port number, and the sandbox's actual strength shown in `openroly doctor` | |
| ⏳ | One set of rules for every AI: allow, ask, or deny per action; "ask" holds the call until you decide | |
| ⏳ | Irreversible actions (send, merge, delete, pay) can never be set to "always allow"; approvals expire | |
| ⏳ | The engines' own permission prompts answered by the same rules | |
| ⏳ | Per-session limits on tool calls, outside actions, and run time that drop back to "ask" and can stop a session | |
| ⏳ | Sending catches mistakes (wrong recipient, missing fields) instead of passing them through | |
| ⏳ | A stance per contact richer than on/off, including "deliver this person's messages to my AI automatically" | |
| ⏳ | Permissions travel with the job when it moves to another engine | |
| ⏳ | Permissions per project, and per contact within a project | |
| ⏳ | Permissions per device and per operator (read, write, approve) | |
| ⏳ | Signed delegation: you sign a grant, the account enforces it | |
| ⏳ | Plugin hooks before an engine starts, after it exits, and before a capability is used | |

### 6. Memory

What one AI learns, every AI can use — and you decide what sticks.

| | What | Code |
|---|---|---|
| ⏳ | Shared account memory: facts learned in one engine show up in the next, imported from each engine's own memory files | |
| ⏳ | You approve what gets remembered; every memory keeps where it came from; old facts are superseded, not silently deleted | |
| ⏳ | Memory search runs on your device — the server can't search your memory | |
| ⏳ | The right memories reach each AI through its context package, within budget | |
| ⏳ | Anything from an unknown sender is never remembered automatically, and memories are checked for injected instructions | |
| ⏳ | Memories tied to the code they describe, so they follow your git history | |
| ⏳ | What a job learned is merged into the account's memory when the work lands (for example at a pull request) | |
| ⏳ | Forgetting on purpose: duplicates merged, stale facts fade, frequently used ones stay | |

### 7. Skills, tools, and instructions

Set it up once; every AI gets the same kit.

| | What | Code |
|---|---|---|
| ✅ | MCP servers and skills you add to one AI are proposed to the account; approve once and every AI gets them (`openroly share`, `openroly sync`) | [`packages/adapter/src/share.ts`](packages/adapter/src/share.ts), [`packages/adapter/src/skill.ts`](packages/adapter/src/skill.ts) |
| ✅ | Your instructions kept in a managed block in each AI's own instruction file (`CLAUDE.md`, `AGENTS.md`, …) | [`packages/adapter/src/instructions.ts`](packages/adapter/src/instructions.ts) |
| ✅ | Secrets stay on your device: the account only ever sees environment variable names | [`packages/adapter/src/contract.ts`](packages/adapter/src/contract.ts) |
| ⏳ | Skills in the shared `SKILL.md` format with required capabilities, safety constraints, and provenance; lint and a diff to review before you approve | |
| ⏳ | A security check on skills, MCP servers, and plugins before they're handed to every AI | |

### 8. Where you run it from

| | What | Code |
|---|---|---|
| ✅ | The `openroly` command, with `status`, `doctor`, and `runtimes` | [`apps/cli`](apps/cli) |
| ✅ | A one-line status for your terminal or editor status bar (`openroly statusline`) | [`apps/cli`](apps/cli) |
| ✅ | A web app for your phone and for Windows, with push notifications *(hosted)* | |
| 🚧 | Machine-readable output: `--json` on status, doctor, runtimes, extensions, sync, share, work, and context today; stable exit codes for every command next | [`apps/cli`](apps/cli) |
| ⏳ | Account notifications reach your terminal too | |
| ⏳ | An export of what you allowed and what your agent did | |
| ⏳ | Notifications that fit where you are: a count in the terminal UI, a bell in a background tab, web push when no terminal is open | |
| ⏳ | Slash commands inside Claude Code | |
| ⏳ | One command set shared by the CLI, the terminal UI, and chat | |
| ⏳ | A local API and work protocol so other tools can drive your agent | |
| ⏳ | A terminal UI that opens straight into your last job as a conversation | |
| ⏳ | One "needs you" number across terminal, web, and phone | |
| ⏳ | A web screen for a job: its timeline, files, tests, and who's working on it | |
| ⏳ | The web app served locally (`openroly gui`) | |
| ⏳ | A phone view focused on approve, interrupt, assign, and status | |
| ⏳ | Compare two attempts side by side: files, tests, lines changed | |
| ⏳ | A command palette and pickers | |

### 9. Schedules and routing

| | What | Code |
|---|---|---|
| ⏳ | You choose when your agent wakes; by default it doesn't, and things wait for you | |
| ⏳ | Schedules belong to your account, written in plain words ("every morning at 8, check CI") | |
| ⏳ | At run time, OpenRoly picks an engine that's installed, awake, and allowed — and tells you why | |
| ⏳ | When an engine hits its limit, the job continues on the best available one automatically | |

### 10. Requests from machines and other agents

| | What | Code |
|---|---|---|
| ⏳ | Requests that expect an answer, with the result sent back to whoever asked | |
| ⏳ | Approvals that always expire, and that let you edit the request before approving | |
| ⏳ | A machine-readable intake form for your agent, and documentation for senders | |
| ⏳ | One entry point for other agent platforms (including a decision on the A2A protocol) | |
| ⏳ | A tamper-evident log of what was requested and what was done | |
| ⏳ | An address for each project, and requests from one project to another | |

### 11. Many devices

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

### 12. An account that outlives OpenRoly

The last step: your agent doesn't depend on this product either.

| | What | Code |
|---|---|---|
| ⏳ | Load a `.capsule` into another implementation — or another OpenRoly server — and the same `@handle` works, with its memory, skills, policies, relationships, schedules, and receipts; only the secrets to re-enter are listed | |
| ⏳ | A published Personal Agent Account Protocol — identity, memory, skills, capabilities, project state, encrypted messaging, receipts — with a conformance test that OpenRoly itself must pass in CI | [`specs`](specs) (today: the adapter contract and the envelope format) |
| ⏳ | Encrypted messages between accounts on different servers | |
| ⏳ | Proof by switching: move an agent from one agent OS to another and keep its identity, memory, contacts, skills, schedules, permissions, and work history | |

### 13. Open source, releases, and reliability

| | What | Code |
|---|---|---|
| ✅ | Everything that runs on your machine is Apache-2.0: CLI, adapters, MCP server, background service, encryption | [`LICENSE`](LICENSE) |
| ✅ | Release binaries checked against `SHA256SUMS` by the installer and by every download `openroly` makes | [`packages/adapter/src/binary.ts`](packages/adapter/src/binary.ts) |
| 🚧 | CI on every pull request in this repository: typecheck, tests, and broker tests on macOS and Linux | [`.github/workflows/public-ci.yml`](.github/workflows/public-ci.yml) |
| 🚧 | Installs that match this repository's lockfile exactly | |
| 🚧 | Build provenance attestations on release binaries | [`.github/workflows/release.yml`](.github/workflows/release.yml) |
| ⏳ | Restarts never lose work in flight | |
| ⏳ | `openroly doctor` checks your account, network, and engines live | |
| ⏳ | The account server's source, and a way to run it yourself | |

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
