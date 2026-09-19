// PBI-0762 / CAP-3(dogfood F67 / F70): **一覧の既定**を測る。
// 実測(2026-09-18 夜): `work list` が 13 行・`status` が 26 runtime を 26 行で、今やる事と異常が
// どちらも埋もれた。server の口も filter も変えていないので、ここで測るのは **CLI の出力の既定**だけ
// —— server は stub、`ps` は PATH の先頭で差し替える(status-running-0631.test.ts と同じ型)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

const MINE = "account:acc_1";
const WORKS = [
  { id: "wrk_" + "a".repeat(32), status: "done", title: "dogfood F52 wake", lease_holder_run: null, lease_epoch: 1, owner: MINE },
  { id: "wrk_" + "b".repeat(32), status: "done", title: "dogfood F21 probe", lease_holder_run: null, lease_epoch: 1, owner: MINE },
  { id: "wrk_" + "c".repeat(32), status: "done", title: "dogfood F19 probe", lease_holder_run: null, lease_epoch: 1, owner: MINE },
  { id: "wrk_" + "d".repeat(32), status: "todo", title: "ship the operator CLI", lease_holder_run: null, lease_epoch: 1, owner: MINE },
  // PBI-0764 AC-5: 他 account 由来の owner を持つ行(ここだけ owner が出る)
  { id: "wrk_" + "e".repeat(32), status: "todo", title: "review from the guild", lease_holder_run: null, lease_epoch: 1, owner: "account:acc_zz" },
];

const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/works") return Response.json(WORKS);
    if (path === "/v1/whoami") return Response.json({ account_id: "acc_1", agent_id: "agt_1", handle: "aya", display_name: "Aya", unread: 0 });
    if (path === "/v1/inbox/messages") return Response.json([]);
    if (path === "/v1/inbox") return Response.json([]);
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${stub.port}`;
/** 誰も listen していない port。fetchBrief が throw して runtime 行が NG になる */
const DEAD = "http://127.0.0.1:1";

let root = "";
let bin = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-0762-"));
  bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // `ps -A` は 1 件も返さない = この機械で AI は走っていない(「動いている物」を固定する)
  await writeFile(join(bin, "ps"), '#!/bin/sh\ncase "$*" in\n  *-A*) exit 0 ;;\n  *) exit 1 ;;\nesac\n');
  await chmod(join(bin, "ps"), 0o755);
});
afterAll(async () => {
  stub.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function seed(name: string, runtimes: Record<string, string>): Promise<string> {
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "credentials.json"),
    JSON.stringify({
      version: 1,
      runtimes: Object.fromEntries(
        Object.entries(runtimes).map(([kind, base]) => [
          kind,
          { runtime_id: `rt_${kind}`, kind, name: `${kind} box`, token: "par_0762", base_url: base, paired_at: new Date().toISOString() },
        ]),
      ),
    }),
  );
  return home;
}

async function run(home: string, args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, OPENROLY_HOME: home, OPENROLY_BROKER_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
}

describe("work list の既定(dogfood F67)", () => {
  test("AC-1: 終わった物は伏せ、伏せた数を 1 行で言う", async () => {
    const home = await seed("list-1", { claude: BASE });
    const r = await run(home, ["work", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ship the operator CLI");
    expect(r.stdout).not.toContain("dogfood F52 wake");
    expect(r.stdout).toContain("… 3 done hidden — --all");
    expect(r.stdout).toContain("@aya · 2 works");
  }, 30_000);

  test("AC-2: --all は 4 件とも出し、伏せた数の行を出さない", async () => {
    const home = await seed("list-2", { claude: BASE });
    const r = await run(home, ["work", "list", "--all"]);
    expect(r.code).toBe(0);
    for (const w of WORKS) expect(r.stdout).toContain(w.title);
    expect(r.stdout).not.toContain("done hidden");
  }, 30_000);

  test("AC-3: --json は機械向けなので 4 件とも運ぶ", async () => {
    const home = await seed("list-3", { claude: BASE });
    const r = await run(home, ["work", "list", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data.works).toHaveLength(5);
  }, 30_000);
});

describe("status の attached 一覧の既定(dogfood F70)", () => {
  test("AC-6: NG と動いている物だけ出し、伏せた数を言う", async () => {
    const home = await seed("st-1", { claude: BASE, codex: DEAD });
    const r = await run(home, ["status"]);
    expect(r.code).toBe(0);
    const attached = r.stdout.split("[Attached runtimes]")[1]!.split("[Live sessions]")[0]!;
    expect(attached).toContain("codex box");
    expect(attached).not.toContain("claude box");
    expect(attached).toContain("… 1 more attached — --all");
  }, 30_000);

  test("AC-7: --all は 2 行とも出す", async () => {
    const home = await seed("st-2", { claude: BASE, codex: DEAD });
    const r = await run(home, ["status", "--all"]);
    const attached = r.stdout.split("[Attached runtimes]")[1]!.split("[Live sessions]")[0]!;
    expect(attached).toContain("claude box");
    expect(attached).toContain("codex box");
    expect(attached).not.toContain("more attached");
  }, 30_000);

  test("AC-8: NG も稼働も無ければ全部出す(節を空にしない)", async () => {
    const home = await seed("st-3", { claude: BASE });
    const r = await run(home, ["status"]);
    const attached = r.stdout.split("[Attached runtimes]")[1]!.split("[Live sessions]")[0]!;
    expect(attached).toContain("claude box");
    expect(attached).not.toContain("more attached");
  }, 30_000);

  test("AC-9: 同じ error が並ぶ時は 1 行に畳む(500 で 26 行とも同じ NG を出さない)", async () => {
    const home = await seed("st-4", { claude: DEAD, codex: DEAD, opencode: DEAD });
    const r = await run(home, ["status"]);
    const attached = r.stdout.split("[Attached runtimes]")[1]!.split("[Live sessions]")[0]!;
    expect(attached.split("\n").filter((l) => l.includes("NG "))).toHaveLength(1);
    expect(attached).toContain("… 2 more with the same error — --all");
  }, 30_000);
});

describe("黙って嘘をつかない(PBI-0764 / dogfood F78・F79)", () => {
  test("AC-4 / AC-5: 自分の account の行に owner 列を出さず、他 account の行にだけ出す", async () => {
    const home = await seed("own-1", { claude: BASE });
    const r = await run(home, ["work", "list"]);
    const mine = r.stdout.split("\n").find((l) => l.includes("ship the operator CLI"))!;
    const theirs = r.stdout.split("\n").find((l) => l.includes("review from the guild"))!;
    expect(mine).not.toContain("account:");
    expect(theirs).toContain("account:acc_zz");
  }, 30_000);

  test("AC-1 / AC-2 / AC-X1: whoami と inbox の --json が stdout 全体で 1 つの JSON になる", async () => {
    const home = await seed("json-1", { claude: BASE });
    const who = await run(home, ["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout).data.handle).toBe("aya");
    const inbox = await run(home, ["inbox", "--json"]);
    expect(inbox.code).toBe(0);
    expect(JSON.parse(inbox.stdout).ok).toBe(true);
    // 既定(flag 無し)は人間向けのまま
    expect((await run(home, ["whoami"])).stdout).toContain("@aya");
  }, 30_000);
});
