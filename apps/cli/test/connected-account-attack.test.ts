import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PBI-0234 の有界レビュー: 「接続したら繋がった先の @account を必ず名乗る」を**破りに行く**。
//
// 本体の検査(connected-account.test.ts)は whoami が 200 / 500 / 401 の 3 通りしか見ていない。
// ここで撃つのは、その 3 通りの隙間で「名乗れていないのに名乗ったように見える」道:
//   攻撃1 handle が空文字の 200      → `connected to @.` = @? と同型の欺瞞
//   攻撃1b handle に改行を混ぜた 200  → 完了表示に**偽の行**を差し込んで別 account を名乗らせる
//   攻撃2 200 だが JSON でない        → body が null になる経路
//   攻撃3 応答本文が永久に来ない      → 「上限を持つ」(決め事 3)が grep でしか測られていない
//   攻撃4 credential 再利用の install → pairing を通らない道で名乗りが消えていないか
//   攻撃5 名乗る先と繋ぐ先(PBI-0246) → @handle を引いた server と credential に書く server の一致

const CLI = join(import.meta.dir, "../src/openroly.ts");

type WhoamiMode = "ok" | "empty_handle" | "injected_handle" | "not_json" | "hang";
/** server A の whoami の振る舞い。攻撃ごとに倒す */
let whoamiMode: WhoamiMode = "ok";

/** hang 用。test が終わる時に afterAll が解放する(タイマーを残さない) */
const releaseHeld: Array<() => void> = [];
const heldForever = () => new Promise<void>((r) => releaseHeld.push(r));

