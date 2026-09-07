import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@openroly/adapter";

// PBI-0048 AC-1〜7 / X2: `openroly login` の launchd 優先分岐と `openroly broker install/uninstall/status`。
// 実マシンの ~/Library/LaunchAgents と実 launchctl には一度も触れない —— OPENROLY_LAUNCH_AGENTS_DIR /
// OPENROLY_LAUNCHCTL で常に隔離する(apps/cli/test/login.test.ts と同じ設計)。
//
// AC-X1(別 actor)は既存契約の再確認であり新規テストは追加しない(G1 テスト設計に明記)。
// AC-X3(二重起動判定の一本化)は login.test.ts の AC-5/AC-X3 が pid file 排他生成を経由して
// 既に検証している(PBI-0048 で foreground も同じ claimBrokerPidFile を通すよう変更済み)。

const CLI = join(import.meta.dir, "../src/openroly.ts");

// launchd は macOS だけの機構で、`openroly login` / `openroly broker install` は openroly.ts で
// `process.platform === "darwin"` に閉じている。CI は ubuntu で回す(private repo の macOS runner は
// 分数が 10 倍で数えられる)ので、**launchd 経路を通る test だけ**を darwin に限る —— 限るのは
// 6 本で、残り 9 本(uninstall / status / pid file / detached fallback)は全 platform で回る。
// **skip で穴を空けない**ため、「launchd 経路が platform で閉じている」こと自体は
// この file の最後の describe が source 検査として全 platform で固定する(PBI-0162)。
const darwinOnly = test.skipIf(process.platform !== "darwin");

let pairStartCalls = 0;
const whoamiTokens = new Set<string>();
let approveCounter = 0;

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/pair/start") {
      pairStartCalls++;
      return Response.json(
        {
          device_code: "pdc_launchd_test",
          user_code: "LNCH2345",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          expires_in: 60,
          interval: 0,
          verification_uri: "http://localhost:5173/connect",
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/pair/claim") {
      approveCounter++;
      const token = `par_launchd_${approveCounter}`;
      whoamiTokens.add(token);
      return Response.json({ status: "approved", token, runtime_id: `rt_launchd_${approveCounter}` });
    }
    if (url.pathname === "/v1/whoami") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (whoamiTokens.has(token)) {
        return Response.json({ agent_id: "agt_x", handle: "aya", display_name: "Aya", unread: 0 });
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
});

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-launchd-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** fake launchctl: argv を 1 行ずつ記録し、サブコマンドごとの exit code を返す */
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

