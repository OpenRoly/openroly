import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "../src/reconcile.ts";
import {
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type ExtensionApplyAction,
  type ExtensionListing,
  type RuntimeAdapter,
} from "../src/contract.ts";

// AC-8(未管理を触らない、実 adapter 経路)/ AC-13(credential_ref 未解決)/
// AC-14(部分失敗)/ AC-15,16(dry-run と 冪等性)。
// GET /v1/extensions と POST /v1/extensions/:id/status だけを実装した fake server で
// reconcile() の orchestration(credential 解決・エラー隔離・status 報告規約)だけを検査する
// —— 判定順序そのもの(図8)は packages/core/test/extension.test.ts が純関数として検査済み。

let desiredResponse: unknown[] = [];
const statusCalls: { extensionId: string; body: any }[] = [];
/** PBI-0009: connection: scheme のテスト用に /resolve の応答を差し替える */
let resolveResponses: Record<string, { status: number; body: unknown }> = {};
const resolveCalls: string[] = [];
/** PBI-0023 F3: status 報告の HTTP 応答を差し替える(既定は 200) */
let statusResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };
/** env: 解決の落ち先(`~/.openroly/secrets.json`)を開発機の本物から切り離す(PBI-0212) */
const emptyHome = mkdtempSync(join(tmpdir(), "openroly-reconcile-"));

const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/extensions" && req.method === "GET") {
      return Response.json(desiredResponse);
    }
    const statusMatch = url.pathname.match(/^\/v1\/extensions\/([^/]+)\/status$/);
    if (statusMatch && req.method === "POST") {
      const body = await req.json();
      statusCalls.push({ extensionId: statusMatch[1]!, body });
      return Response.json(statusResponse.body, { status: statusResponse.status });
    }
    const resolveMatch = url.pathname.match(/^\/v1\/connections\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      const provider = resolveMatch[1]!;
      resolveCalls.push(provider);
      const stubbed = resolveResponses[provider] ?? { status: 404, body: { error: "not_connected" } };
      return Response.json(stubbed.body, { status: stubbed.status });
    }
    return new Response("not found", { status: 404 });
  },
});
const baseUrl = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

beforeEach(() => {
  desiredResponse = [];
  statusCalls.length = 0;
  resolveResponses = {};
  resolveCalls.length = 0;
  statusResponse = { status: 200, body: { ok: true } };
});

interface FakeAdapterState {
  applyCalls: ExtensionApplyAction[];
  listing: ExtensionListing[];
  throwOn?: string;
}

function makeFakeAdapter(state: FakeAdapterState): RuntimeAdapter {
  return {
    id: "claude",
    displayName: "Claude Code",
    capabilities: STAGE0_CAPABILITIES,
    detect: async () => ({ installed: true, detail: "fake" }),
    register: async () => {},
    unregister: async () => {},
    doctor: async () => [],
    extensionKinds: ["mcp"],
    listExtensions: async () => state.listing,
    applyExtension: async (_ctx, action) => {
      state.applyCalls.push(action);
      if (state.throwOn === action.name) throw new Error(`boom on ${action.name}`);
    },
    exportExtensions: async () => [],
    watchPaths: () => [],
  };
}

const ctx: AdapterContext = { env: {} };

