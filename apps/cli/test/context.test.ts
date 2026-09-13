// PBI-0398 / CAP-3 B2: `openroly context show` の面(AC-3 の CLI 側)。
// server 側(材料と上限)は apps/server/test/context.test.ts が本物の DB で測るので、ここは
//  - `--json` で **stdout 全体が 1 つの JSON**(進捗行が混ざっていない)
//  - 既定は人間向けで、**静的側と動的側が別々に印字**され、切った事が黙って消えない
//  - 未知の subcommand と未 pairing は使い方を出して落ちる
// を測る。server は stub(CLI の面だけを見る)。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

const taskQueries: (string | null)[] = [];
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/context") return new Response("not found", { status: 404 });
    taskQueries.push(url.searchParams.get("task"));
    return Response.json({
      context: {
        identity: "@ctxcli · acc_1 · runtime you are: claude",
        constraints: "no financial actions",
        preferences: "reply in Japanese",
        current_work: '#wrk_1 "auth refactor" · status running · proof 31/34\nrunning now: lease run-1 (epoch 1)',
        capabilities: "mcp: github",
        pointers: 'memory_search("auth refactor") / history_get("wrk_1")',
        tokenEstimate: 412,
        truncationReport: [
          { element: "constraints", original: 600, kept: 250, reason: "per-element-limit" },
        ],
        nearLimit: ["preferences"],
      },
      budget: 1000,
      static: "identity:     @ctxcli · acc_1 · runtime you are: claude\ncapabilities: mcp: github",
      dynamic: 'current_work: #wrk_1 "auth refactor" · status running · proof 31/34\npointers:     memory_search("auth refactor")',
    });
  },
});
const baseUrl = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

async function seededHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "openroly-ctx-"));
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_c",
      token: "par_ctx",
      base_url: baseUrl,
      name: "rt_c / Claude Code",
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
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

describe("PBI-0398 openroly context show", () => {
  test("--json は stdout 全体が 1 つの JSON で、package と 2 面をそのまま運ぶ", async () => {
    const home = await seededHome();
    const res = await openroly(["context", "show", "--json"], home);
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(res.stdout); // **全体を 1 回で** parse(進捗行が 1 行でも混ざれば落ちる)
    expect(doc.ok).toBe(true);
    expect(doc.data.context.tokenEstimate).toBe(412);
    expect(doc.data.budget).toBe(1000);
    expect(doc.data.dynamic).toContain("current_work:");
    expect(doc.data.static).not.toContain("current_work");
  });

  test("既定は人間向け。静的側 / 動的側 / 切った要素が別々に読める", async () => {
    const home = await seededHome();
    const res = await openroly(["context", "show"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("context package · 412 / 1000 tokens");
    expect(res.stdout).toContain("static — the managed block");
    expect(res.stdout).toContain("dynamic — the session instruction");
    // 黙って落とさない: 何がどこまで切られたかが 1 行で出る
    expect(res.stdout).toContain("constraints: 600 -> 250 tokens (per-element-limit)");
    // 切られた要素もこの一覧に入る(上流と同じく**切る前**の材料で数える)ので、
    // 「まだ切れていない物」と読まれない見出しにしてある(有界レビュー 2026-09-09)
    expect(res.stdout).toContain(
      "under pressure (85% or more of their limit before truncation): preferences",
    );
  });

  test("--task はそのまま server の query に渡る(pointers の材料)", async () => {
    const home = await seededHome();
    taskQueries.length = 0;
    const res = await openroly(["context", "show", "--task", "review the PR", "--json"], home);
    expect(res.exitCode).toBe(0);
    expect(taskQueries).toEqual(["review the PR"]);
  });

  test("未知の subcommand は使い方を出して落ちる", async () => {
    const home = await seededHome();
    const res = await openroly(["context", "dump"], home);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("Usage: openroly context show");
  });

  test("未 pairing は login を案内して落ちる(server を叩かない)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-ctx-bare-"));
    const res = await openroly(["context", "show"], home);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("openroly login");
  });
});
