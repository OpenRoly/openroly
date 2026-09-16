import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@openroly/adapter";

// PBI-0046 AC-1〜5 / X2〜X3: `openroly login` / `openroly broker`。実 broker binary へは到達させず、
// `OPENROLY_BROKER_BIN` に fake shell script を注入する(apps/cli/test/adopt.test.ts と同じ手法。
// EP-0001 LEARN 13)。自動 open(AC-3)は `process.stdout.isTTY` が pipe 経由の子プロセスでは
// 常に false になり test harness から正の検証ができないため、「非対話実行では発火しない」
// safety の固定に倒す(PBI-0046 の「未決の問い」参照)。
//
// AC-X1(別 actor)は既存契約(/v1/pair/approve の human_only)の再確認であり新規テストは
// 追加しない(PBI-0046 テスト設計に明記)。

const CLI = join(import.meta.dir, "../src/openroly.ts");

type ClaimBody = { status: "approved"; token: string; runtime_id: string } | { __http: number };

let pairStartCalls = 0;
/** `pair/start` に載った body(PBI-0227 AC-4: 承認画面に出る名前はここで決まる) */
let lastPairStartBody: { name?: unknown; kind?: unknown } = {};
let claimMode: "approve" | "transient503" = "approve";
let approveCounter = 0;
const whoamiTokens = new Set<string>();

function claimResponse(): ClaimBody {
  if (claimMode === "transient503") return { __http: 503 };
  approveCounter++;
  const token = `par_login_${approveCounter}`;
  whoamiTokens.add(token);
  return { status: "approved", token, runtime_id: `rt_broker_${approveCounter}` };
}

