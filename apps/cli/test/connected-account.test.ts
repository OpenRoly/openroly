import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PBI-0234: 接続したら、繋がった先の @account を必ず名乗る。
//
// `pending` の pairing 行は誰の物でもない(device code flow の性質・図6)ので、`user_code` を
// 握った human は**自分の** account でその要求を承認できる。だから「繋がった先が自分の account か」を
// 接続した人がその場で読めることが最後の砦になる —— login / install / pair の 3 経路すべてが
// `reportConnected`(openroly.ts)を通ることを、CLI の実出力で固定する。
//
// runtime は `openai-api` を使う: 端末に外部 CLI が要らず(detect は常に installed)、register が
// no-op なので、claude / codex のような実 CLI の有無で skip されない(= 3 経路とも常に測る)。

const CLI = join(import.meta.dir, "../src/openroly.ts");

/** 承認した側の account。AC-X2(他人が承認した)はここを変えて再現する */
let approverHandle = "aya";
/** whoami の応答。AC-X1 は 200 以外に倒す */
let whoamiMode: "ok" | "500" | "401" = "ok";
let approveCounter = 0;
const tokenHandles = new Map<string, string>();

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/pair/start") {
      return Response.json(
        {
          device_code: "pdc_named_test",
          user_code: "NAME2345",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          expires_in: 60,
          interval: 0,
          verification_uri: "http://localhost:5173/",
          verification_uri_complete: "http://localhost:5173/?user_code=NAME2345",
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/pair/claim") {
      approveCounter++;
      const token = `par_named_${approveCounter}`;
      // 承認したのは approverHandle の human —— token はその account に生える
      tokenHandles.set(token, approverHandle);
      return Response.json({ status: "approved", token, runtime_id: `rt_named_${approveCounter}` });
    }
    if (url.pathname === "/v1/whoami") {
      if (whoamiMode === "500") return Response.json({ error: "boom" }, { status: 500 });
      if (whoamiMode === "401") return Response.json({ error: "unauthorized" }, { status: 401 });
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const handle = tokenHandles.get(token);
      if (!handle) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({
        agent_id: "agt_x",
        handle,
        display_name: handle,
        unread: 0,
        actor: { kind: "runtime", runtime_id: "rt_named" },
      });
    }
    // /v1/extensions と binary の SHA256SUMS は 404 —— どちらも「取れなくても続行」の経路
    return new Response("not found", { status: 404 });
  },
});
const BASE_URL = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

beforeEach(() => {
  approverHandle = "aya";
  whoamiMode = "ok";
});

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-named-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * 隔離環境。実ユーザーの ~/.openroly / ~/Library/LaunchAgents / 実 broker には一切触れない。
 * launchctl は全部失敗させて detached fallback に倒す(login.test.ts と同じ手)。
 */
async function freshEnv(opts: { brokerBin?: "fake" | "missing" } = {}) {
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
      OPENROLY_BROKER_BIN: opts.brokerBin === "missing" ? join(dir, "no-such-broker") : bin,
      OPENROLY_URL: BASE_URL,
      // Release の取得は fake server(404)へ向ける —— test が GitHub を叩かない
      OPENROLY_BINARY_BASE_URL: BASE_URL,
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

describe("PBI-0234: 接続の完了表示が繋がった先の @account を名乗る", () => {
  test("AC-1: openroly install の成功表示に @handle が出る", async () => {
    const { env } = await freshEnv();
    const res = await openroly(["install", "openai-api"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("@aya now has ");
    expect(res.out).toContain("OpenAI (API)");
  }, 30_000);

  test("AC-2: openroly pair の成功表示に @handle が出る", async () => {
    const { env } = await freshEnv();
    const res = await openroly(["pair", "openai-api"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("@aya now has ");
    // runtime_id を落とさない(どの登録が生えたかの識別は残す)
    expect(res.out).toMatch(/rt_named_\d+/);
  }, 30_000);

  test("AC-3: openroly login の文言が退行しない", async () => {
    const { env } = await freshEnv();
    const res = await openroly(["login"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      "@aya now has This machine attached. The AIs on it are found automatically and appear under Your AI",
    );
  }, 30_000);

  test("AC-3b: broker が既に起動中(already_running)でも handle の行が出る", async () => {
    const { env, dir } = await freshEnv();
    // 常駐する fake broker —— 2 本目の login が already_running を踏む
    const longLived = join(dir, "openroly-broker-longlived");
    await writeFile(longLived, "#!/bin/sh\nsleep 5\n");
    await chmod(longLived, 0o755);
    env.OPENROLY_BROKER_BIN = longLived;

    const first = await openroly(["login"], env);
    expect(first.code).toBe(0);
    const second = await openroly(["login"], env);
    expect(second.code).toBe(0);
    expect(second.out).toContain("The broker is already running");
    // ここが本 PBI の修正点: break の手前に handle 行が在ること
    expect(second.out).toContain("@aya now has This machine attached.");
  }, 30_000);

  test("AC-3b(2): broker binary が無く build 案内で落ちる時も handle の行は出ている", async () => {
    const { env } = await freshEnv({ brokerBin: "missing" });
    const res = await openroly(["login"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("cargo build --release --manifest-path broker/Cargo.toml");
    expect(res.out).toContain("@aya now has This machine attached.");
  }, 30_000);

  test("AC-X1: whoami が 500 で落ちても、接続成功と『account を確認できなかった』を両方言う(@? を出さない)", async () => {
    const { env } = await freshEnv();
    whoamiMode = "500";
    const res = await openroly(["login"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      "This machine is now connected, but the account it landed in could not be confirmed",
    );
    expect(res.out).toContain("whoami returned 500");
    expect(res.out).toContain("Settings → Connected runtimes");
    // 「@? という account に繋がった」に読める表示を作らない
    expect(res.out).not.toContain("@?");
    expect(res.out).not.toMatch(/@[a-z0-9-]+ now has .+ attached\./);
  }, 30_000);

  test("AC-X1: 401 でも同じ理由付きで出る(pair 経路。500 と区別される)", async () => {
    const { env } = await freshEnv();
    whoamiMode = "401";
    const res = await openroly(["pair", "openai-api"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("could not be confirmed");
    expect(res.out).toContain("the credential was rejected (401)");
    expect(res.out).not.toContain("@?");
  }, 30_000);

  test("AC-X1: server が居ない時は pairing 側で NG になり、嘘の接続報告を出さない", async () => {
    const { env } = await freshEnv();
    env.OPENROLY_URL = "http://127.0.0.1:9"; // 閉じている port → pair/start が reject
    const res = await openroly(["pair", "openai-api"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("NG pairing failed");
    expect(res.out).not.toContain("now has ");
  }, 30_000);

  test("AC-X2: 他人(mallory)が code を承認したら、その @handle が出る", async () => {
    const { env } = await freshEnv();
    approverHandle = "mallory";
    const res = await openroly(["login"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("@mallory now has This machine attached.");
    expect(res.out).not.toContain("@aya");
  }, 30_000);

  test("AC-X2: install / pair も承認した側の @handle を出す(3 経路とも同じ関数を通る)", async () => {
    approverHandle = "mallory";
    const a = await freshEnv();
    const install = await openroly(["install", "openai-api"], a.env);
    expect(install.out).toContain("@mallory now has ");
    expect(install.out).not.toContain("@aya");

    const b = await freshEnv();
    const pair = await openroly(["pair", "openai-api"], b.env);
    expect(pair.out).toContain("@mallory now has ");
    expect(pair.out).not.toContain("@aya");
  }, 60_000);
});
