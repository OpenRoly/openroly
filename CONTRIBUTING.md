# Contributing to OpenRoly

OpenRoly is Public Alpha — expect breaking changes while the runtime adapter contract and the
encryption envelope format settle. For a large change, a discussion first is worth more than the
pull request itself.

## Where help matters most

- **Runtime adapters.** Implement `ExtensionAdapter` for a runtime that isn't officially supported yet
  (Hermes, OpenClaw, or another). Start with [`specs/extension-adapter-contract.md`](specs/extension-adapter-contract.md)
  and the reference implementations in `adapters/official/{claude,codex,api}`. Runtime
  neutrality only means something if many runtimes implement the contract.
- **Linux.** The Linux sandbox (Landlock + seccomp) is in, and waking real AIs inside it is being tested
  (see [ROADMAP.md](ROADMAP.md)). Running the broker on real distributions and kernels, and reporting
  what the startup self-test says, helps a lot.
- **Documents that don't match the code.** If the README, the roadmap, or `specs/*.md` says one thing
  and the code does another, that's a bug either way — please open an issue.
- **Tests** for `packages/*`, the adapters, and `broker/`.

## Development setup

You need [Bun](https://bun.sh) 1.3.14 and a stable Rust toolchain.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test apps/cli packages
cargo test --manifest-path broker/Cargo.toml
```

These are the same commands the repository's CI runs on every push and pull request
(`.github/workflows/public-ci.yml`). `bun.lock` in this repository matches this repository's
workspaces exactly, so `--frozen-lockfile` gives you the same dependency versions a release is built with.

## Implementing the Personal Agent Account Protocol

The [Personal Agent Account Protocol (PAAP) v0.1](specs/paap/README.md) is a file format for an agent's ongoing
work — identity, work, checkpoints, and handoffs — plus the rules for continuing that work somewhere else.
OpenRoly is its reference implementation, but the spec, its JSON Schemas, and its fixtures are all you need to
write your own, in any language. `examples/miniroly` (TypeScript) and `examples/miniroly-py` (Python) were
written that way.

**Claiming a level.** Name the levels your implementation passes, as defined in spec §8:

| Level | Claim it when | How to check |
|---|---|---|
| L1 Reader | your summary (§8.1) equals `expect.summary.json` for every `valid/*` fixture | the fixtures |
| L2 Writer | the checkpoints you write keep the invariants, and every `invalid/*` fixture fails with the `reason` in its `expect.json` | the fixtures, then `openroly capsule verify <dir>` on a capsule you wrote |
| L3 Continuer | starting from a `routed` handoff, you commit it and write the next checkpoint at `write_epoch = reserved_epoch + 1`, keeping every earlier one | `openroly capsule verify <after> --continued-from <before>` |

**Running the fixtures.** The fixtures live in `specs/paap/v0.1/fixtures`. To run the reference validator and
both examples against all of them, the same step CI runs on every push and pull request:

```bash
bun test packages/core/test/protocol.test.ts packages/core/test/miniroly.test.ts packages/core/test/miniroly-py.test.ts
```

To check one capsule with the reference validator (`--json` prints the L1 summary, or the failure reason):

```bash
bun apps/cli/src/openroly.ts capsule verify specs/paap/v0.1/fixtures/valid/basic/capsule --json
```

Each object also has a JSON Schema (2020-12) in `specs/paap/v0.1`, so a shape check needs nothing from this
repository: any 2020-12 validator works (this repository's own test uses Ajv's 2020 build in strict mode). A
schema checks one file's shape only. The invariants — hashes, versions, the manifest, handoff epochs — need a
validator, and the fixtures are how you know yours is right.

**Changing the spec.** A pull request that changes `specs/paap/` follows spec §10: a minor version only adds
files and optional fields, and never changes an existing requirement. Change the README text, the schema, and
the fixtures in the same pull request — at least one `valid/*` case for what you add, and an `invalid/*` case
for every new failure reason — and make the reference validator (`packages/core/src/protocol.ts`) pass them,
so every implementation can test against the change the day it lands.

**Listing your implementation.** Open a pull request that adds a row to the table in spec §8.2, with the levels
you claim and how you checked them.

## The account server

The CLI, adapters, MCP server, and broker pair against an account server. Today that is the hosted
service at [openroly.shibubu.ai](https://openroly.shibubu.ai), free during the alpha. The server's source is
not in this repository yet, so changes to it can't land here; self-hosting is on the
[roadmap](ROADMAP.md).

## Words in user-facing text

People using OpenRoly learn three words: **your agent** (Me), **jobs** (Work), and **places** (Place).
CLI output, error messages, and docs should use those. Keep internal names — lease, epoch, manifest,
adapter — out of what a person reads, unless they asked for detail (`--json`, `openroly doctor`).

## Commit / PR conventions

- Keep PRs scoped to one change; explain *why*, not just *what*, in the description.
- If your change alters behavior described in the README, `ROADMAP.md`, or `specs/*.md`, update
  that text in the same PR.
- Sign off that your contribution is your own work and you're licensing it under this
  repository's Apache-2.0 license (see [LICENSE](./LICENSE)).