describe("reconcile()", () => {
  test("install 成功: applyExtension が呼ばれ、status=applied/applied_revision で報告される", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx", args: ["-y", "gh-mcp"] },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.plan).toMatchObject([{ action: "install", name: "github" }]);
    expect(state.applyCalls).toMatchObject([
      { action: "install", name: "github", spec: { command: "npx" }, env: {} },
    ]);
    expect(statusCalls).toMatchObject([
      { extensionId: "ext_gh", body: { status: "applied", applied_revision: 1 } },
    ]);
    expect(result.applied).toMatchObject([{ action: "install", name: "github" }]);
    expect(result.failed).toEqual([]);
  });

  test("AC-13: credential_ref が解決できない時は native を書かず failed を報告する", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: "env:GITHUB_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      // GITHUB_TOKEN が無い。OPENROLY_HOME も空 dir に向ける —— PBI-0212 で env: は
      // `~/.openroly/secrets.json` にも落ちるので、指さないと**開発機の本物**を読んでしまう
      env: { OPENROLY_HOME: emptyHome },
    });
    const detail = "cannot resolve env:GITHUB_TOKEN (not in the environment or ~/.openroly/secrets.json)";
    expect(state.applyCalls).toEqual([]); // native を書かない
    expect(result.failed).toMatchObject([{ name: "github", detail }]);
    expect(statusCalls).toMatchObject([{ extensionId: "ext_gh", body: { status: "failed", detail } }]);
  });

  test("credential_ref が解決できる時は env に注入されて applyExtension へ渡る", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: "env:GITHUB_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      // OPENROLY_HOME を隔離する: GITHUB_TOKEN は env から直接解決されるので値には効かないが、
      // resolveCredentialRef は毎回 loadSecrets(env) を先に呼ぶ(未使用でも)ので、指さないと
      // 開発機の本物の secrets.json を読みに行ってしまう(review: PBI-0414 で openrolyHome() に
      // 足した test-mode 検知ガードがこの読み忘れを実際に検出した)
      env: { GITHUB_TOKEN: "ghp_realvalue", OPENROLY_HOME: emptyHome },
    });
    expect(state.applyCalls).toMatchObject([{ env: { GITHUB_TOKEN: "ghp_realvalue" } }]);
    expect(result.failed).toEqual([]);
    // secret は status 報告には含まれない(applied_revision と status のみ送る)
    expect(JSON.stringify(statusCalls)).not.toContain("ghp_realvalue");
  });

  // ---- PBI-0009: credential_ref の connection:<provider> scheme(Account 側解決) ----

  test("AC-5: connection: scheme は POST /v1/connections/:provider/resolve で解決され env に注入される", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: "connection:github",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    resolveResponses = { github: { status: 200, body: { env: { GITHUB_TOKEN: "ghp_fromconnection" } } } };
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(resolveCalls).toEqual(["github"]);
    expect(state.applyCalls).toMatchObject([{ env: { GITHUB_TOKEN: "ghp_fromconnection" } }]);
    expect(result.failed).toEqual([]);
    // secret は status 報告には含まれない
    expect(JSON.stringify(statusCalls)).not.toContain("ghp_fromconnection");
  });

  test("AC-3: connection: scheme が resolve できない(revoke 済み等)時は native を書かず failed を報告する", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: "connection:github",
        enabled: true,
        revision: 2,
        deleted_at: null,
        materializations: [{ runtime_id: "rt_1", status: "applied", applied_revision: 1 }],
      },
    ];
    resolveResponses = { github: { status: 404, body: { error: "not_connected" } } };
    const state: FakeAdapterState = { applyCalls: [], listing: [{ name: "github" }] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls).toEqual([]); // native を書かない
    expect(result.failed).toMatchObject([{ name: "github", detail: "cannot resolve connection:github" }]);
    expect(statusCalls).toMatchObject([
      { extensionId: "ext_gh", body: { status: "failed", detail: "cannot resolve connection:github" } },
    ]);
    // applied_revision は送らない(reportStatus の既定 null。再 authorize 後の revision 比較を壊さないため)
    expect(statusCalls[0]!.body.applied_revision).toBeNull();
  });

  test("AC-14: 3 件中 1 件だけ失敗しても残り 2 件は適用される", async () => {
    desiredResponse = ["a", "b", "c"].map((name, i) => ({
      id: `ext_${name}`,
      kind: "mcp",
      name,
      spec: { command: "npx" },
      credential_ref: null,
      enabled: true,
      revision: 1,
      deleted_at: null,
      materializations: [],
    }));
    const state: FakeAdapterState = { applyCalls: [], listing: [], throwOn: "b" };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls.map((c) => c.name).sort()).toEqual(["a", "b", "c"]);
    expect(result.applied.map((a) => a.name).sort()).toEqual(["a", "c"]);
    expect(result.failed).toMatchObject([{ name: "b", detail: "boom on b" }]);
    const byExt = Object.fromEntries(statusCalls.map((s) => [s.extensionId, s.body.status]));
    expect(byExt).toEqual({ ext_a: "applied", ext_b: "failed", ext_c: "applied" });
  });

  test("AC-15: dry-run は plan だけを返し、native にも status にも一切書き込まない", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
      dryRun: true,
    });
    expect(result.plan).toMatchObject([{ action: "install", name: "github" }]);
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("AC-16: 差分が無ければ noop になり applyExtension も status POST も呼ばれない(冪等性)", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [
          { runtime_id: "rt_1", status: "applied", applied_revision: 1, detail: null },
        ],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [{ name: "github" }] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.plan).toMatchObject([{ action: "noop", name: "github" }]);
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  test("AC-8: 未管理の native extension には applyExtension が一度も呼ばれない", async () => {
    desiredResponse = [];
    const state: FakeAdapterState = {
      applyCalls: [],
      listing: [{ name: "openroly" }, { name: "other" }],
    };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.plan.every((a) => a.action === "noop")).toBe(true);
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  test("kind 未対応は unsupported として報告され、applyExtension は呼ばれない", async () => {
    desiredResponse = [
      {
        id: "ext_figma",
        kind: "plugin",
        name: "figma",
        spec: {},
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls).toEqual([]);
    expect(statusCalls).toMatchObject([{ extensionId: "ext_figma", body: { status: "unsupported" } }]);
  });

  test("AC-10: uninstall 成功時は status=uninstalled(値ではなく行削除 signal)で報告する", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: new Date().toISOString(),
        materializations: [
          { runtime_id: "rt_1", status: "applied", applied_revision: 1, detail: null },
        ],
      },
    ];
    const state: FakeAdapterState = { applyCalls: [], listing: [{ name: "github" }] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(state.applyCalls).toMatchObject([{ action: "uninstall", name: "github" }]);
    expect(statusCalls).toMatchObject([{ extensionId: "ext_gh", body: { status: "uninstalled" } }]);
    expect(result.applied).toMatchObject([{ action: "uninstall", name: "github" }]);
  });

  // ---- PBI-0023 F3: status 報告の HTTP 応答を捨てない ----

  test("F3/AC-7: status 報告が 500 なら applied ではなく failed に数える", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: { command: "npx" },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    statusResponse = { status: 500, body: { error: "boom" } };
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    // native への適用自体は起きている。だが Account 側が追随していないので成功ではない
    expect(state.applyCalls).toMatchObject([{ action: "install", name: "github" }]);
    expect(result.applied).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.name).toBe("github");
    expect(result.failed[0]!.detail).toContain("500");
  });

  test("F3: unsupported の報告が 403 でも例外を投げず failed に落ちる", async () => {
    desiredResponse = [
      {
        id: "ext_sk",
        kind: "plugin",
        name: "some-plugin",
        spec: {},
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    statusResponse = { status: 403, body: { error: "forbidden" } };
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.applied).toEqual([]);
    expect(result.failed).toMatchObject([{ name: "some-plugin" }]);
  });

  test("F3: 失敗の報告自体が落ちても、後続の extension の処理は止まらない", async () => {
    desiredResponse = [
      {
        id: "ext_a",
        kind: "mcp",
        name: "a",
        spec: { command: "npx" },
        credential_ref: "env:MISSING",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
      {
        id: "ext_b",
        kind: "mcp",
        name: "b",
        spec: { command: "npx" },
        credential_ref: "env:MISSING",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    statusResponse = { status: 500, body: { error: "boom" } };
    const state: FakeAdapterState = { applyCalls: [], listing: [] };
    const result = await reconcile({
      adapter: makeFakeAdapter(state),
      ctx,
      baseUrl,
      token: "par_x",
      runtimeId: "rt_1",
      env: {},
    });
    expect(result.failed.map((f) => f.name)).toEqual(["a", "b"]);
    expect(statusCalls.length).toBe(2); // 2 件とも報告を試みている
  });
});
