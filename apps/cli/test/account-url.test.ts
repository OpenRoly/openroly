import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAccountUrl, saveCredential } from "@openroly/adapter";

// PBI-0246 AC-1〜4 / X1: `openroly login` で決めた server の URL を、以後の全 command が既定にする。
//
// 観測面は **どの server に pair/start が届いたか**(行き先そのもの)と、
// **完了表示が名乗った @handle**(reportConnected の whoami が同じ server に行ったか)の 2 つ。
// 前者だけだと「繋ぐ先は直ったが名乗る先は別 server」を見逃す —— 2 台の fake server に
// 違う handle を返させて、行き先と名乗り先が割れていない事まで 1 つの test で押さえる。

const CLI = join(import.meta.dir, "../src/openroly.ts");

/** 到達不能な行き先(AC-X1)。port 1 は予約済みで即 ConnectionRefused になる */
const DEAD_URL = "http://127.0.0.1:1";

function fakeAccount(handle: string) {
  const state = { pairStarts: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/pair/start") {
        state.pairStarts++;
        return Response.json(
          {
            device_code: `pdc_${handle}`,
            user_code: "URLS2345",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            expires_in: 60,
            // interval:0 —— 承認済みから始まるので 1 回目の claim で決まる
            interval: 0,
            // PBI-0237 以降、code は URL に載らない(`verification_uri_complete` は無い)
            verification_uri: "http://localhost:5173/connect",
          },
          { status: 201 },
        );
      }
      if (path === "/v1/pair/claim") {
        return Response.json({
          status: "approved",
          token: `par_${handle}`,
          runtime_id: `rt_${handle}`,
        });
      }
      if (path === "/v1/whoami") {
        // 失効した token(2 度目の login の再現)には 401 —— 有効な token と同じ 200 を返すと
        // 「credential が生きている」扱いで再 pair 自体が起きない
        if (req.headers.get("authorization") === "Bearer stale") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({
          agent_id: `agt_${handle}`,
          handle,
          display_name: handle,
          unread: 0,
          actor: { kind: "runtime", runtime_id: `rt_${handle}` },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { state, server, base: `http://localhost:${server.port}` };
}

const account = fakeAccount("account");
const other = fakeAccount("other");
afterAll(() => {
  account.server.stop(true);
  other.server.stop(true);
});

const root = await mkdtemp(join(tmpdir(), "openroly-account-url-"));
afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(() => {
  account.state.pairStarts = 0;
  other.state.pairStarts = 0;
});

/** 隔離した HOME / OPENROLY_HOME。**OPENROLY_URL は入れない** —— 入れると account_url の面が測れない */
async function freshHome(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(root, "case-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    OPENROLY_HOME: join(home, ".openroly"),
    OPENROLY_BROKER_HOME: join(dir, "broker-home"),
    OPENROLY_NO_BROWSER: "1",
    CI: "1",
    // 公開 Release を叩かせない(誰も listen していない port)
    OPENROLY_BINARY_BASE_URL: DEAD_URL,
  };
}

async function openroly(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const readStore = async (env: Record<string, string>) =>
  JSON.parse(await readFile(join(env.OPENROLY_HOME!, "credentials.json"), "utf8"));

describe("PBI-0246: 全 command が account の URL を継ぐ", () => {
  test("AC-1: login で決めた URL に `pair` が行く(localhost に落ちない)", async () => {
    const env = await freshHome();
    await saveAccountUrl(account.base, env);

    const r = await openroly(["pair", "claude"], env);

    expect(r.code).toBe(0);
    expect(account.state.pairStarts).toBe(1);
    expect(other.state.pairStarts).toBe(0);
    // 名乗る先(whoami)も同じ server —— 繋ぐ先だけ直して名乗る先が残るのが最悪
    expect(r.out).toContain("is now connected to @account");
    expect((await readStore(env)).runtimes.claude.base_url).toBe(account.base);
  }, 30_000);

  test("AC-3: `--url` の明示は account の既定に勝つ(別 server へ繋ぎ替えられる)", async () => {
    const env = await freshHome();
    await saveAccountUrl(account.base, env);

    const r = await openroly(["pair", "claude", "--url", other.base], env);

    expect(r.code).toBe(0);
    expect(other.state.pairStarts).toBe(1);
    expect(account.state.pairStarts).toBe(0);
    expect(r.out).toContain("is now connected to @other");
  }, 30_000);

  test("AC-3: `$OPENROLY_URL` の明示も account の既定に勝つ", async () => {
    const env = await freshHome();
    await saveAccountUrl(account.base, env);

    const r = await openroly(["pair", "claude"], { ...env, OPENROLY_URL: other.base });

    expect(r.code).toBe(0);
    expect(other.state.pairStarts).toBe(1);
    expect(account.state.pairStarts).toBe(0);
  }, 30_000);

  test("AC-4: login していない端末は $OPENROLY_URL に行く(今までと同じ)", async () => {
    const env = await freshHome();

    const r = await openroly(["pair", "claude"], { ...env, OPENROLY_URL: other.base });

    expect(r.code).toBe(0);
    expect(other.state.pairStarts).toBe(1);
    expect((await readStore(env)).account_url).toBeUndefined();
  }, 30_000);

  test("AC-X1: 繋がらない時は **行き先の URL を名乗って** 失敗する", async () => {
    const env = await freshHome();
    await saveAccountUrl(DEAD_URL, env);

    const r = await openroly(["pair", "claude"], env);

    expect(r.code).not.toBe(0);
    // この 1 行が、2026-09-04 の gate 実測で穴に気づけた唯一の手掛かりだった
    expect(r.err).toContain(`cannot connect to ${DEAD_URL}`);
    // 既定値へ黙って落ちていない
    expect(r.err).not.toContain("localhost:8787");
  }, 60_000);

  test("AC-2: `doctor` は未 pair の runtime にも行き先の URL を名乗る", async () => {
    const env = await freshHome();
    await saveAccountUrl(account.base, env);

    const r = await openroly(["doctor", "claude"], env);

    expect(r.out).toContain(`it will connect to ${account.base}`);
    expect(r.out).not.toContain("localhost:8787");
  }, 30_000);
});

describe("PBI-0246: login が URL を account の既定として書き戻す", () => {
  /** fake broker binary。login は spawn するだけなので即終了で足りる */
  async function withFakeBroker(env: Record<string, string>): Promise<Record<string, string>> {
    const dir = await mkdtemp(join(root, "broker-"));
    const bin = join(dir, "openroly-broker-fake");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    // launchctl を必ず失敗させて detached fallback を通す(login.test.ts と同じ手)
    const launchctl = join(dir, "launchctl-fake");
    await writeFile(launchctl, "#!/bin/sh\nexit 1\n");
    await chmod(launchctl, 0o755);
    return {
      ...env,
      OPENROLY_BROKER_BIN: bin,
      OPENROLY_LAUNCHCTL: launchctl,
      OPENROLY_LAUNCH_AGENTS_DIR: join(dir, "launch-agents"),
    };
  }

  test("AC-1 前段 / AC-X2: `login --url` が account_url を 0600 の file に書き、次の pair がそれを継ぐ", async () => {
    const env = await withFakeBroker(await freshHome());

    const login = await openroly(["login", "--url", `${account.base}/`], env);
    expect(login.code).toBe(0);
    expect(login.out).toContain("This machine is now connected to @account");

    // 末尾の `/` は 1 箇所で落とす(保存された綴りが 2 通りにならない)
    expect((await readStore(env)).account_url).toBe(account.base);
    // URL 自体は秘密ではないが、token と同じ file に置く以上は同じ規律(AC-X2)
    expect(statSync(join(env.OPENROLY_HOME!, "credentials.json")).mode & 0o777).toBe(0o600);

    // README の quickstart の 5 行目 —— ここが localhost に落ちていた
    account.state.pairStarts = 0;
    const pair = await openroly(["pair", "claude"], env);
    expect(pair.code).toBe(0);
    expect(account.state.pairStarts).toBe(1);
    expect(other.state.pairStarts).toBe(0);
    // CLI process を 2 本立てて pairing を 2 往復するので上限は広く取る
    // (他の並列 session と同じ機械で走る前提。狭いと機械の混み具合で赤くなる)
  }, 180_000);

  test("2 度目の login: account_url を持たない端末で credential が失効しても、前回の server へ戻る(localhost に落ちない)", async () => {
    const env = await withFakeBroker(await freshHome());
    // PBI-0246 より前に login した端末の写し: credential は有るが account_url は無い。token は失効済み
    await saveCredential("broker", { runtime_id: "rt_old", token: "stale", base_url: account.base, name: "old laptop", paired_at: new Date(0).toISOString() }, env);

    const r = await openroly(["login"], env);

    expect(r.code).toBe(0);
    // 失効した credential を消した後も、その base_url が行き先として残る
    expect(account.state.pairStarts).toBe(1);
    expect(other.state.pairStarts).toBe(0);
    expect(r.out).toContain("This machine is now connected to @account");
    expect(r.err).not.toContain("localhost:8787");
    expect((await readStore(env)).account_url).toBe(account.base);
  }, 180_000);

  test("AC-X2: 前回の server が落ちていても、その URL を名乗って失敗する(localhost へ黙って落ちない)", async () => {
    const env = await withFakeBroker(await freshHome());
    await saveCredential("broker", { runtime_id: "rt_old", token: "stale", base_url: DEAD_URL, name: "old laptop", paired_at: new Date(0).toISOString() }, env);

    const r = await openroly(["login"], env);

    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`cannot connect to ${DEAD_URL}`);
    expect(r.err).not.toContain("localhost:8787");
    expect(account.state.pairStarts).toBe(0);
    expect(other.state.pairStarts).toBe(0);
  }, 60_000);
});
