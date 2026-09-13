# Runtime Adapter Contract (draft)

Status: **draft** — derived from `packages/adapter/src/contract.ts`.
This file lives in the main repository as of 2026-09-11 (PBI-0422): the commit that changes the
contract and the document that describes it are now in the same tree.
This document describes the boundary a runtime integration must implement to attach an
Agent Account to a runtime (Claude Code, Codex, and future runtimes). It is not a promise
of API stability yet; treat field/method names as the current reference implementation,
not a frozen wire format.

## Why this boundary exists

OpenRoly is runtime-neutral: the Account (identity, mailbox, delegation policy) is owned by the
Account layer, not by any single runtime. A `RuntimeAdapter` is the only place that knows
how to talk to one specific runtime's CLI/config. Everything else (pairing engine,
credential store, extension reconciliation) is runtime-agnostic and lives outside the
adapter.

## The `RuntimeAdapter` interface

```ts
interface RuntimeAdapter {
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
}
```

Full type definitions: `packages/adapter/src/contract.ts`.

### `AdapterContext`

```ts
interface AdapterContext {
  env: Record<string, string | undefined>;
}
```

The adapter never reads process-global env directly — every runtime CLI invocation goes
through `ctx.env`, so tests (and future sandboxed callers) can redirect `HOME` /
`CODEX_HOME` / `PATH` without touching the real environment.

### `AdapterCapabilities`

```ts
interface AdapterCapabilities {
  pair: boolean;
  status: boolean;
  notify: boolean;          // requires a Device Broker push channel — not built yet
  wake: boolean;             // requires a Device Broker wake channel — not built yet
  createSession: boolean;
  sendInstruction: boolean;
}
```

An adapter declares what it can do rather than the caller assuming. The current official
adapters (Claude, Codex) both report `{ pair: true, status: true, notify: false, wake: false,
createSession: false, sendInstruction: false }` — pairing and read-only status only.

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

## What this contract deliberately does not cover

- Credential storage and resolution (`credential_ref` → secret) — that boundary is the
  credential store, not the adapter.
- Device pairing protocol / device keys — separate spec (E2EE envelope format covers the
  crypto half; the pairing handshake itself is not yet split into its own draft).
- Extension Sync's desired-state reconciliation algorithm (`packages/core/src/extension.ts`,
  `planReconciliation`) — kind-agnostic and lives outside any adapter.

## Status / stability

This is a **Stage 1A / experimental** draft published alongside the reference
implementation (`adapters/official/claude`, `adapters/official/codex`). Expect breaking
changes as `notify` / `wake` (Device Broker) and additional extension kinds land.
