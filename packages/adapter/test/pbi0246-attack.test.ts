import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  getAccountUrl,
  loadCredentials,
  saveAccountUrl,
  saveCredential,
} from "../src/credentials.ts";
import { doctorRuntime, installRuntime, uninstallRuntime } from "../src/install.ts";
import {
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type RegisterInput,
  type RuntimeAdapter,
} from "../src/contract.ts";

// PBI-0246 レビュー(有界)の攻撃 test。
//
// 急所は **「行き先を決める resolver」と「pair し直すかを決める門」がずれていないか**。
// resolver は「account の URL は呼び手の credential より前」と宣言しているのに、門が
// credential だけを見ていると、**その宣言が効かない経路**が残る —— 名乗る先(doctor / 完了表示)と
// 実際に繋ぐ先(register / credential)が割れる形。ここを撃つ。

/** 1 台の fake Account server。pairing も whoami も返す(handle で見分ける) */
function fakeAccount(handle: string) {
  const state = { pairStarts: 0, whoami: 0, live: true };
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/pair/start") {
        state.pairStarts++;
        return Response.json(
          {
            device_code: `pdc_${handle}`,
            user_code: "ATCK2345",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            expires_in: 600,
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
        state.whoami++;
        // live=false は「昔の server が死んだ」= credential が無効になった状態
        if (!state.live) return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({ agent_id: `agt_${handle}`, handle, unread: 0 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { state, server, base: `http://localhost:${server.port}` };
}

const account = fakeAccount("account");
const old = fakeAccount("old");
afterAll(() => {
  account.server.stop(true);
  old.server.stop(true);
});

const registered: RegisterInput[] = [];
const fakeAdapter: RuntimeAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: STAGE0_CAPABILITIES,
  detect: async () => ({ installed: true, detail: "fake 1.0.0" }),
  register: async (_ctx, input) => {
    registered.push(input);
  },
  unregister: async () => {},
  doctor: async () => [{ ok: true, label: "MCP 登録", detail: "あり" }],
  extensionKinds: ["mcp"],
  listExtensions: async () => [],
  applyExtension: async () => {},
  exportExtensions: async () => [],
  watchPaths: () => [],
};
const ctx: AdapterContext = { env: {} };

async function home() {
  return {
    OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-0246-attack-")),
    // 公開 Release を叩かせない(誰も listen していない port)
    OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1",
  };
}

/** 「昔 pair した server」の credential を置く */
async function withOldCredential(env: { OPENROLY_HOME: string }, base: string) {
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_old",
      token: "par_old",
      base_url: base,
      name: "MacBook / Claude Code",
      paired_at: new Date().toISOString(),
    },
    env,
  );
}

const install = (env: { OPENROLY_HOME: string; OPENROLY_BINARY_BASE_URL: string }, baseUrl?: string) =>
  installRuntime({
    adapter: fakeAdapter,
    ctx,
    env,
    ...(baseUrl ? { baseUrl } : {}),
    onPrompt: () => {},
    sleep: async () => {},
    now: () => 0,
  });

describe("PBI-0246 攻撃: 名乗る先と繋ぐ先が割れないか", () => {
  test("攻撃 1: 旧 server の credential が**まだ生きている**時も、install は account の URL へ行く", async () => {
    // 実際に起きる形: dev で localhost に install → `openroly login --url https://atn.shibubu.ai` →
    // `openroly install claude`。旧 server がまだ 200 を返すと、門が credential だけを見ていると
    // 「有効だから pair し直さない」で **旧 server に留まる**。resolver は account の URL を
    // 返しているので、doctor が名乗る先と register が書く先が割れる。
    const env = await home();
    old.state.live = true;
    await withOldCredential(env, old.base);
    await saveAccountUrl(account.base, env);
    account.state.pairStarts = 0;
    registered.length = 0;

    const outcome = await install(env);

    expect(outcome.status).toBe("installed");
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(account.base);
    // runtime の設定に書かれる URL まで account 側でなければ、MCP は旧 server を向いたまま
    expect(registered.at(-1)?.baseUrl).toBe(account.base);
    expect(account.state.pairStarts).toBe(1);
    // 保存された credential も account 側(次の command が読むのはこれ)
    expect((await loadCredentials(env)).runtimes.claude!.base_url).toBe(account.base);
  });

  test("攻撃 2(負の対照): account の URL が無ければ既存 credential を尊重する(AC-16 を壊していない)", async () => {
    // 攻撃 1 の直し方を「無条件に pair し直す」にすると、login していない端末の
    // credential が毎回作り直される。account_url が無い時は今までどおりでなければならない。
    const env = await home();
    old.state.live = true;
    await withOldCredential(env, old.base);
    old.state.pairStarts = 0;
    registered.length = 0;

    const outcome = await install(env);

    expect(outcome.status === "installed" && outcome.paired).toBe(false);
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(old.base);
    expect(registered.at(-1)?.baseUrl).toBe(old.base);
    expect(old.state.pairStarts).toBe(0);
  });

  test("攻撃 3(負の対照): account の URL と credential が同じなら pair し直さない", async () => {
    // account_url を見るようにした事で「毎回 pair し直す」に転ぶと、upgrade 経路(§7.2)が壊れる。
    const env = await home();
    old.state.live = true;
    await withOldCredential(env, old.base);
    await saveAccountUrl(`${old.base}/`, env); // 末尾の / が付いていても同一と見なせるか
    old.state.pairStarts = 0;

    const outcome = await install(env);

    expect(outcome.status === "installed" && outcome.paired).toBe(false);
    expect(old.state.pairStarts).toBe(0);
  });

  test("攻撃 4: doctor が名乗る URL と install が実際に繋ぐ URL は同じ", async () => {
    const env = await home();
    old.state.live = true;
    await withOldCredential(env, old.base);
    await saveAccountUrl(account.base, env);
    registered.length = 0;

    // 未 pair の runtime に doctor が名乗る先(credential が無い面)
    const fresh = await home();
    await saveAccountUrl(account.base, fresh);
    const named = (await doctorRuntime({ adapter: fakeAdapter, ctx, env: fresh })).find(
      (f) => f.label === "credential",
    )!.detail!;

    const outcome = await install(env);
    const connected = outcome.status === "installed" ? outcome.credential.base_url : "";

    expect(named).toContain(connected);
    expect(connected).toBe(account.base);
  });

  test("攻撃 5: uninstall / 別 runtime の pair が account_url を巻き込まない", async () => {
    const env = await home();
    await saveAccountUrl(account.base, env);
    await withOldCredential(env, old.base);

    await uninstallRuntime({ adapter: fakeAdapter, ctx, env });

    expect(await getAccountUrl(env)).toBe(account.base);
    expect(Object.keys((await loadCredentials(env)).runtimes)).toEqual([]);
  });

  test("攻撃 6(AC-X2): 前の版が 0644 で残した file でも、書いた後は 0600 に直る", async () => {
    const env = await home();
    const path = credentialsPath(env);
    await writeFile(path, `${JSON.stringify({ version: 1, runtimes: {} })}\n`);
    await chmod(path, 0o644);

    await saveAccountUrl(account.base, env);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).account_url).toBe(account.base);
  });
});
