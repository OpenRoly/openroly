# OpenRoly

*Your work outlives the context.*

One account — `@you` — that Claude Code, Codex, and Gemini CLI attach to. Swap the runtime and
the identity, the inbox, the permissions, and the work in progress stay where they are.

**Status: Public Alpha / experimental.** APIs, wire formats, and adapter contracts here are
expected to change. This repository is the SDK / CLI / runtime-adapter / device-broker side of
OpenRoly; the Hosted Account Network (identity registry, encrypted mailbox storage, abuse/ops)
is not part of this repository and is not open source.

![Your Mac is asleep and mail still lands at your agent's address; Claude attaches and triages, the bank mail stays sealed; you say "handle this"; the runtime switches to Codex mid-task and the agent doesn't change](docs/hero.gif)

## One agent. Any runtime. Always reachable.

Your agent is an account, not a process. Three things follow from that:

1. **Neutral** — switch the runtime and the agent doesn't change. Claude Code and Codex attach
   to the same `@handle`, the same inbox, the same contacts and permissions. Each runtime keeps
   its own context and memory, but the work carries over: hand a chat to Codex mid-task and it
   reads the thread and continues in the same place.
2. **Sealed across vendors** — the server stores envelopes it can't open, and private items
   (a bank mail, say) stay sealed from every cloud AI, whichever one you attach. Masking is a
   property of the account, not a setting in each app.
3. **Reachable while you're off** — mail, GitHub, and webhooks land at your agent's address
   even while your Mac sleeps; the policy follows the agent, not the runtime. When a machine
   wakes, the paired runtime picks the item up in a sandboxed session.

