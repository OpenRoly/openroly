import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// AC-11/12(2 runtime の credential store 分離)/ AC-15,16(dry-run と冪等性)を
// CLI(openroly sync / openroly extensions)経由で検査する。実 claude/codex CLI には依存しない ——
// dry-run と「差分なし」の noop 経路は adapter.applyExtension を一度も呼ばないため、
// native CLI を shell out する機会が無い(kind=plugin は常に unsupported になるので同様)。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

let desiredResponse: unknown[] = [];
const statusCalls: { authorization: string | null; extensionId: string; body: any }[] = [];

const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/extensions" && req.method === "GET") {
      return Response.json(desiredResponse);
    }
    const m = url.pathname.match(/^\/v1\/extensions\/([^/]+)\/status$/);
    if (m && req.method === "POST") {
      const body = await req.json();
      statusCalls.push({
        authorization: req.headers.get("authorization"),
        extensionId: m[1]!,
        body,
      });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
const baseUrl = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

beforeEach(() => {
  desiredResponse = [];
  statusCalls.length = 0;
});

async function isolatedHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openroly-ext-home-"));
}

async function seedCredential(
  home: string,
  runtimeId: string,
  token: string,
): Promise<void> {
  await saveCredential(
    "claude",
    {
      runtime_id: runtimeId,
      token,
      base_url: baseUrl,
      name: `${runtimeId} / Claude Code`,
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
}

async function openroly(args: string[], home: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, OPENROLY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("openroly sync / openroly extensions", () => {
  test("AC-11/12: 別 OPENROLY_HOME の credential store は互いに独立し、それぞれ自分の token で status を書く", async () => {
    // kind=plugin は claude adapter の extensionKinds(["mcp"])に無いので必ず unsupported になり、
    // native CLI を一切呼ばずに 1 回だけ status POST が発生する(credential 分離だけを見る検査)
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
    const homeA = await isolatedHome();
    const homeB = await isolatedHome();
    await seedCredential(homeA, "rt_A", "par_tokenA");
    await seedCredential(homeB, "rt_B", "par_tokenB");

    const resultA = await openroly(["sync", "claude"], homeA);
    expect(resultA.exitCode).toBe(0);
    const resultB = await openroly(["sync", "claude"], homeB);
    expect(resultB.exitCode).toBe(0);

    expect(statusCalls.length).toBe(2);
    const tokens = statusCalls.map((c) => c.authorization).sort();
    expect(tokens).toEqual(["Bearer par_tokenA", "Bearer par_tokenB"]);
    expect(statusCalls.every((c) => c.body.status === "unsupported")).toBe(true);
  }, 30_000);

  test("AC-15: --dry-run は plan を出すだけで status を 1 度も書かない(native も未変更)", async () => {
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
    const home = await isolatedHome();
    await seedCredential(home, "rt_dry", "par_dry");
    const configPath = join(home, ".claude.json");
    const before = await stat(configPath).catch(() => null);

    const result = await openroly(["sync", "claude", "--dry-run"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("install");
    expect(result.stdout).toContain("dry-run");
    expect(statusCalls).toEqual([]);
    const after = await stat(configPath).catch(() => null);
    expect(after?.mtimeMs).toBe(before?.mtimeMs);
  }, 30_000);

  test("AC-16: native・DB とも既に一致していれば noop のみで status を 1 度も書かない(冪等性)", async () => {
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
        materializations: [
          { runtime_id: "rt_noop", status: "applied", applied_revision: 1, detail: null },
        ],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home, "rt_noop", "par_noop");
    // native に既に github が入っている状態を再現(claude CLI を呼ばず直接書く)
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: {} } },
      }),
    );

    const result = await openroly(["sync", "claude"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no changes");
    expect(statusCalls).toEqual([]);
  }, 30_000);

  test("openroly extensions: desired 一覧 + runtime 別 status を表示する", async () => {
    desiredResponse = [
      {
        id: "ext_gh",
        kind: "mcp",
        name: "github",
        spec: {},
        credential_ref: null,
        enabled: true,
        revision: 3,
        deleted_at: null,
        materializations: [
          { runtime_id: "rt_list", status: "applied", applied_revision: 3, detail: null },
        ],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home, "rt_list", "par_list");

    const result = await openroly(["extensions"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("github");
    expect(result.stdout).toContain("rev3");
    expect(result.stdout).toContain("rt_list:applied");
  }, 30_000);

  test("未接続なら extensions / sync は次の一手を示して失敗する", async () => {
    const home = await isolatedHome();
    expect((await openroly(["extensions"], home)).stderr).toContain("openroly login");
    expect((await openroly(["sync"], home)).stderr).toContain("openroly login");
  }, 30_000);

  test("AC-14: 1 件でも failed が有れば sync の exit code は 1 になる", async () => {
    // credential_ref 未解決は native CLI を呼ばずに failed になる経路(他のテストと同じ手)
    desiredResponse = [
      {
        id: "ext_fail",
        kind: "mcp",
        name: "needs-secret",
        spec: { command: "npx" },
        credential_ref: "env:MISSING_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home, "rt_fail", "par_fail");

    const result = await openroly(["sync", "claude"], home);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("NG needs-secret");
    expect(statusCalls).toMatchObject([{ body: { status: "failed" } }]);
  }, 30_000);
});