async function freshEnv(opts: { launchctl?: { list: number; load: number; unload: number } } = {}) {
  const dir = await mkdtemp(join(root, "case-"));
  const home = join(dir, "home");
  const brokerHome = join(dir, "broker-home");
  const launchAgentsDir = join(dir, "launch-agents");
  await mkdir(home, { recursive: true });
  await mkdir(brokerHome, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const fakeBrokerBin = join(dir, "openroly-broker-fake");
  await writeFile(fakeBrokerBin, `#!/bin/sh\necho "spawn $$"\nexit 0\n`);
  await chmod(fakeBrokerBin, 0o755);
  const fakeOpenDir = join(dir, "fakebin");
  await mkdir(fakeOpenDir, { recursive: true });
  await writeFile(join(fakeOpenDir, "open"), `#!/bin/sh\nexit 0\n`);
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
    launchAgentsDir,
    plistPath: join(launchAgentsDir, "com.openroly.broker.plist"),
    launchctlLog,
    brokerPid: join(brokerHome, "broker.pid"),
    brokerLog: join(brokerHome, "broker.log"),
    env: {
      PATH: `${fakeOpenDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
      OPENROLY_BROKER_BIN: fakeBrokerBin,
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

async function saveBrokerCredential(home: string, token: string) {
  whoamiTokens.add(token);
  await saveCredential(
    "broker",
    {
      runtime_id: "rt_launchd_precreated",
      token,
      base_url: BASE_URL,
      name: "test-host",
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
}

/** `ps -o lstart=` の起動時刻(openroly.ts の processStartTime と同じ正規化) */
async function lstartOf(pid: number): Promise<string> {
  const proc = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe" });
  return (await new Response(proc.stdout).text()).trim().replace(/\s+/g, " ");
}

async function waitForContent(
  path: string,
  predicate: (s: string) => boolean,
  timeoutMs = // 混雑した機械では detached broker の spawn だけで数秒掛かる。**予定より長く待つ**のは
  // 只で、短い締切は「実装が壊れた」と「機械が混んでいた」を混ぜてしまう(PBI-0162 AC-X2)。
  // 条件が満たされた瞬間に返るので、健全な run の所要はこの値に影響されない
  15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (predicate(content)) return content;
    if (Date.now() > deadline) return content;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("openroly login launchd 分岐 (PBI-0048)", () => {
  darwinOnly("AC-1: 未 load なら plist を書いて load する(token は書かない)", async () => {
    const { env, plistPath, launchctlLog } = await freshEnv({ launchctl: { list: 1, load: 0, unload: 0 } });
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Registered with launchd");

    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain("com.openroly.broker");
    expect(plist).not.toContain("par_launchd_"); // token 文字列が plist に無いこと

    const log = await waitForContent(launchctlLog, (s) => s.includes("load"));
    expect(log).toContain(`load -w ${plistPath}`);
  }, 30_000);

  darwinOnly("AC-2: 既に load 済みなら plist を書かず load も呼ばない", async () => {
    const { env, plistPath, launchctlLog } = await freshEnv({ launchctl: { list: 0, load: 1, unload: 1 } });
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Registered with launchd");

    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    const log = await readFile(launchctlLog, "utf8").catch(() => "");
    expect(log).not.toContain("load ");
  }, 30_000);

  test("AC-3: launchd 登録に失敗したら detached へ fallback する", async () => {
    const { env, brokerLog, brokerPid } = await freshEnv({ launchctl: { list: 1, load: 1, unload: 1 } });
    const res = await openroly(["login", "--no-open"], env);
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("Registered with launchd");
    expect(res.out).toContain("broker log:");

    // pid file は `<pid> <起動時刻>`(PBI-0048 レビュー AC-X3 の修正)。先頭が pid であることを固定する
    const pid = await waitForContent(brokerPid, (s) => /^\d+(\s|$)/.test(s.trim()));
    expect(pid.trim()).toMatch(/^\d+(\s|$)/);
    const log = await waitForContent(brokerLog, (s) => s.includes("spawn"));
    expect(log).toContain("spawn");
  }, 30_000);
});

describe("openroly broker install/uninstall/status (PBI-0048)", () => {
  darwinOnly("AC-4: install は credential が有れば plist を書き token を含まない", async () => {
    const { env, home, plistPath } = await freshEnv({ launchctl: { list: 1, load: 0, unload: 0 } });
    await saveBrokerCredential(home, "par_install_ac4");
    const res = await openroly(["broker", "install"], env);
    expect(res.code).toBe(0);
    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain("com.openroly.broker");
    expect(plist).not.toContain("par_install_ac4");
  }, 30_000);

  darwinOnly("AC-5: credential が無ければ login を案内して plist を書かない", async () => {
    const { env, plistPath } = await freshEnv();
    const res = await openroly(["broker", "install"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("openroly login");
    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
  }, 30_000);

  test("AC-6: uninstall は unload してから plist を削除する", async () => {
    const { env, plistPath, launchctlLog } = await freshEnv({ launchctl: { list: 1, load: 1, unload: 0 } });
    await writeFile(plistPath, "<plist>dummy</plist>");
    const res = await openroly(["broker", "uninstall"], env);
    expect(res.code).toBe(0);
    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    const log = await readFile(launchctlLog, "utf8");
    expect(log).toContain(`unload ${plistPath}`);
  }, 30_000);

  test("AC-7: status は plist / job / process の 3 状態を別々に報告する", async () => {
    const { env, plistPath, brokerPid } = await freshEnv({ launchctl: { list: 0, load: 1, unload: 1 } });
    await writeFile(plistPath, "<plist>dummy</plist>");
    // process 生存: このテストプロセス自身の pid と起動時刻を broker.pid に書いて「生存」を再現する
    // (pid だけの旧形式は openroly-broker 以外を生存とみなさない —— PBI-0048 レビュー AC-X3 の修正)
    await writeFile(brokerPid, `${process.pid} ${await lstartOf(process.pid)}`);

    const res = await openroly(["broker", "status"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("launchd plist: installed");
    expect(res.out).toContain("launchd job: registered");
    expect(res.out).toContain(`running (pid ${process.pid})`);
  }, 30_000);

  darwinOnly("AC-X2: install 失敗時は plist を残したまま exit 1 で理由を出す", async () => {
    const { env, home, plistPath } = await freshEnv({ launchctl: { list: 1, load: 1, unload: 1 } });
    await saveBrokerCredential(home, "par_install_x2");
    const res = await openroly(["broker", "install"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("NG registering with launchd failed");
    // plist は書き込み済みのまま残る(次回 install で上書きされる想定)
    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain("com.openroly.broker");
  }, 30_000);
});

// レビュー(有界)の攻撃 test(PBI-0048 review 2026-08-27)。レビュー時は `test.failing` で「今は破れている」を
// 固定し、実装ステージの修正(resolveBrokerBin の null 化 / pid file への起動時刻併記)で `test` に戻した。
describe("PBI-0048 review: AC-X2 / AC-X3 攻撃", () => {
  darwinOnly(
    "AC-X2 攻撃: broker binary が無ければ launchd 経路でも build 案内で exit 1(plist を書かず launchd に登録しない)",
    async () => {
      const { env, home, plistPath, launchctlLog } = await freshEnv({ launchctl: { list: 1, load: 0, unload: 0 } });
      await saveBrokerCredential(home, "par_review_x2");
      env.OPENROLY_BROKER_BIN = join(root, "does-not-exist-openroly-broker");
      const res = await openroly(["login", "--no-open"], env);
      // PBI-0046 AC-4 と同じ失敗様式を launchd 経路でも期待する: exit 1 + cargo build の案内
      expect(res.code).toBe(1);
      expect(res.err).toContain("cargo build");
      expect(res.out).not.toContain("Registered with launchd");
      await expect(readFile(plistPath, "utf8")).rejects.toThrow();
      expect(await readFile(launchctlLog, "utf8").catch(() => "")).not.toContain("load ");

      // `openroly broker install` 単体も同じ(登録してから launchd 側で失敗し続ける経路を残さない)
      const install = await openroly(["broker", "install"], env);
      expect(install.code).toBe(1);
      expect(install.err).toContain("cargo build");
      await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    },
    30_000,
  );

  test(
    "AC-X3 攻撃: pid file の pid が別プロセスに再利用されていれば「停止」と判定する(再起動後に pid 1 等を指しても broker を起動できる)",
    async () => {
      const { env, brokerPid, brokerLog } = await freshEnv({ launchctl: { list: 0, load: 1, unload: 1 } });
      // 再起動後の pid file: 前回 boot の pid が今回 boot では無関係なプロセス(ここでは launchd = pid 1)を指す
      await writeFile(brokerPid, "1");
      const res = await openroly(["broker", "status"], env);
      expect(res.code).toBe(0);
      expect(res.out).toContain("broker process: stopped");

      // 起動時刻付きでも、時刻が合わなければ(= 別 boot の同じ番号)停止
      await writeFile(brokerPid, `${process.pid} Thu Jan 1 00:00:00 1970`);
      expect((await openroly(["broker", "status"], env)).out).toContain("broker process: stopped");

      // 生きている本物(このテストプロセス)を起動時刻付きで指せば生存(AC-7 と同じ)
      await writeFile(brokerPid, `${process.pid} ${await lstartOf(process.pid)}`);
      expect((await openroly(["broker", "status"], env)).out).toContain(`running (pid ${process.pid})`);

      // stale(pid 1)を指したまま `openroly broker`(前景・launchd が起こす入口)を実行すると起動できる
      await writeFile(brokerPid, "1");
      await saveBrokerCredential(join(env.OPENROLY_HOME!), "par_review_x3");
      const fg = await openroly(["broker"], env);
      expect(fg.code).toBe(0);
      expect(fg.out).toContain("spawn");
      expect(fg.err).not.toContain("already running");
      expect(await readFile(brokerLog, "utf8").catch(() => "")).toBe("");
    },
    30_000,
  );
});

// ---- PBI-0048 再レビュー(有界)の攻撃 test(2026-08-28)。レビューセッションが追加 ----
describe("PBI-0048 再レビュー: AC-X3 攻撃", () => {
  test(
    "pid file が空 / garbage でも『停止』と判定し、openroly broker が起動できる(起動不能のままにならない)",
    async () => {
      // fix は `<pid> <lstart>` 形式を前提にする — 破損入力(空文字 / 英字 garbage / 0 や負のような
      // 実在しない番号)が parse で例外にならず「停止」に倒れ、KeepAlive で起こされた openroly broker が
      // 永久に起動不能に陥らないことを固定する
      const { env, brokerPid, brokerHome } = await freshEnv({ launchctl: { list: 0, load: 1, unload: 1 } });
      await saveBrokerCredential(join(env.OPENROLY_HOME!), "par_review_corrupt");

      for (const garbage of ["", "   \n", "not-a-pid", "-1", "99999999999999999999"]) {
        await writeFile(brokerPid, garbage);
        const st = await openroly(["broker", "status"], env);
        expect(st.code).toBe(0);
        expect(st.out).toContain("broker process: stopped");
      }

      // 破損 pid file のまま foreground(launchd が実行する入口)で起動できる
      await writeFile(brokerPid, "not-a-pid");
      const fg = await openroly(["broker"], env);
      expect(fg.code).toBe(0);
      expect(fg.out).toContain("spawn");
      expect(fg.err).not.toContain("already running");
      // 起動後は pid file が新鮮な形式で置き換わっている
      const pidRaw = (await readFile(brokerPid, "utf8")).trim();
      expect(pidRaw).not.toBe("not-a-pid");
      expect(brokerHome.length).toBeGreaterThan(0); // env が変わっていないことの smoke
    },
    30_000,
  );
});

// ---- PBI-0162: CI(ubuntu)で launchd 経路が skip される穴を塞ぐ ----
// 上の 6 本は darwin でしか回らない。**skip した分を「何も測っていない」にしない**ため、
// 「launchd 経路は platform で閉じている」という契約自体をここで測る ——
// source 側は全 platform で、振る舞い側は darwin 以外で(darwin では上の 6 本が本物を測る)。
describe("launchd 経路の platform 境界 (PBI-0162)", () => {
  test("source: launchd の起動と登録は darwin に閉じている", async () => {
    const src = await readFile(join(import.meta.dir, "../src/openroly.ts"), "utf8");
    // ① login の統一入口: darwin でだけ launchd を先に試す
    expect(src).toContain('process.platform === "darwin" && (await tryInstallLaunchdBroker())');
    // ② `openroly broker install`: darwin 以外は理由を出して止まる(登録だけして動かない状態を作らない)
    expect(src).toContain('if (process.platform !== "darwin") fail("broker install is macOS (launchd) only");');
  });

  test.skipIf(process.platform === "darwin")(
    "darwin 以外では broker install が理由付きで exit 1(plist を書かない)",
    async () => {
      const { env, home, plistPath } = await freshEnv({ launchctl: { list: 1, load: 0, unload: 0 } });
      await saveBrokerCredential(home, "par_non_darwin");
      const res = await openroly(["broker", "install"], env);
      expect(res.code).toBe(1);
      expect(res.err).toContain("macOS (launchd) only");
      await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    },
    30_000,
  );
});
