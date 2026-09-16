import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// PBI-0625（dogfood F4）: `openroly runtimes prune` —— 端末から名簿を掃除する面。
// 見るのは 2 つ。**① 叩く credential がこの端末の物(kind=broker)か**（AI の credential で叩くと
// server が 403 を返すので、掃除が一度も成立しない）。**② server の答えをそのまま出すか**
// —— 候補を CLI 側で予測すると判定器が 2 つになり「残ると言ったのに消えた」窓が開く。
const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

/** id → DELETE の応答。実 server(app.ts)が返す物をそのまま写す */
let deleteAnswers: Record<string, { status: number; body: unknown }> = {};
let roster: { id: string; kind: string; name: string }[] = [];
const seen: { method: string; path: string; authorization: string | null }[] = [];

const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      path: url.pathname,
      authorization: req.headers.get("authorization"),
    });
    if (url.pathname === "/v1/agents" && req.method === "GET") {
      return Response.json({ me: {}, runtimes: roster, contacts: [] });
    }
    const m = url.pathname.match(/^\/v1\/runtimes\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      const answer = deleteAnswers[m[1]!] ?? { status: 404, body: { error: "not_found" } };
      return Response.json(answer.body as any, { status: answer.status });
    }
    return new Response("not found", { status: 404 });
  },
});
const baseUrl = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

const ROSTER = [
  { id: "rt_A", kind: "broker", name: "this machine" },
  { id: "rt_claudeA", kind: "claude", name: "this machine / Claude Code" },
  { id: "rt_B", kind: "broker", name: "old mac" },
  { id: "rt_claudeB", kind: "claude", name: "old mac / Claude Code" },
];

beforeEach(() => {
  roster = ROSTER.map((r) => ({ ...r }));
  deleteAnswers = {
    rt_A: { status: 409, body: { error: "self" } },
    rt_claudeA: { status: 409, body: { error: "in_use" } },
    rt_B: { status: 200, body: { ok: true } },
    // 親 B を落とした tx の cascade で既に落ちている
    rt_claudeB: { status: 404, body: { error: "not_found" } },
  };
  seen.length = 0;
});

/** この端末の credential(broker)と、AI の credential(claude)の両方を置く */
async function seededHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "openroly-prune-home-"));
  for (const [kind, runtimeId, token] of [
    ["claude", "rt_claudeA", "par_claude"],
    ["broker", "rt_A", "par_broker"],
  ] as const) {
    await saveCredential(
      kind,
      {
        runtime_id: runtimeId,
        token,
        base_url: baseUrl,
        name: kind,
        paired_at: new Date().toISOString(),
      },
      { OPENROLY_HOME: home },
    );
  }
  return home;
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

describe("openroly runtimes prune (PBI-0625)", () => {
  test("AC-1: server の答えを 1 行ずつ出し、断られた行は理由付きで残す", async () => {
    const home = await seededHome();
    const res = await openroly(["runtimes", "prune"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pruned 2 of 4");
    // 消えた 2 本(cascade の子は `already gone`)と、断られた 2 本の理由
    expect(res.stdout).toMatch(/removed\s+broker\s+old mac\s+rt_B/);
    expect(res.stdout).toMatch(/already gone\s+claude\s+old mac \/ Claude Code\s+rt_claudeB/);
    expect(res.stdout).toMatch(/kept self\s+broker\s+this machine\s+rt_A/);
    expect(res.stdout).toMatch(/kept in_use\s+claude/);
    // **この端末の credential で叩いている**(claude の token で叩けば server は 403 を返す)
    expect(seen.length).toBe(5); // /v1/agents 1 + DELETE 4
    expect(seen.every((s) => s.authorization === "Bearer par_broker")).toBe(true);
    expect(seen.filter((s) => s.method === "DELETE").map((s) => s.path).sort()).toEqual(
      ["/v1/runtimes/rt_A", "/v1/runtimes/rt_B", "/v1/runtimes/rt_claudeA", "/v1/runtimes/rt_claudeB"],
    );
  });

  test("AC-1(--json): 機械向けは outcome をそのまま持つ 1 つの JSON", async () => {
    const home = await seededHome();
    const res = await openroly(["runtimes", "prune", "--json"], home);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.pruned).toEqual([
      { id: "rt_A", kind: "broker", name: "this machine", outcome: "kept self" },
      { id: "rt_claudeA", kind: "claude", name: "this machine / Claude Code", outcome: "kept in_use" },
      { id: "rt_B", kind: "broker", name: "old mac", outcome: "removed" },
      { id: "rt_claudeB", kind: "claude", name: "old mac / Claude Code", outcome: "already gone" },
    ]);
  });

  test("AC-X4: 消す物が無い名簿でも exit 0(404 を error にしない)", async () => {
    const home = await seededHome();
    deleteAnswers = {};
    const res = await openroly(["runtimes", "prune"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pruned 4 of 4");
  });

  test("AC-X1: 端末が 1 台も繋がっていない時は、消えなかった事と次の手を言う", async () => {
    const home = await seededHome();
    deleteAnswers = Object.fromEntries(
      ROSTER.map((r) => [r.id, { status: 409, body: { error: "no_device" } }]),
    );
    const res = await openroly(["runtimes", "prune"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pruned 0 of 4");
    expect(res.stdout).toContain("no machine is connected right now");
    expect(res.stdout).toContain("openroly login");
  });

  test("端末の credential が無ければ叩かずに止まる(AI の credential で代用しない)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-prune-bare-"));
    await saveCredential(
      "claude",
      {
        runtime_id: "rt_claudeA",
        token: "par_claude",
        base_url: baseUrl,
        name: "claude",
        paired_at: new Date().toISOString(),
      },
      { OPENROLY_HOME: home },
    );
    const res = await openroly(["runtimes", "prune"], home);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("openroly login");
    expect(seen.length).toBe(0);
  });
});
