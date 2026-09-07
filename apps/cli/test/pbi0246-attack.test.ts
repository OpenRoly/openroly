import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAccountUrl } from "@openroly/adapter";

// PBI-0246 レビュー(有界)の攻撃 test —— CLI 面。
//
// 撃つのは 3 つ:
//  ① **一度きりの明示が account の既定を書き換えないか**(`--url` で別 server を 1 回叩いただけで
//     以後の全 command の行き先が変わったら、AC-3 の「明示が勝つ」が罠になる)
//  ② **失敗した login が account の既定を壊さないか**(繋がらなかった URL を既定にすると、
//     次の command も同じ場所で死ぬ = 人が前に進めない)
//  ③ **手で壊れた account_url でも「その値を名乗って」失敗するか**(既定へ黙って落ちると、
//     2026-09-04 の gate で穴に気づけた唯一の手掛かりが消える)

const CLI = join(import.meta.dir, "../src/openroly.ts");
const DEAD_URL = "http://127.0.0.1:1";

function fakeAccount(handle: string) {
  const state = { pairStarts: 0, adminCalls: 0, adminAuth: [] as string[] };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/pair/start") {
        state.pairStarts++;
        return Response.json(
          {
            device_code: `pdc_${handle}`,
            user_code: "ATCK6789",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            expires_in: 60,
            interval: 0,
            verification_uri: "http://localhost:5173/connect",
          },
          { status: 201 },
        );
      }
      if (path === "/v1/pair/claim") {
        return Response.json({ status: "approved", token: `par_${handle}`, runtime_id: `rt_${handle}` });
      }
      if (path === "/v1/whoami") {
        return Response.json({
          agent_id: `agt_${handle}`,
          handle,
          display_name: handle,
          unread: 0,
          actor: { kind: "runtime", runtime_id: `rt_${handle}` },
        });
      }
      if (path === "/v1/admin/sessions") {
        state.adminCalls++;
        // **どの host に admin token が届いたか**を記録する。行き先を間違えると運営の鍵が漏れる
        state.adminAuth.push(req.headers.get("authorization") ?? "");
        return Response.json({ handle, token: `sess_${handle}` });
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

const root = await mkdtemp(join(tmpdir(), "openroly-0246-attack-cli-"));

beforeEach(() => {
  for (const s of [account.state, other.state]) {
    s.pairStarts = 0;
    s.adminCalls = 0;
    s.adminAuth.length = 0;
  }
});

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
    OPENROLY_BINARY_BASE_URL: DEAD_URL,
  };
}

async function openroly(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const readStore = async (env: Record<string, string>) =>
  JSON.parse(await readFile(join(env.OPENROLY_HOME!, "credentials.json"), "utf8"));

/** login は broker を起こすので、即終了の偽 binary と必ず失敗する launchctl を渡す */
async function withFakeBroker(env: Record<string, string>): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(root, "broker-"));
  const bin = join(dir, "openroly-broker-fake");
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
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

describe("PBI-0246 攻撃(CLI)", () => {
  test("攻撃 7: 一度きりの `--url` は account の既定を書き換えない", async () => {
    const env = await freshHome();
    await saveAccountUrl(account.base, env);

    // 明示は勝つ(AC-3)——が、それは **この 1 回だけ**でなければならない
    const once = await openroly(["pair", "claude", "--url", other.base], env);
    expect(once.code).toBe(0);
    expect(other.state.pairStarts).toBe(1);
    expect((await readStore(env)).account_url).toBe(account.base);

    // 次の command は account の既定に戻る
    const back = await openroly(["doctor", "codex"], env);
    expect(back.out).toContain(`it will connect to ${account.base}`);
    expect(back.out).not.toContain(other.base);
  }, 120_000);

  test("攻撃 8: 失敗した login は account の既定を壊さない", async () => {
    const env = await withFakeBroker(await freshHome());
    await saveAccountUrl(account.base, env);

    const failed = await openroly(["login", "--url", DEAD_URL], env);

    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain(`cannot connect to ${DEAD_URL}`);
    // 繋がらなかった URL を既定にすると、次の command も同じ場所で死ぬ
    expect((await readStore(env)).account_url).toBe(account.base);
  }, 120_000);

  test("攻撃 9: 手で壊された account_url でも **その値を名乗って** 失敗する(既定に落ちない)", async () => {
    const env = await freshHome();
    // scheme を落とした手編集。「無い」扱い(= 既定へ)にすると localhost で死んで理由が消える
    await mkdir(env.OPENROLY_HOME!, { recursive: true });
    await writeFile(
      join(env.OPENROLY_HOME!, "credentials.json"),
      `${JSON.stringify({ version: 1, account_url: "atn.shibubu.ai", runtimes: {} }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const r = await openroly(["pair", "claude"], env);

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("atn.shibubu.ai");
    expect(r.err).not.toContain("localhost:8787");
    // 生の stack trace ではなく 1 行の NG(PBI-0046 レビュー AC-X2 と同じ規律)
    expect(r.err).toContain("NG pairing failed");
  }, 120_000);

  test("攻撃 10: `admin recover` の運営 token は account の URL にだけ届き、明示が勝つ", async () => {
    const env = await freshHome();
    await saveAccountUrl(account.base, env);
    const withToken = { ...env, OPENROLY_ADMIN_TOKEN: "adm_secret" };

    // 既定は account 側(旧 `?? DEFAULT_BASE_URL` なら localhost へ行って ConnectionRefused)
    const def = await openroly(["admin", "recover", "shibu"], withToken);
    expect(def.code).toBe(0);
    expect(account.state.adminCalls).toBe(1);
    expect(other.state.adminCalls).toBe(0);
    expect(account.state.adminAuth).toEqual(["Bearer adm_secret"]);
    // 案内文の URL も実際に叩いた先と同じ(名乗る先と繋ぐ先を割らない)
    expect(def.out).toContain(`Sign in (${account.base})`);

    // 明示が勝つ。**account 側には 1 通も漏れない**
    account.state.adminCalls = 0;
    account.state.adminAuth.length = 0;
    const explicit = await openroly(["admin", "recover", "shibu", "--url", other.base], withToken);
    expect(explicit.code).toBe(0);
    expect(other.state.adminCalls).toBe(1);
    expect(account.state.adminCalls).toBe(0);
    expect(account.state.adminAuth).toEqual([]);
  }, 120_000);
});
