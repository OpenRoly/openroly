// PBI-0766 / CAP-3(dogfood F72 / F76 / F77): **端末で運転している人の面**を測る。
// server の口も schema も変えていないので、ここで測るのは CLI の出力と、CLI が書いた値が
// 索引→ CAS →読み戻しの 1 周を回る事だけ(server は stub・list-default-0762.test.ts と同じ型)。
// F74(continue が渡す前に名乗る)は本物の server が要るので continue.test.ts 側で測る。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

const MINE = "account:acc_1";
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const work = (id: string, status: string, title: string, updatedDaysAgo: number, lease: string | null = null) => ({
  id: "wrk_" + id.repeat(32).slice(0, 32),
  status,
  title,
  lease_holder_run: lease,
  lease_epoch: 1,
  owner: MINE,
  created_at: day(90),
  updated_at: day(updatedDaysAgo),
});

const WORKS = [
  work("a", "done", "finished probe", 1),
  work("b", "todo", "dogfood F19 probe", 30), // 触られていない todo = 残骸(F72)
  work("c", "todo", "dogfood F21 probe", 8),
  work("d", "todo", "ship the operator CLI", 0), // 今日触った todo は残す
  work("e", "todo", "held by a runtime", 40, "run-1"), // 誰かが持っている = 伏せない
];

/** PUT /context が受けた entries(AC-X1 の「投げない」を数える) */
const puts: { workId: string; entries: { key: string; kind: string; value_hash: string; size: number }[] }[] = [];
/** work id → key → 索引の行(PUT した物をそのまま GET に返す = 値は端末の CAS から開く) */
const store = new Map<string, Map<string, Record<string, unknown>>>();

const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/v1/works") return Response.json(WORKS);
    if (path === "/v1/whoami") {
      return Response.json({ account_id: "acc_1", agent_id: "agt_1", handle: "aya", display_name: "Aya", unread: 2 });
    }
    if (path === "/v1/inbox") {
      // bucket=inbox に 2 本(片方だけ未読 2)、requests は空
      return url.searchParams.get("bucket") === "inbox"
        ? Response.json([
            { id: "thr_1", peer_display: "Mari", unread: 2, last_message: { id: "msg_1" } },
            { id: "thr_2", peer_display: "the guild", unread: 0, last_message: { id: "msg_2" } },
          ])
        : Response.json([]);
    }
    const ctx = path.match(/^\/v1\/works\/([^/]+)\/context$/);
    if (ctx) {
      const workId = decodeURIComponent(ctx[1]!);
      const rows = store.get(workId) ?? new Map();
      if (req.method === "PUT") {
        const body = (await req.json()) as { entries: { key: string; kind: string; value_hash: string; size: number }[] };
        puts.push({ workId, entries: body.entries });
        const written = body.entries.map((e) => {
          const version = Number((rows.get(e.key)?.version as number | undefined) ?? 0) + 1;
          const row = { ...e, version, run_id: null, runtime_id: null, actor: "human", updated_at: new Date().toISOString() };
          rows.set(e.key, row);
          return row;
        });
        store.set(workId, rows);
        return Response.json({ entries: written });
      }
      return Response.json({ entries: [...rows.values()] });
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${stub.port}`;

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-0766-"));
});
afterAll(async () => {
  stub.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function seed(name: string): Promise<string> {
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "credentials.json"),
    JSON.stringify({
      version: 1,
      runtimes: {
        claude: { runtime_id: "rt_claude", kind: "claude", name: "claude box", token: "par_0766", base_url: BASE, paired_at: new Date().toISOString() },
      },
    }),
  );
  return home;
}

async function run(home: string, args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, HOME: home, OPENROLY_HOME: home, OPENROLY_BROKER_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
}

describe("work list の既定は「触られていない todo」も伏せる(dogfood F72)", () => {
  test("AC-3 / AC-4: 30 日前の todo は伏せ、今日の todo と lease 持ちは残し、軸ごとに数える", async () => {
    const home = await seed("list-1");
    const r = await run(home, ["work", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ship the operator CLI");
    expect(r.stdout).toContain("held by a runtime");
    expect(r.stdout).not.toContain("dogfood F19 probe");
    expect(r.stdout).not.toContain("dogfood F21 probe");
    expect(r.stdout).not.toContain("finished probe");
    expect(r.stdout).toContain("… 1 done, 2 untouched hidden — --all");
    expect(r.stdout).toContain("@aya · 2 works");
  }, 30_000);

  test("AC-5: --all と --json は全件出す(機械と明示指定は絞らない)", async () => {
    const home = await seed("list-2");
    const all = await run(home, ["work", "list", "--all"]);
    for (const w of WORKS) expect(all.stdout).toContain(w.title);
    expect(all.stdout).not.toContain("hidden");
    const json = await run(home, ["work", "list", "--json"]);
    expect(JSON.parse(json.stdout).data.works).toHaveLength(WORKS.length);
  }, 30_000);
});

describe("inbox は未読を指せる(dogfood F76)", () => {
  test("AC-6: 未読行にだけ印・見出しの数字は status の Unread と同じ", async () => {
    const home = await seed("inbox-1");
    const r = await run(home, ["inbox"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 items (2 unread)");
    const mari = r.stdout.split("\n").find((l) => l.includes("Mari"))!;
    const guild = r.stdout.split("\n").find((l) => l.includes("the guild"))!;
    expect(mari).toContain("●");
    expect(guild).not.toContain("●");
  }, 30_000);

  test("AC-7: --json の item が unread を持つ", async () => {
    const home = await seed("inbox-2");
    const r = await run(home, ["inbox", "--json"]);
    const items = JSON.parse(r.stdout).data.items as { title: string; unread: number }[];
    expect(items.find((i) => i.title === "Mari")!.unread).toBe(2);
    expect(items.find((i) => i.title === "the guild")!.unread).toBe(0);
  }, 30_000);
});

describe("端末から次の一手を置ける(dogfood F77)", () => {
  test("AC-8: work context set で書いた next_step が work context で読み戻せる", async () => {
    const home = await seed("ctx-1");
    const id = WORKS[3]!.id;
    const set = await run(home, ["work", "context", "set", id, "--set", "next_step=run the smoke"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("OK next_step v1");
    const read = await run(home, ["work", "context", id]);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("next_step");
    expect(read.stdout).toContain("run the smoke");
  }, 30_000);

  test("AC-9 / AC-X1: 予約 prefix と --set 無しは書かずに落ちる", async () => {
    const home = await seed("ctx-2");
    const id = WORKS[3]!.id;
    const before = puts.length;
    const reserved = await run(home, ["work", "context", "set", id, "--set", "brief/done=x"]);
    expect(reserved.code).not.toBe(0);
    expect(reserved.stderr).toContain("reserved key");
    const empty = await run(home, ["work", "context", "set", id]);
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("Usage:");
    expect(puts.length).toBe(before); // PUT を 1 回も投げていない
  }, 30_000);

  test("AC-X2: --json は stdout 全体が 1 つの JSON", async () => {
    const home = await seed("ctx-3");
    const id = WORKS[4]!.id;
    const r = await run(home, ["work", "context", "set", id, "--set", "next_step=json", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.data.entries[0].key).toBe("next_step");
  }, 30_000);
});