const server = Bun.serve({
  port: 0,
  // async —— `pair/start` の body を **応答を返す前に**読み切る為(PBI-0227 AC-4)。
  // 読まずに Response を返すと body が解放され、記録側は毎回空になる
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/pair/start") {
      pairStartCalls++;
      lastPairStartBody = (await req.json().catch(() => ({}))) as typeof lastPairStartBody;
      return Response.json(
        {
          device_code: "pdc_login_test",
          user_code: "LOGN2345",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          // interval:0 で backoff を無効化し、transient 系テストを高速化する
          expires_in: 60,
          interval: 0,
          verification_uri: "http://localhost:5173/connect",
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/pair/claim") {
      const body = claimResponse();
      if ("__http" in body) return Response.json({ error: "unavailable" }, { status: body.__http });
      return Response.json(body);
    }
    if (url.pathname === "/v1/whoami") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (whoamiTokens.has(token)) {
        return Response.json({
          agent_id: "agt_x",
          handle: "aya",
          display_name: "Aya",
          unread: 0,
          actor: { kind: "runtime", runtime_id: "rt_broker" },
        });
      }
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE_URL = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

beforeEach(() => {
  pairStartCalls = 0;
  claimMode = "approve";
});

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-login-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * fake broker binary。stdout に受け取った env を 1 行で吐いて即終了 or 常駐する。
 * 常駐側は 30 秒 —— 「生きた broker がいる間に login を 2 本」(PBI-0218 AC-3 / AC-X1)は
 * 混雑した機だと login 2 本だけで 10 秒近くかかるので、5 秒だと**検査の途中で broker が
 * 自分から死に**「二重起動しなかった」ではなく「起動してよかった」を測ってしまう。
 * 残り続けないよう、使った test は `killFakeBrokers` で必ず止める
 */
function fakeBrokerScript(liveSeconds: number): string {
  return `#!/bin/sh\necho "spawn pid=$$ token=$OPENROLY_RUNTIME_TOKEN ws=$OPENROLY_BROKER_WS_URL cli=$OPENROLY_CLI"\n${
    liveSeconds > 0 ? `sleep ${liveSeconds}\n` : "exit 0\n"
  }`;
}

/**
 * fake launchctl。argv を 1 行ずつ log へ append し、サブコマンドごとに設定した exit code を返す。
 * 既定は全部失敗(list/load/unload = 1) —— PBI-0046 の既存 test(AC-1〜X3)は darwin 実機で走るため、
 * 既定で失敗させることで PBI-0048 の launchd 分岐を経由させず、常に detached fallback を通す
 * (既存 test の意味を変えない)。
 */
function fakeLaunchctlScript(codes: { list: number; load: number; unload: number }, logPath: string): string {
  return `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1" in
  list) exit ${codes.list} ;;
  load) exit ${codes.load} ;;
  unload) exit ${codes.unload} ;;
  *) exit 1 ;;
esac
`;
}

async function freshEnv(
  opts: {
    /** fake broker の常駐秒数(0 = 即 exit) */
    liveSeconds?: number;
    launchctl?: { list: number; load: number; unload: number };
  } = {},
) {
  const dir = await mkdtemp(join(root, "case-"));
  const home = join(dir, "home");
  const brokerHome = join(dir, "broker-home");
  const launchAgentsDir = join(dir, "launch-agents");
  await mkdir(home, { recursive: true });
  await mkdir(brokerHome, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const bin = join(dir, "openroly-broker-fake");
  await writeFile(bin, fakeBrokerScript(opts.liveSeconds ?? 0));
  await chmod(bin, 0o755);
  const openLog = join(dir, "open.log");
  const fakeOpenDir = join(dir, "fakebin");
  await mkdir(fakeOpenDir, { recursive: true });
  await writeFile(join(fakeOpenDir, "open"), `#!/bin/sh\necho "$@" >> "${openLog}"\n`);
  await chmod(join(fakeOpenDir, "open"), 0o755);
  const launchctlLog = join(dir, "launchctl.log");
  const launchctlBin = join(dir, "launchctl-fake");
  await writeFile(
    launchctlBin,
    fakeLaunchctlScript(opts.launchctl ?? { list: 1, load: 1, unload: 1 }, launchctlLog),
  );
  await chmod(launchctlBin, 0o755);
  return {
    home,
    brokerHome,
    brokerLog: join(brokerHome, "broker.log"),
    brokerPid: join(brokerHome, "broker.pid"),
    openLog,
    launchAgentsDir,
    plistPath: join(launchAgentsDir, "com.openroly.broker.plist"),
    launchctlLog,
    env: {
      PATH: `${fakeOpenDir}:${process.env.PATH ?? ""}`,
      // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
      OPENROLY_BROKER_BIN: bin,
      OPENROLY_URL: BASE_URL,
      OPENROLY_LAUNCH_AGENTS_DIR: launchAgentsDir,
      OPENROLY_LAUNCHCTL: launchctlBin,
    } as Record<string, string>,
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

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/**
 * detached の broker(孫プロセス)は `login` 自身の exit より後にログを書き終える —— fork/exec の
 * 実時間分だけ遅れる。固定 sleep だとその幅を過小/過大に見積もるので、条件を満たすまで poll する。
 *
 * 既定の締切は**混雑した機の実測に合わせて長く取る** —— load 400 超では `/bin/sh` の exec が
 * 20 秒以上遅れることがあり、2 秒だと「まだ来ていない」を「来なかった」と読んで偽の赤になる
 * (PBI-0218。条件が満たされた時点で即返るので、緑の時の実行時間は変わらない)
 */
async function waitForContent(
  path: string,
  predicate: (s: string) => boolean,
  timeoutMs = // 混雑した機械では detached broker の spawn だけで数秒掛かる。**予定より長く待つ**のは
  // 只で、短い締切は「実装が壊れた」と「機械が混んでいた」を混ぜてしまう(PBI-0162 AC-X2)。
  // 条件が満たされた瞬間に返るので、健全な run の所要はこの値に影響されない
  30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (predicate(content)) return content;
    if (Date.now() > deadline) return content;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const spawnLines = (s: string) => s.split("\n").filter((l) => l.startsWith("spawn "));
/** fake broker が stdout の 1 行目に吐く自分の pid(`spawn pid=$$`) */
const spawnedPid = (line: string) => Number(/^spawn pid=(\d+)/.exec(line)?.[1]);

/**
 * broker が実際に走ったことは「spawn された子プロセスが log に書いた行」でしか測れないが、
 * その到着は機の混雑にそのまま引きずられる —— **実測で 20 秒待っても来ないことがある**
 * (load 400 超の機で `/bin/sh` の exec がそこまで遅れた)。締切を短く取ると「まだ来ていない」を
 * 「1 本も上がらなかった」と読んで偽の赤になる: PBI-0218 の「3 回中 2 回 0 本」の実測はこれで、
 * 失敗 round を採取すると login の stdout は "broker log:" を出し pid file も新しい broker を
 * 指していて、足りなかったのは log 行の到着だけだった。
 *
 * そこで **1 回ごとの判定は CLI 自身の申告（stdout・pid file。login の終了時点で確定している）で行い**、
 * 「本当に走ったか」は最後に 1 度だけ、期待する本数が揃うまで長く待って突き合わせる
 */
async function spawnPidsWhenSettled(brokerLog: string, expected: number, timeoutMs = 90_000): Promise<number[]> {
  const log = await waitForContent(brokerLog, (s) => spawnLines(s).length >= expected, timeoutMs);
  return spawnLines(log).map(spawnedPid);
}

/** 確実に死んでいる pid(短命なプロセスを起こして看取る)。stale pid file の材料 */
async function reapedPid(): Promise<number> {
  const proc = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

/**
 * この case の fake broker(`sleep 30`)を止める。case ごとに mkdtemp した固有の path で
 * 突き合わせ、**自分が起こした pid だけ**に signal を送る(共有名での pkill はしない)
 */
async function killFakeBrokers(binPath: string): Promise<number[]> {
  const proc = Bun.spawn(["/bin/ps", "-A", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const pids = out
    .split("\n")
    .filter((l) => l.includes(binPath))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n) && n > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 既に終了
    }
  }
  return pids;
}

describe("openroly login / openroly broker (PBI-0046)", () => {
  test("AC-1: credential 無しから pairing して broker を detached 起動する", async () => {
    const { env, home, brokerLog, brokerPid } = await freshEnv();
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("@aya now has This machine attached.");
    expect(res.out).toContain("appear under Your AI");

    const file = await readJson(join(home, "credentials.json"));
    // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
    expect(file.runtimes.broker).toMatchObject({ name: hostname(), base_url: BASE_URL });
    expect(file.runtimes.broker.token).toMatch(/^par_login_/);

    // pid file は `<pid> <起動時刻>`(PBI-0048 レビュー AC-X3 の修正)。fake broker は即 exit するので
    // 起動時刻が取れず pid だけの行になることもある —— 先頭が pid であることだけを固定する
    const pid = (await readFile(brokerPid, "utf8")).trim();
    expect(pid).toMatch(/^\d+(\s|$)/);

    const log = await waitForContent(brokerLog, (s) => s.includes("token=par_login_"));
    expect(log).toContain("token=par_login_");
    expect(log).toContain(`ws=${BASE_URL.replace(/^http/, "ws")}/v1/broker/ws`);
    // OPENROLY_CLI の argv0 は process.execPath(bun 自体の絶対 path)。launchd の最小 PATH は
    // bare な "bun" を解決できないため(PBI-0048)
    expect(log).toContain(`cli=${process.execPath}:`);
    expect(log).toContain("openroly.ts");
  }, 120_000);

  test("PBI-0237 AC-2: 接続コードは **端末の画面に**出る(URL の中ではない)", async () => {
    const { env } = await freshEnv();
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    // ① code が独立した 1 行として出る(人がここから読んで打つ)
    expect(res.out).toContain("Type this code:    LOGN2345");
    // ② 出す URL は打つ欄だけの定数 path。**code を 1 文字も含まない**
    expect(res.out).toContain("Open in a browser: http://localhost:5173/connect");
    expect(res.out).not.toContain("/connect?");
    expect(res.out).not.toContain("user_code=");
    // ③ 出力全体で「code の入った URL」が 1 本も無い —— 行を割って、URL を含む行に
    //    code が同居していないことまで見る(1 本でも在れば送りつけられる)
    for (const line of res.out.split("\n")) {
      if (!line.includes("http")) continue;
      expect(line).not.toContain("LOGN2345");
    }
  }, 30_000);

  test("AC-2: 有効な credential があれば再 pairing しない", async () => {
    const { env, home } = await freshEnv();
    const token = "par_login_precreated";
    whoamiTokens.add(token);
    await saveCredential(
      "broker",
      {
        runtime_id: "rt_broker_precreated",
        token,
        base_url: BASE_URL,
        // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
        name: hostname(),
        paired_at: new Date().toISOString(),
      },
      { OPENROLY_HOME: home },
    );
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("@aya now has This machine attached.");
    expect(pairStartCalls).toBe(0);
  }, 120_000);

  test("--url で別 server を明示したら、既存 credential を使い回さず再 pairing する", async () => {
    const { env, home } = await freshEnv();
    const token = "par_login_other_server";
    whoamiTokens.add(token);
    await saveCredential(
      "broker",
      {
        runtime_id: "rt_broker_other_server",
        token,
        base_url: BASE_URL,
        // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
        name: hostname(),
        paired_at: new Date().toISOString(),
      },
      { OPENROLY_HOME: home },
    );
    // 接続不能な別 server を明示 —— 既存 credential(BASE_URL 向け)を無条件に使い回して
    // 「接続しました」を偽陽性で出さないことを固定する
    const res = await openroly(["login", "--no-open", "--url", "http://127.0.0.1:1"], env);
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain("now connected");
  }, 120_000);

  test("AC-4: binary が見つからない場合は build 案内で exit 1(credential は保持される)", async () => {
    const { env, home } = await freshEnv();
    const token = "par_login_ac4";
    whoamiTokens.add(token);
    await saveCredential(
      "broker",
      {
        runtime_id: "rt_broker_ac4",
        token,
        base_url: BASE_URL,
        // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
        name: hostname(),
        paired_at: new Date().toISOString(),
      },
      { OPENROLY_HOME: home },
    );
    const res = await openroly(["broker"], { ...env, OPENROLY_BROKER_BIN: "/nonexistent/openroly-broker-xyz" });
    expect(res.code).toBe(1);
    expect(res.err).toContain("cargo build --release --manifest-path broker/Cargo.toml");
    // credential は broker 起動失敗と無関係に保持され続ける
    const file = await readJson(join(home, "credentials.json"));
    expect(file.runtimes.broker.runtime_id).toBe("rt_broker_ac4");
  }, 120_000);

  test("AC-5: 既に broker が生きていれば二重起動しない", async () => {
    // 混雑した機では login 1 本に数十秒かかる —— broker の寿命が 2 本目の判定より先に尽きると
    // 「二重起動しなかった」ではなく「起動してよかった」を測ってしまう(PBI-0218)
    const { env, brokerLog } = await freshEnv({ liveSeconds: 300 });
    try {
      const first = await openroly(["login", "--no-open"], env);
      expect(first.code).toBe(0);

      const second = await openroly(["login", "--no-open"], env);
      expect(second.code).toBe(0);
      expect(second.out).toContain("already running");

      expect(await spawnPidsWhenSettled(brokerLog, 1)).toHaveLength(1);
    } finally {
      await killFakeBrokers(env.OPENROLY_BROKER_BIN!);
    }
  }, 120_000);

  test("非対話実行(このテスト harness)では自動 open が発火しない(--no-open 有無どちらでも)", async () => {
    const { env, openLog } = await freshEnv();
    await openroly(["login", "--no-open"], env);
    await expect(readFile(openLog, "utf8")).rejects.toThrow();

    const { env: env2, openLog: openLog2 } = await freshEnv();
    await openroly(["login"], env2);
    await expect(readFile(openLog2, "utf8")).rejects.toThrow();
  }, 120_000);

  test("AC-X2: server が一時的に不能なら transient retry 後に failed で exit 1(credential は書かれない)", async () => {
    const { env, home } = await freshEnv();
    claimMode = "transient503";
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("NG pairing failed");
    const file = await readJson(join(home, "credentials.json")).catch(() => ({ runtimes: {} }));
    expect(file.runtimes.broker).toBeUndefined();
  }, 120_000);

  test("AC-X3: 2 本の login を同時実行しても credentials.json は壊れず broker は 1 本だけ生き残る", async () => {
    const { env, home, brokerLog } = await freshEnv({ liveSeconds: 300 });
    const [a, b] = await Promise.all([
      openroly(["login", "--no-open"], env),
      openroly(["login", "--no-open"], env),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // 両方が同時に「credential 無し」を見て pairing に入る保証は timing 依存のため、
    // 「壊れずに収束する」ことだけを固定する(厳密に 2 回とは限らない)
    expect(pairStartCalls).toBeGreaterThanOrEqual(1);

    const file = await readJson(join(home, "credentials.json"));
    expect(file.runtimes.broker.token).toMatch(/^par_login_/);

    // 起こしたのは 1 本だけ。判定は CLI 自身の申告(log 行の到着に依存しない)で行い、
    // 実際に走ったことは落ち着いてから 1 度だけ突き合わせる(PBI-0218)
    const started = [a, b].filter((r) => r.out.includes("broker log:")).length;
    const yielded = [a, b].filter((r) => r.out.includes("The broker is already running")).length;
    expect(`started=${started} yielded=${yielded}`).toBe("started=1 yielded=1");
    expect(await spawnPidsWhenSettled(brokerLog, 1)).toHaveLength(1);
    await killFakeBrokers(env.OPENROLY_BROKER_BIN!);
  }, 120_000);

  test("broker: 未接続なら login を案内して失敗する", async () => {
    const { env } = await freshEnv();
    const res = await openroly(["broker"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("openroly login");
  }, 120_000);
});

// レビュー(有界)の攻撃 test(PBI-0046 review 2026-08-27)。レビュー時は `test.failing` で「今は破れている」を
// 固定し、実装ステージの修正(pairing.ts の startPairing / openroly.ts の withStaleTakeoverLock)で `test` に戻した。
describe("PBI-0046 review: AC-X2 / AC-X3 攻撃", () => {
  test(
    "AC-X2 攻撃: pair/start 自体が不達(fetch reject)でも NG 表示で exit 1(生の stack trace を出さない)",
    async () => {
      const { env } = await freshEnv();
      env.OPENROLY_URL = "http://127.0.0.1:9"; // 閉じている port → fetch が reject
      const res = await openroly(["login", "--no-open"], env);
      expect(res.code).toBe(1);
      expect(res.err).toContain("NG pairing failed");
      expect(res.err).toContain("cannot connect to");
      expect(res.err).not.toContain("Unable to connect");
    },
    120_000,
  );

  test(
    "AC-X3 攻撃: 死んだ pid を指す stale pid file がある状態で login を 2 本同時に実行しても broker は 1 本だけ起動する(6 回反復)",
    async () => {
      // レビュー時の実測: lock 無しの readFile → rm → link では 20 回中 1 回、後発の rm が先発の link 済み
      // file を消して両方 spawn した。stale 再利用を withStaleTakeoverLock で直列化した後は 0 回であること。
      // 数え方は PBI-0218 と同じ —— round ごとの判定は CLI の申告で行い、log 行は最後に 1 度だけ突き合わせる
      const { env, brokerLog, brokerPid } = await freshEnv({ liveSeconds: 120 });
      const ROUNDS = 6;
      try {
        // 先に credential を作っておく(pairing の競合ではなく pid file の競合だけを見る)
        const first = await openroly(["login", "--no-open"], env);
        expect(first.code).toBe(0);
        const winners = [Number((await readFile(brokerPid, "utf8")).trim().split(/\s+/)[0])];
        for (let round = 0; round < ROUNDS; round++) {
          const raw = (await readFile(brokerPid, "utf8")).trim();
          await writeFile(brokerPid, raw.replace(/^\d+/, String(await reapedPid())));
          const [a, b] = await Promise.all([openroly(["login", "--no-open"], env), openroly(["login", "--no-open"], env)]);
          expect(a.code).toBe(0);
          expect(b.code).toBe(0);
          const started = [a, b].filter((r) => r.out.includes("broker log:")).length;
          const yielded = [a, b].filter((r) => r.out.includes("The broker is already running")).length;
          expect(`round ${round}: started=${started} yielded=${yielded}`).toBe(
            `round ${round}: started=1 yielded=1`,
          );
          const pidNow = Number((await readFile(brokerPid, "utf8")).trim().split(/\s+/)[0]);
          expect(winners).not.toContain(pidNow);
          winners.push(pidNow);
        }
        expect((await spawnPidsWhenSettled(brokerLog, winners.length)).sort()).toEqual(
          [...winners].sort(),
        );
      } finally {
        await killFakeBrokers(env.OPENROLY_BROKER_BIN!);
      }
    },
    300_000,
  );
});

// ---- PBI-0046 再レビュー(有界)の攻撃 test(2026-08-28)。レビューセッションが追加 ----
// PBI-0218 で「1 本だけ起動する」を「**0 本にならない**」まで含めて測る形に強化した
describe("PBI-0046 再レビュー / PBI-0218: AC-X3 攻撃", () => {
  test(
    "AC-1 / AC-2: stale pid file 下で login を 3 本同時に実行しても broker はちょうど 1 本(10 回反復)",
    async () => {
      // 譲る根拠を「生きた broker を確認できた」だけに絞る前は、先客が起動前に終了していると
      // 全員が「他が起動中」と判断して**誰も起こさない**経路が残っていた(PBI-0218)
      const { env, brokerLog, brokerPid } = await freshEnv({ liveSeconds: 120 });
      const ROUNDS = 10;
      try {
        const first = await openroly(["login", "--no-open"], env);
        expect(first.code).toBe(0);
        const winners = [Number((await readFile(brokerPid, "utf8")).trim().split(/\s+/)[0])];
        for (let round = 0; round < ROUNDS; round++) {
          // 死んだ pid + 本物の起動時刻の行 = stale file。**走っている broker は殺さない** ——
          // exec の前に SIGKILL すると spawn 行が永久に失われ、最後の突き合わせが測れなくなる
          const raw = (await readFile(brokerPid, "utf8")).trim();
          await writeFile(brokerPid, raw.replace(/^\d+/, String(await reapedPid())));
          const three = await Promise.all([
            openroly(["login", "--no-open"], env),
            openroly(["login", "--no-open"], env),
            openroly(["login", "--no-open"], env),
          ]);
          for (const r of three) expect(r.code).toBe(0);
          // CLI 自身の申告(log の到着に依存しない)。ちょうど 1 本が起こし、残りは正常に譲る
          const started = three.filter((r) => r.out.includes("broker log:")).length;
          const yielded = three.filter((r) => r.out.includes("The broker is already running")).length;
          expect(`round ${round}: started=${started} yielded=${yielded}`).toBe(
            `round ${round}: started=1 yielded=2`,
          );
          // pid file は起こした 1 本を指す(stale のままでも、誰かの CLI pid のままでもない)
          const pidNow = Number((await readFile(brokerPid, "utf8")).trim().split(/\s+/)[0]);
          expect(winners).not.toContain(pidNow);
          winners.push(pidNow);
        }
        // 受け取る側の入口(spawn された子プロセスが書く行)で、走ったのが**その 11 本だけ**であること
        expect((await spawnPidsWhenSettled(brokerLog, winners.length)).sort()).toEqual(
          [...winners].sort(),
        );
      } finally {
        await killFakeBrokers(env.OPENROLY_BROKER_BIN!);
      }
    },
    420_000,
  );

  test(
    "AC-3 / AC-X1: 生きた broker がいる時は、別 account の credential の login が 2 本来ても奪わない",
    async () => {
      const { env, brokerLog, brokerPid } = await freshEnv({ liveSeconds: 300 });
      try {
        const first = await openroly(["login", "--no-open"], env);
        expect(first.code).toBe(0);
        const pidBefore = (await readFile(brokerPid, "utf8")).trim();
        expect(await spawnPidsWhenSettled(brokerLog, 1)).toEqual([Number(pidBefore.split(/\s+/)[0])]);

        // 別 account(別 OPENROLY_HOME / 別 token)。pid file は機ごとに 1 つなので、
        // 期待されるのは**奪取ではなく譲る**こと(PBI-0218 AC-X1)
        const otherHome = join(await mkdtemp(join(root, "other-")), "home");
        await mkdir(otherHome, { recursive: true });
        const otherToken = "par_login_other_actor";
        whoamiTokens.add(otherToken);
        await saveCredential(
          "broker",
          {
            runtime_id: "rt_broker_other_actor",
            token: otherToken,
            base_url: BASE_URL,
            // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
            name: hostname(),
            paired_at: new Date().toISOString(),
          },
          { OPENROLY_HOME: otherHome },
        );
        const [a, b] = await Promise.all([
          openroly(["login", "--no-open"], { ...env, OPENROLY_HOME: otherHome }),
          openroly(["login", "--no-open"], { ...env, OPENROLY_HOME: otherHome }),
        ]);
        expect(a.code).toBe(0);
        expect(b.code).toBe(0);
        expect(a.out).toContain("The broker is already running");
        expect(b.out).toContain("The broker is already running");
        // 新規起動 0 本・pid file も元の 1 本のまま(落とさない・奪わない)
        expect((await readFile(brokerPid, "utf8")).trim()).toBe(pidBefore);
        expect(spawnLines(await readFile(brokerLog, "utf8")).length).toBe(1);
        // 元の broker は生きたまま(奪われていない = 止められていない)
        expect(await killFakeBrokers(env.OPENROLY_BROKER_BIN!)).toEqual([Number(pidBefore.split(/\s+/)[0])]);
      } finally {
        await killFakeBrokers(env.OPENROLY_BROKER_BIN!);
      }
    },
    120_000,
  );

  test(
    "AC-X2: 壊れた pid file(空 / 空白だけ / 数字でない / 途中で切れた)でも broker は起動する",
    async () => {
      // 「判定できない」を「誰かが生きている」に倒すと 0 本になる。空の broker.pid 1 つで
      // `openroly login` が**恒久的に** already running と言い続けた(PBI-0218 の実測)
      const { env, brokerLog, brokerPid } = await freshEnv();
      const first = await openroly(["login", "--no-open"], env);
      expect(first.code).toBe(0);
      const winners = [Number((await readFile(brokerPid, "utf8")).trim().split(/\s+/)[0])];
      for (const [label, content] of [
        ["空", ""],
        ["空白だけ", "   \n"],
        ["数字でない", "abc"],
        ["途中で切れた", "40"],
      ] as const) {
        await writeFile(brokerPid, content);
        const res = await openroly(["login", "--no-open"], env);
        expect(res.code).toBe(0);
        expect(`${label}: ${res.out.trim().split("\n").slice(-1)[0]}`).toContain("broker log:");
        const pidNow = Number((await readFile(brokerPid, "utf8")).trim().split(/\s+/)[0]);
        expect(`${label}: ${winners.includes(pidNow)}`).toBe(`${label}: false`);
        winners.push(pidNow);
      }
      expect((await spawnPidsWhenSettled(brokerLog, winners.length)).sort()).toEqual(
        [...winners].sort(),
      );
    },
    180_000,
  );
});
