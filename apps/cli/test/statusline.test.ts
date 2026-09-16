import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// PBI-0130: Claude Code の statusline に未読を出す。
//  - `openroly statusline --refresh` が cache を atomic に更新する(AC-4)
//  - 引数なしは cache を読むだけ(HTTP を叩かない・AC-5)
//  - server 断でも既存 cache を壊さない(AC-X2)
//  - statusline.sh は cache が新鮮なら bun を起こさない(AC-6)、無ければ空 + exit 0(AC-7/X3)

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));
const SH = fileURLToPath(new URL("../../../adapters/official/claude/statusline.sh", import.meta.url));

let hits = 0;
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    hits += 1;
    if (path === "/v1/whoami") {
      return Response.json({
        agent_id: "agt_x",
        handle: "aya",
        display_name: "Aya",
        unread: 3,
        actor: { kind: "runtime", runtime_id: "rt_1" },
      });
    }
    if (path === "/v1/inbox/messages") {
      return Response.json([
        { id: "msg_1", sender_display: "Shibu", bucket: "inbox", read: false },
        { id: "msg_2", sender_display: "Unknown", bucket: "requests", read: false },
      ]);
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => stub.stop(true));

async function run(cmd: string[], env: Record<string, string>) {
  const proc = Bun.spawn(cmd, {
    // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

/** credential 済みの OPENROLY_HOME を 1 つ作る */
async function setupHome(baseUrl: string) {
  const home = await mkdtemp(join(tmpdir(), "openroly-statusline-"));
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_1",
      token: "par_x",
      base_url: baseUrl,
      name: "test",
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home } as any,
  );
  return home;
}

describe("PBI-0130 openroly statusline", () => {
  test("AC-4: --refresh が未読件数の segment を出し、cache に同じ内容を書く", async () => {
    const home = await setupHome(`http://localhost:${stub.port}`);
    const res = await run(["bun", CLI, "statusline", "--refresh"], { OPENROLY_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("📬3");
    expect(res.stdout).toContain("+1"); // requests bucket の 1 件
    const cache = await readFile(join(home, "statusline"), "utf8");
    expect(cache).toBe(res.stdout.trimEnd());
    expect(cache.endsWith("\n")).toBe(false); // 1 行にそのまま載る形
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-5 / AC-X1: 引数なしは cache を読むだけ(HTTP 0 回・本文も sender も出さない)", async () => {
    const home = await setupHome(`http://localhost:${stub.port}`);
    await run(["bun", CLI, "statusline", "--refresh"], { OPENROLY_HOME: home });
    const before = hits;
    const res = await run(["bun", CLI, "statusline"], { OPENROLY_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(hits).toBe(before);
    expect(res.stdout).toContain("📬3");
    for (const leak of ["Shibu", "Unknown", "aya", "Aya", "msg_"]) {
      expect(res.stdout).not.toContain(leak);
    }
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X2: server 断でも既存 cache を消さない・上書きしない", async () => {
    const home = await setupHome("http://127.0.0.1:1"); // 誰も listen していない
    await writeFile(join(home, "statusline"), "OLD");
    const res = await run(["bun", CLI, "statusline", "--refresh"], { OPENROLY_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(await readFile(join(home, "statusline"), "utf8")).toBe("OLD");
    await rm(home, { recursive: true, force: true });
  }, 30_000);
});

describe("PBI-0130 statusline.sh", () => {
  test("AC-6: cache が新鮮なら中身を出して bun を起こさない", async () => {
    const home = await setupHome(`http://localhost:${stub.port}`);
    await writeFile(join(home, "statusline"), "FRESH");
    await writeFile(join(home, "statusline.at"), "");
    const before = hits;
    const res = await run(["bash", SH], { OPENROLY_HOME: home, OPENROLY_STATUSLINE_TTL: "600" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("FRESH");
    expect(hits).toBe(before);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-7: cache が無ければ出力は空・exit 0(背景更新の印だけ残る)", async () => {
    const home = await setupHome(`http://localhost:${stub.port}`);
    const res = await run(["bash", SH], { OPENROLY_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(await readFile(join(home, "statusline.at"), "utf8")).toBe("");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X3: credential が無ければ何も出さず exit 0(error を statusline に出さない)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-statusline-bare-"));
    const res = await run(["bash", SH], { OPENROLY_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  // ---- 攻撃(順58 review)----
  // AC-6/AC-7 は「cache が在れば出す」「無ければ空で終わる」しか見ていない。だが本 PBI の
  // 機能そのものは **背景に投げた refresh が実際に cache を作り、次の render で出る** 事で、
  // そこは 1 本も通っていない(spawn の path が壊れても・bun が repo を解決できなくても
  // 既存 6 本は全部緑のまま = 未読が永遠に出ない statusline を緑と呼べてしまう)。
  test("攻撃: cache 無しから叩くと背景更新が実際に cache を作り、次の render で出る", async () => {
    const home = await setupHome(`http://localhost:${stub.port}`);
    const first = await run(["bash", SH], { OPENROLY_HOME: home });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(""); // 前景では待たない

    const cachePath = join(home, "statusline");
    let cache = "";
    for (let i = 0; i < 150 && !cache; i++) {
      cache = await readFile(cachePath, "utf8").catch(() => "");
      if (!cache) await Bun.sleep(200);
    }
    expect(cache).toContain("\u{1F4EC}3"); // 背景の refresh が届いた

    // 次の render は cat するだけ(TTL 内なので bun を起こさない)
    const before = hits;
    const second = await run(["bash", SH], { OPENROLY_HOME: home });
    expect(second.stdout).toBe(cache);
    expect(hits).toBe(before);
    await rm(home, { recursive: true, force: true });
  }, 60_000);
});
