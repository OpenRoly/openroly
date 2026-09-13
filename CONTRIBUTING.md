# Contributing to OpenRoly

OpenRoly is Public Alpha — expect breaking changes while the runtime adapter contract and the
encryption envelope format settle. For a large change, a discussion first is worth more than the
pull request itself.

## Where help matters most

- **Runtime adapters.** Implement `ExtensionAdapter` for a runtime that isn't officially supported yet
  (Hermes, OpenClaw, or another). Start with [`specs/extension-adapter-contract.md`](specs/extension-adapter-contract.md)
  and the reference implementations in `adapters/official/{claude,codex,gemini,api}`. Runtime
  neutrality only means something if many runtimes implement the contract.
- **Linux.** The Linux sandbox is being built (see [ROADMAP.md](ROADMAP.md)). Running the broker on
  real distributions and kernels, and reporting what the sandbox could or couldn't enforce, helps a lot.
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

## The account server

The CLI, adapters, MCP server, and broker pair against an account server. Today that is the hosted
service at [atn.shibubu.ai](https://atn.shibubu.ai), free during the alpha. The server's source is
not in this repository yet, so changes to it can't land here; self-hosting is on the
[roadmap](ROADMAP.md).

## Commit / PR conventions

- Keep PRs scoped to one change; explain *why*, not just *what*, in the description.
- If your change alters behavior described in the README, `ROADMAP.md`, or `specs/*.md`, update
  that text in the same PR.
- Sign off that your contribution is your own work and you're licensing it under this
  repository's Apache-2.0 license (see [LICENSE](./LICENSE)).
