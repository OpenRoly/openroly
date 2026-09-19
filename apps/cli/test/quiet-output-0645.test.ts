import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0645: **人間向けの面に無駄を出さない**。hero GIF の最終 frame で測った 6 つ ——
// 欠落値(`undefined` / `- passed`)・36 字の生 id・中身の無い event 10 行・内部語(epoch)・
// 折り返し・自分の account の owner。**機械が読む面(--json)は変えない**ので、この検査は
// 人間向けの stdout だけを見る。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

/** owner を返さない server(= 本番が古い時の形)。ここが `undefined` の出所だった */
const WORK = {
  id: "wrk_01a0aa95110a719abbf75efa2c7645bb",
  status: "todo",
  title: "Fix duplicate charge",
  visibility: "full",
  priority: 0,
  lease_holder_run: "run-6315ad8a-fa46-4e6d-933c-7c46a890a2dd",
  lease_epoch: 1,
  lease_acquired_at: "2026-09-16T00:00:00.000Z",
};

/** hero の実測どおり: 意味のある 1 件 + 中身の無い版上げ 10 件 */
const EVENTS = [
  ...Array.from({ length: 10 }, (_, i) => ({
    work_sequence: i + 1,
    kind: ["edited", "orchestration", "dispatch"][i % 3],
    run_id: "run-6315ad8a-fa46-4e6d-933c-7c46a890a2dd",
    payload: {},
  })),
  {
    work_sequence: 11,
    kind: "proof_added",
    run_id: "run-6315ad8a-fa46-4e6d-933c-7c46a890a2dd",
    // 数を持たない proof(古い記録)。`- passed / - failed` を出していた所
    payload: { status: "passed" },
  },
];

let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/v1/whoami") return Response.json({ handle: "alice", id: "acc_0645" });
      if (pathname === "/v1/works") return Response.json([WORK]);
      if (pathname.endsWith("/events")) return Response.json(EVENTS);
      if (pathname.startsWith("/v1/works/")) return Response.json(WORK);
      return new Response("[]", { headers: { "content-type": "application/json" } });
    },
  });
  home = await mkdtemp(join(tmpdir(), "openroly-0645-"));
  await mkdir(join(home, ".openroly"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, ".openroly", "credentials.json"),
    JSON.stringify({
      version: 1,
      runtimes: {
        claude: {
          runtime_id: "rt_0645",
          kind: "claude",
          name: "probe",
          token: "not-a-real-token",
          base_url: `http://127.0.0.1:${server.port}`,
        },
      },
    }),
  );
});

afterAll(() => server?.stop(true));

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, OPENROLY_HOME: join(home, ".openroly") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

/** 36 字級の生 id(`wrk_` + 32 hex / `run-` + UUID)が本文に出ていないか */
const RAW_ID = /(wrk_[0-9a-f]{32}|run-[0-9a-f]{8}-[0-9a-f]{4})/;

describe("人間向けの面に無駄を出さない (PBI-0645)", () => {
  test("AC-1: 欠落値を出さない —— owner を返さない server でも `undefined` が出ない", async () => {
    const out = await run(["work", "list"]);
    expect(out).toContain("Fix duplicate charge");
    expect(out).not.toContain("undefined");
  }, 30_000);

  test("AC-2/AC-5: 既定は短い id・epoch は出ない / --verbose で両方出る", async () => {
    const quiet = await run(["work", "list"]);
    expect(quiet).not.toMatch(RAW_ID);
    expect(quiet).not.toContain("epoch");
    const loud = await run(["work", "list", "--verbose"]);
    expect(loud).toContain(WORK.id);
    expect(loud).toContain("epoch");
  }, 30_000);

  test("AC-3: events の既定は意味のある行だけ・伏せた数を言う / --all で全部", async () => {
    const quiet = await run(["work", "events", WORK.id]);
    expect(quiet).toContain("proof_added");
    expect(quiet).not.toContain("orchestration");
    expect(quiet).toContain("10 routine hidden");
    // 見出し + 1 行 = 2 行（11 行の中で主役が埋もれない）
    expect(quiet.trim().split("\n")).toHaveLength(2);
    const all = await run(["work", "events", WORK.id, "--all"]);
    expect(all).toContain("orchestration");
    expect(all.trim().split("\n")).toHaveLength(12);
  }, 30_000);

  test("AC-1: 知らない数を 0 と偽らない —— `- passed` も `0 passed` も出さない", async () => {
    const out = await run(["work", "events", WORK.id]);
    expect(out).toContain("passed"); // status: passed は出る
    expect(out).not.toContain("- passed");
    expect(out).not.toContain("0 passed / 0 failed");
  }, 30_000);

  test("AC-4: 1 行が端末幅を超えない(折り返して 2 行にならない)", async () => {
    const out = await run(["work", "list"]);
    const width = Math.max(40, Number(process.stdout.columns) || 100);
    for (const line of out.trim().split("\n")) expect(line.length).toBeLessThanOrEqual(width);
  }, 30_000);
});