function makeServer(handle: string, mutable: boolean) {
  let counter = 0;
  const tokens = new Map<string, string>();
  return Bun.serve({
    port: 0,
    // **server 側から切らない**(Bun の既定は 10 秒)。切ると「CLI の上限が効いた」のか
    // 「server が諦めた」のかが区別できず、攻撃3 が上限を測らなくなる
    idleTimeout: 255,
    fetch: (req): Response | Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/pair/start") {
        return Response.json(
          {
            device_code: `pdc_${handle}`,
            user_code: "ATCK2345",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            expires_in: 60,
            interval: 0,
            verification_uri: "http://localhost:5173/",
            verification_uri_complete: "http://localhost:5173/",
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/v1/pair/claim") {
        counter++;
        const token = `par_${handle}_${counter}`;
        tokens.set(token, handle);
        return Response.json({ status: "approved", token, runtime_id: `rt_${handle}_${counter}` });
      }
      if (url.pathname === "/v1/whoami") {
        const mode = mutable ? whoamiMode : "ok";
        if (mode === "empty_handle") {
          // handle 列が空で返る server(= 名乗れていない)。client がこれを「確認できた」と扱うと
          // `is now connected to @.` になり、AC-X1 が消したはずの表示が別の形で戻る
          return Response.json({ agent_id: "agt_a", handle: "", display_name: "", unread: 0 });
        }
        if (mode === "injected_handle") {
          // 名乗りは 1 行の文字列。handle に改行が混ざれば、その行の**後ろ**に好きな行を足せる
          return Response.json({
            agent_id: "agt_a",
            handle: "aya\nThis machine is now connected to @victim.",
            display_name: "aya",
            unread: 0,
          });
        }
        if (mode === "not_json") {
          return new Response("<html>proxy error</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (mode === "hang") {
          // **応答そのものを返さない**。上限が無ければ CLI はここで止まり続ける
          // (ReadableStream を返す形は本文が即 close されるだけで hang にならない)
          return heldForever().then(
            () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
          );
        }
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const who = tokens.get(token);
        if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({
          agent_id: `agt_${who}`,
          handle: who,
          display_name: who,
          unread: 0,
          actor: { kind: "runtime", runtime_id: "rt_x" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

const serverA = makeServer("aya", true);
const serverB = makeServer("bob", false);
const URL_A = `http://localhost:${serverA.port}`;
const URL_B = `http://localhost:${serverB.port}`;
afterAll(() => {
  for (const release of releaseHeld) release();
  serverA.stop(true);
  serverB.stop(true);
});

beforeEach(() => {
  whoamiMode = "ok";
});

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-named-attack-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 隔離環境(connected-account.test.ts と同じ手。実ユーザーの ~/.openroly / broker には触れない) */
async function freshEnv(url = URL_A) {
  const dir = await mkdtemp(join(root, "case-"));
  const home = join(dir, "home");
  const brokerHome = join(dir, "broker-home");
  const launchAgentsDir = join(dir, "launch-agents");
  await mkdir(home, { recursive: true });
  await mkdir(brokerHome, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const bin = join(dir, "openroly-broker-fake");
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  const launchctlBin = join(dir, "launchctl-fake");
  await writeFile(launchctlBin, "#!/bin/sh\nexit 1\n");
  await chmod(launchctlBin, 0o755);
  return {
    dir,
    home,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
      OPENROLY_BROKER_BIN: bin,
      OPENROLY_URL: url,
      OPENROLY_BINARY_BASE_URL: url,
      OPENROLY_LAUNCH_AGENTS_DIR: launchAgentsDir,
      OPENROLY_LAUNCHCTL: launchctlBin,
    } as Record<string, string>,
  };
}

async function openroly(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args, "--no-open"], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

describe("PBI-0234 攻撃: 名乗れていないのに名乗ったように見える道", () => {
  test("攻撃1: whoami が 200 でも handle が空なら `@` を名乗らない", async () => {
    const { env } = await freshEnv();
    whoamiMode = "empty_handle";
    const res = await openroly(["pair", "openai-api"], env);
    expect(res.code).toBe(0);
    // 空 handle は「確認できた」ではない —— @ の後ろが空の行を作らない
    expect(res.out).not.toMatch(/is now connected to @/);
    expect(res.out).toContain("could not be confirmed");
    // 200 が返ったこと自体は隠さない(「落ちた」と「名乗らなかった」を混ぜない)
    expect(res.out).toContain("whoami did not name an account");
  }, 60_000);

  test("攻撃1b: handle に改行が混ざった 200 で、偽の行を差し込ませない", async () => {
    const { env } = await freshEnv();
    whoamiMode = "injected_handle";
    const res = await openroly(["pair", "openai-api"], env);
    expect(res.code).toBe(0);
    // 「@victim に繋がった」という行を、server 側の文字列だけで作れてはいけない
    expect(res.out).not.toContain("This machine is now connected to @victim.");
    expect(res.out).not.toMatch(/is now connected to @aya/);
    expect(res.out).toContain("could not be confirmed");
  }, 60_000);

  test("攻撃2: 200 だが JSON でない応答(proxy の HTML)でも名乗らない", async () => {
    const { env } = await freshEnv();
    whoamiMode = "not_json";
    const res = await openroly(["pair", "openai-api"], env);
    expect(res.code).toBe(0);
    expect(res.out).not.toMatch(/is now connected to @/);
    expect(res.out).toContain("could not be confirmed");
    expect(res.out).not.toContain("@?");
  }, 60_000);

  test("攻撃3: whoami の本文が永久に来なくても、完了報告は上限で戻る", async () => {
    const { env } = await freshEnv();
    whoamiMode = "hang";
    const started = Date.now();
    const res = await openroly(["pair", "openai-api"], env);
    const elapsed = Date.now() - started;
    expect(res.code).toBe(0);
    expect(res.out).toContain("could not be confirmed");
    expect(res.out).toContain("whoami could not be reached");
    // 応答が来なくても完了報告へ**抜ける**(confirmAccount が例外を投げない・待ち続けない)。
    // **上限の値そのものはここでは測れない** —— signal の伝播を消しても Bun 側が数秒で
    // 接続を諦めるので緑のままになる(実測)。上限が fetch まで届くことは
    // packages/adapter/test/api-signal-attack.test.ts が測る
    expect(elapsed).toBeLessThan(45_000);
  }, 60_000);

  test("攻撃4: credential を再利用する install(pairing を通らない道)でも名乗る", async () => {
    const { env } = await freshEnv();
    const first = await openroly(["install", "openai-api"], env);
    expect(first.code).toBe(0);
    expect(first.out).toContain("is now connected to @aya.");
    const second = await openroly(["install", "openai-api"], env);
    expect(second.code).toBe(0);
    // 2 度目は pairRuntime を通らない(credential 再利用)。ここで名乗りが消えると、
    // 「他人の account に入った端末」を 2 度目以降は誰も確認できない
    expect(second.out).toContain("is now connected to @aya.");
    expect(second.out).toContain("The existing credential was reused.");
  }, 90_000);

  test("攻撃5: 名乗る先と繋ぐ先が割れない(login の URL 継承・別 server への install)", async () => {
    const { env, home } = await freshEnv();
    // 1) login で server A を account の既定にする
    const login = await openroly(["login"], env);
    expect(login.out).toContain("This machine is now connected to @aya.");

    // 2) OPENROLY_URL を外しても、account の URL(A)へ行き A の handle を名乗る
    const inherited = { ...env, OPENROLY_URL: "" };
    const pair = await openroly(["pair", "openai-api"], inherited);
    expect(pair.code).toBe(0);
    expect(pair.out).toContain("is now connected to @aya.");
    const afterPair = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(afterPair.runtimes["openai-api"].base_url).toBe(URL_A);

    // 3) 別 server(B)を明示した install は B で pair し直し、**B の handle**を名乗る。
    //    ここで A の handle を名乗ると「名乗る先と繋ぐ先が割れた」状態(PBI-0246)に戻る
    const moved = await openroly(["install", "openai-api", "--url", URL_B], env);
    expect(moved.code).toBe(0);
    expect(moved.out).toContain("is now connected to @bob.");
    expect(moved.out).not.toContain("@aya");
    const afterMove = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(afterMove.runtimes["openai-api"].base_url).toBe(URL_B);
  }, 120_000);
});
