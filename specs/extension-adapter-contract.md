# Extension Adapter Contract (draft)

Status: **draft** — derived from `packages/adapter/src/contract.ts`.
The commit that changes the contract and this document live in the same tree, and
`packages/adapter/test/contract-spec.test.ts` fails if the interface below is missing an operation
the code defines. Treat field and method names as the current reference implementation, not a
frozen wire format.

This document describes the boundary a runtime integration must implement to attach an
Agent Account to a runtime (Claude Code, Codex, Gemini CLI, API-key models, and future runtimes).

## Why this boundary exists

OpenRoly is runtime-neutral: the Account (identity, mailbox, delegation policy) is owned by the
Account layer, not by any single runtime. An `ExtensionAdapter` is the only place that knows
how to talk to one specific runtime's CLI and config. Everything else (pairing engine,
credential store, extension reconciliation, waking a runtime) is runtime-agnostic and lives outside
the adapter.

## The `ExtensionAdapter` interface

```ts
interface ExtensionAdapter {
  id: string;              // credential store key, also the CLI arg (e.g. "claude", "codex")
  displayName: string;     // human-facing name (e.g. "Claude Code")
  capabilities: AdapterCapabilities;

  detect(ctx: AdapterContext): Promise<DetectResult>;
  register(ctx: AdapterContext, input: RegisterInput): Promise<void>;
  unregister(ctx: AdapterContext, serverName: string): Promise<void>;
  doctor(ctx: AdapterContext, serverName: string): Promise<Finding[]>;

  extensionKinds: ExtensionKind[];
  listExtensions(ctx: AdapterContext): Promise<ExtensionListing[]>;
  applyExtension(ctx: AdapterContext, action: ExtensionApplyAction): Promise<void>;
  exportExtensions(ctx: AdapterContext): Promise<ExportedExtension[]>;
  watchPaths(ctx: AdapterContext): string[];
}
```

Full type definitions: `packages/adapter/src/contract.ts`. Official implementations:
`adapters/official/{claude,codex,gemini,api}`.

### `AdapterContext`

```ts
interface AdapterContext {
  env: Record<string, string | undefined>;
}
```

The adapter never reads process-global env directly — every runtime CLI invocation goes
through `ctx.env`, so tests (and sandboxed callers) can redirect `HOME` /
`CODEX_HOME` / `PATH` without touching the real environment.

### `AdapterCapabilities`

```ts
interface AdapterCapabilities {
  pair: boolean;
  status: boolean;
  notify: boolean;
  wake: boolean;
  createSession: boolean;
  sendInstruction: boolean;
}
```

An adapter declares what it can do rather than the caller assuming. The official adapters
declare `{ pair: true, status: true }` and `false` for the other four.

Those four `false`s do not mean a runtime can't be woken. Waking a runtime and starting a
dedicated session are done by the Device Broker (`broker/`), which launches the runtime's own CLI
inside the OS sandbox and egress proxy — not through adapter methods. The four flags are reserved
for adapters that can drive a runtime directly.

### `register` / `unregister` — pairing an MCP server into the runtime

`register` writes the runtime's own MCP config so that a `bun`-launched MCP server entry
(`serverEntry`) is reachable by the runtime, scoped to one `runtimeKind` credential and one
Account (`baseUrl`, `serverName`). `unregister` removes it. The adapter does not persist
anything itself — all state either lives in the runtime's own config file or in the
credential store outside the adapter.

### `doctor` — read-only diagnosis

Returns a list of `{ ok, label, detail }` findings about the runtime-side registration only.
Account-side diagnosis (is the Account reachable, is the device key present) is a separate
concern the caller composes on top.

### Extensions: `extensionKinds` / `listExtensions` / `applyExtension`

An Extension is an Account-scoped desired-state record (currently `mcp` or `skill`) that a
runtime materializes into its own native config. `extensionKinds` declares which kinds this
adapter can materialize (`unsupported` is reported for the rest — this is a valid, expected
outcome, not an error). `applyExtension` takes one of:

```ts
type ExtensionApplyAction =
  | { action: "install"; name: string; kind: ExtensionKind; spec: Record<string, unknown>; env: Record<string, string> }
  | { action: "update";  name: string; kind: ExtensionKind; spec: Record<string, unknown>; env: Record<string, string> }
  | { action: "disable"; name: string }
  | { action: "uninstall"; name: string };
```

Invariant an adapter must uphold: **a failed native operation must throw, not be silently
swallowed.** If the native runtime CLI reports a real failure (non-zero exit, malformed
config) removing/disabling an extension, `applyExtension` must reject — the caller
(reconciliation) uses this to decide whether the Account's desired-state row can be purged.
Uninstalling something that was never registered natively is idempotent success, not an
error.

### `exportExtensions` — what the person installed by hand

Returns the extensions a person added to this runtime themselves, shaped as proposals the Account
can approve and hand to the other runtimes. It must leave out what OpenRoly installed (the
`openroly` MCP server and skills carrying `.openroly-managed`), or every approval would propose
the same thing again.

Every `env` value is removed from `spec` and returned separately as `secretEnv`. The Account only
ever receives the variable name (`env:NAME`); the value stays in `~/.openroly/secrets.json` on the
device.

### `watchPaths` — where native changes show up

Returns the paths whose changes mean this runtime's native config changed (its MCP config file
and skills directory). The broker watches them so a hand-installed extension is proposed without
anyone running `openroly share`. Return paths that don't exist yet too, and don't probe the runtime
binary to compute them — this is called often.

## What this contract deliberately does not cover

- Credential storage and resolution (`credential_ref` → secret) — that boundary is the
  credential store, not the adapter.
- Waking runtimes and sandboxing them — the Device Broker (`broker/`).
- Device pairing protocol / device keys — separate spec (`specs/e2ee-envelope-format.md` covers the
  crypto half; the pairing handshake itself is not yet split into its own draft).
- Extension Sync's desired-state reconciliation algorithm (`packages/core/src/extension.ts`,
  `planReconciliation`) — kind-agnostic and lives outside any adapter.

## Status / stability

Public Alpha. Expect breaking changes to names and shapes while more runtimes are added; changes
land in this file in the same commit as the code.