Works from any OS (macOS / Linux / Windows / iPhone / Android) because the address is mail and
webhooks, not an OS notification hook. The hosted instance is
**[https://atn.shibubu.ai](https://atn.shibubu.ai)** — signup is open and everything is $0
during the alpha.

## What's proven so far

Claims are cheap; this is what has tests or a live round-trip behind it:

- **Two independent runtimes, same identity, same inbox.** Claude Code and Codex attach to the
  same `@handle` via the adapters in this repo and read/write the same mailbox
  (`adapters/official/claude`, `adapters/official/codex`; Gemini CLI and generic API-key
  providers ship in the same tree).
- **Mail round-trip, sealed on arrival.** A mail sent to `you@atn.shibubu.ai` from an ordinary
  mail app is sealed to your device keys the moment it arrives; the server keeps the sender, the
  time, and the source kind in the clear and nothing of the subject or body.
- **GitHub as a source.** `POST /v1/inbound/github/:source` verifies `X-Hub-Signature-256`
  (HMAC-SHA256, constant-time) and turns `issues`, `issue_comment`, `pull_request`,
  `pull_request_review`, failed `check_run` / `workflow_run`, and `release` into items. Green CI
  is deliberately not an item. Redeliveries dedupe on `X-GitHub-Delivery`.
- **The runtime that reads an item is contained.** A mail body is attacker input. The dedicated
  session that handles an incoming item gets a scoped token and no shell it didn't ask for, on
  all three official runtimes; the broker's tests include the prompt-injection cases that used
  to work.
- **Masking works in front of any MCP server, with no account at all.**
  `packages/mcp-mask` is a standalone stdio proxy that masks credentials, addresses, phone and
  card numbers before they reach the model, and restores them only when the model echoes the
  placeholder back into a tool call.

## Quickstart

No JavaScript runtime, no Rust toolchain, no repo clone required — the CLI and the background
broker it installs are both prebuilt binaries from this repo's
[Releases](https://github.com/OpenRoly/openroly/releases). Everything `openroly` fetches
afterwards (the broker, the MCP server) is checked against the Release's `SHA256SUMS` before it
is placed or run:

```bash
TARGET="$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/')"
curl -fsSL "https://github.com/OpenRoly/openroly/releases/latest/download/openroly-$TARGET" -o openroly
chmod +x openroly
./openroly login --url https://atn.shibubu.ai
./openroly pair claude
./openroly status
```

`TARGET` resolves to `darwin-arm64` (Apple Silicon), `darwin-x64` (Intel Mac), or `linux-x64`.
`login` connects this machine: it fetches the broker binary, checks it against the Release's
`SHA256SUMS`, starts it, and on macOS registers a launchd agent so it survives reboots.
`pair` attaches a runtime — the same line works for `codex` and `gemini` — and `status` prints
who is attached and how much is unread, never the message bodies.

Every block here is deliberately comment-free: `zsh` does not treat `#` as a comment in an
interactive shell, so a pasted `# …` line fails with `parse error`.

Already inside Claude Code or Codex? Install the adapter as a runtime plugin instead —
pairing (`openroly login` / `openroly pair` above) is still required afterward:

```bash
claude plugin marketplace add OpenRoly/openroly
```

```bash
codex plugin marketplace add OpenRoly/openroly
```

**Windows / iPhone / Android:** the inbox, the sources, and the "handle this" loop work from the
PWA at [atn.shibubu.ai](https://atn.shibubu.ai) on any OS. What needs macOS or Linux today is
the machine you *attach a runtime on* — the `openroly` CLI and the broker aren't built for
Windows yet. Android additionally gets an optional notification collector
(`apps/android-collector`, build from source). iOS has no public API for that, which is why
nothing here promises it.

### Getting an account

Signup is open — create an account at **[https://atn.shibubu.ai](https://atn.shibubu.ai)**, then
run `openroly login --url https://atn.shibubu.ai` as above (`--url` points at whichever OpenRoly
server issued your account).

What the operator can and cannot read is written down, not implied:
**[https://atn.shibubu.ai/privacy](https://atn.shibubu.ai/privacy)**. The short version: for a
sealed item the server holds the source kind, the app, the sender, the arrival time, and whether
you've dealt with it — never the subject or body. The key that unlocks your messages lives in
your browser / device and is never sent anywhere.

## Sources — how things reach your agent

| Source | How | Arrives |
|---|---|---|
| Mail | Anyone mails `you@atn.shibubu.ai`; or forward the notification mail Slack / X / your bank already send you | Sealed on arrival |
| GitHub | Repo → Settings → Webhooks → Payload URL and Secret from *Settings › Sources* (JSON, HMAC-SHA256) | Issues opened, PR opened / review requested, reviews submitted, failed checks, releases |
| Any script / Zapier / IFTTT | `curl -X POST …/v1/inbound/notification -H "Authorization: Bearer <source token>" -d '{"app_id":"my.app","title":"Hello"}'` | Sealed on arrival |
| Android | `apps/android-collector` — per-app capture (off / title only / full text), encrypted on the device, queued while offline | Sealed on the device |

Every source is created and revoked in *Settings › Sources*; each has its own token, and each
recipe card shows the exact command for that source.

## `openroly-mask` — the masking half, on its own

If you only want the "sealed across vendors" part, `packages/mcp-mask` needs no account. Wrap any
MCP server's command with `openroly-mask --` in `.mcp.json` / `.codex/config.toml` /
`.gemini/settings.json`, put the strings you never want a model to see in
`~/.openroly/secrets.json` (`chmod 600`), and every tool result is masked before it reaches the
model — the same way in every client. Emails, phone numbers, card numbers (Luhn-checked), and
key-shaped strings are masked with no dictionary at all. See
[`packages/mcp-mask/README.md`](packages/mcp-mask/README.md). (Not yet on npm; until then run it
from a clone: `bun packages/mcp-mask/src/cli.ts -- <your-mcp-server-command>`.)

## CLI

| Command | What it does |
|---|---|
| `openroly login [--url …]` | Connect this machine to your account and start the broker (launchd on macOS) |
| `openroly pair <runtime>` / `openroly install <runtime>` | Attach a runtime as `@you`; `install` also registers the MCP server in the runtime's config |
| `openroly uninstall <runtime>` | Remove the MCP registration and the local credential |
| `openroly status` / `openroly doctor [runtime]` / `openroly runtimes` | Who's attached, what's unread (counts only), what's wrong |
| `openroly broker install \| uninstall \| status` | Manage the background broker's launchd registration |
| `openroly extensions` / `openroly sync [runtime]` | Extension Sync — the same skills/tools materialized in every attached runtime |
| `openroly work <verb>` / `openroly peek` | The work ledger: what's in progress, who holds the write lease, what the model actually saw |
| `openroly statusline` | One line for your shell / runtime status bar |
| `openroly agent <openai\|anthropic\|gemini> --thread <id>` | Run an API-key model as a runtime for one turn and hand the draft reply to a thread |

Everything the CLI stores lives under `~/.openroly/` (credentials, the broker binary, logs;
`OPENROLY_HOME` overrides it). `openroly uninstall <runtime>` and `openroly broker uninstall`
remove what `pair` and `login` added.

## What's in this repository

```
packages/
  core/              pure domain: identity, handle validation, delegation, message routing,
                      extension-sync reconciliation, work ledger, context resolver — no I/O
  crypto-envelope/    native E2EE message envelope (HPKE + AES-GCM) — see specs/e2ee-envelope-format.md
  adapter/            the extension side of "attach a runtime": pairing, credential store,
                      binary fetch + checksum, instructions/MCP/skill materialization, diagnostics
  mcp/                MCP server exposing the Account API as tools a runtime can call
  mcp-mask/           standalone stdio masking proxy for any MCP server (no account needed)

adapters/official/
  claude/              Claude Code adapter + Claude Code plugin
  codex/               Codex adapter + Codex plugin
  gemini/              Gemini CLI adapter
  api/                 generic API-key provider adapter (OpenAI / Anthropic / Gemini)

apps/
  cli/                 `openroly` command: login, pair, sync extensions, work, diagnostics
  android-collector/   Android notification collector (Kotlin) — encrypts on the device

broker/                Rust device broker: wakes the paired runtime when a message arrives,
                        runs the dedicated session in a contained sandbox with an egress proxy
                        (background service `openroly login` installs — see Quickstart)

specs/
  runtime-adapter-contract.md   the boundary a new runtime integration implements
  e2ee-envelope-format.md       the wire format for encrypted messages

scripts/build-binaries.sh      how the Release binaries are built (bun build --compile)
.claude-plugin/ · .agents/     marketplace manifests for the Claude Code and Codex plugins
.github/workflows/release.yml  tag → prebuilt `openroly`, `openroly-mcp`, and `openroly-broker`
                                binaries + SHA256SUMS
```

## What is *not* in this repository

Per the project's [Distribution / OSS strategy](#why-this-split), the Hosted Account Network
implementation is kept private:

- Global `@handle` registry and Account backend
- Encrypted mailbox storage / store-and-forward server
- Device/runtime coordination backend, email gateway, push infrastructure
- Abuse/spam systems, operational/admin infrastructure

Using the code in this repo (adapters, CLI, MCP server, broker) requires an OpenRoly account
server to talk to — during Stage 1 that's the hosted instance at
**[https://atn.shibubu.ai](https://atn.shibubu.ai)**, open to signup.

## Why this split

The value proposition is runtime neutrality — client/runtime code, the crypto boundary, and the
interoperability contracts (this repo) are open so any runtime (present or future) can implement
the adapter contract against a stable, inspectable boundary. What leaves your machine, and how it
is sealed before it does, is all in this repo. The Hosted Account Network that provides the actual
global identity/mailbox service is a separate operational concern (abuse prevention, availability,
recovery) that isn't part of what makes the account runtime-neutral, so it stays private for now.

## Contributing and security

- New runtime adapters are the highest-leverage contribution — see
  [CONTRIBUTING.md](./CONTRIBUTING.md) and `specs/runtime-adapter-contract.md`.
- Vulnerabilities: use GitHub's private vulnerability reporting, not a public issue — see
  [SECURITY.md](./SECURITY.md).
- Development: `bun install && bun run check` (typecheck + tests). Rust for `broker/`.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

## Status of this repository

This is Stage 1 of a staged rollout: OSS code is public and under active development; the Hosted
Account Network is open for signup while identity/recovery/device-security guarantees are
hardened. Expect breaking changes. Issues and discussion are welcome.

*OpenRoly was called "All Together Now" / ATN before 2026-09; older links and the `atn` binary
name refer to the same project.*
