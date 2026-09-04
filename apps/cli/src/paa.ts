#!/usr/bin/env bun
import {
  accountBaseUrl,
  apiCall,
  binDir,
  DEFAULT_BASE_URL,
  doctorRuntime,
  ensureBinary,
  fetchBrief,
  formatBrief,
  formatStatusline,
  getCredential,
  installRuntime,
  loadCredentials,
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  paaHome,
  pairRuntime,
  reconcile,
  RUNTIME_CLI_NOT_FOUND,
  saveAccountUrl,
  saveCredential,
  uninstallRuntime,
  type AdapterContext,
  type Finding,
  type PairPrompt,
  type RuntimeAdapter,
  type RuntimeCredential,
} from "@paa/adapter";
import { CREDENTIAL_CHECK_FAILED, CREDENTIAL_OWNED_BY_HUMAN } from "@paa/core";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROVIDERS, isAgentProvider, runAgent } from "./agent.ts";
import { ADAPTERS, findAdapter, SUPPORTED_IDS } from "./registry.ts";

// paa —— Personal Agent Account の入口(配布戦略 §7.2 Common Installation Engine の CLI 面)。
// plugin-first UX でもここを通るので、pairing / install / 診断のロジックは 1 系統。

const USAGE = `atn —— All Together Now

Usage: atn <command>
       (from a repo checkout: bun run atn <command>)

  login                  Start here. Connects this machine to your account and starts the broker
                         (on macOS it registers a launchd agent; falls back to a detached process)
  broker                 Run the broker in the foreground (what login / launchd invoke)
  broker install         Register the broker with launchd (auto-starts after reboot; macOS only)
  broker uninstall       Remove the launchd registration
  broker status          Show plist / launchd job / process state
  install <runtime>     Pair a runtime and register the MCP server in it
  adopt                 Materialize an issued credential (called by the broker; non-interactive)
  uninstall <runtime>   Remove the MCP registration and the local credential
  pair <runtime>        Pair only
  status                Who is attached and what is unread (counts only, never bodies)
  statusline [--refresh] One line for a status bar (--refresh re-fetches and writes the cache)
  doctor [runtime]      Diagnose the connection
  runtimes              Supported runtimes and their connection state
  extensions            Desired extensions + per-runtime status
  sync [runtime]        Run Extension Sync (all attached runtimes when omitted)
  admin recover <handle>
                        Operator only: issue one session for an account that lost its token
                        (needs $PAA_ADMIN_TOKEN — the same value as the server's env)

  agent <provider> --thread <id>
                        Run an external API provider as this machine's runtime for one turn and
                        hand the draft reply to the thread (${AGENT_PROVIDERS.join(" / ")})

  --url <base-url>      Account API (default: $PAA_URL, then the URL 'atn login' connected to,
                        then ${DEFAULT_BASE_URL})
  --repair              Recreate the credential on install
  --dry-run             On sync, print the plan without writing to native config / DB
  --no-open             Don't open the approval URL automatically (login / install / pair)
  --foreground          Run the broker in the foreground on login instead of detached
  --thread <id>         Thread the agent replies to
  --model <name>        Model the agent uses (default per provider; $PAA_AGENT_MODEL also works)
  --wait <sec>          Max seconds the agent waits for connection approval (default 300; 0 = don't wait)

Supported runtimes: ${SUPPORTED_IDS.join(", ")}`;

const ctx: AdapterContext = { env: process.env };

/**
 * 明示された Account API の URL。指定が無ければ undefined を返す ——
 * ここで既定値に潰すと install 側が「既存 credential と違う server を指された」と誤認し、
 * リモートに pair 済みの人の credential を localhost へ張り替えてしまう
 */
function baseUrlOf(args: string[]): string | undefined {
  const i = args.indexOf("--url");
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  return process.env.PAA_URL;
}

/**
 * 接続コードを **端末の画面に出す**(PBI-0237 AC-2)。
 *
 * 以前は `verification_uri_complete`(= `?user_code=` 付きの URL)を 1 本印刷し、browser も
 * その URL で開いていた —— **その 1 本を人に送るだけで、受け取った側が 1 押しで承認できた**
 * (device code flow の remote phishing。RFC 8628 §5.4)。今 URL が指すのは
 * 打つ欄だけの `/connect` で、code は **この行にしか無い**。
 */
function showPrompt(prompt: PairPrompt): void {
  console.log(`
  1. Open in a browser: ${prompt.verification_uri}
  2. Type this code:    ${prompt.user_code}
  3. Press "Approve" on the account side (within ${Math.round(prompt.expires_in / 60)} minutes)

  Waiting for approval...`);
  maybeOpenBrowser(prompt.verification_uri);
}

/**
 * 承認 URL を OS のブラウザで自動的に開く(login/install/pair 共通)。
 * 抑止条件(いずれか true なら開かない): `--no-open` / `PAA_NO_BROWSER=1` / 非 TTY / CI。
 * open コマンド自体の起動失敗は握り潰す —— URL は既に表示済みで、pairing の polling は継続する。
 */
function maybeOpenBrowser(url: string): void {
  if (args.includes("--no-open")) return;
  if (process.env.PAA_NO_BROWSER === "1") return;
  if (process.env.CI) return;
  if (!process.stdout.isTTY) return;
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // open できなくても URL は表示済み
  }
}

/**
 * broker の常駐先(pid file / log)。起動経路は launchd(darwin・PBI-0048)と detached spawn(fallback)の
 * 2 つだが、二重起動判定はどちらも同じ pid file(`claimBrokerPidFile` / `runningBrokerPid`)で行う
 */
function brokerHome(): string {
  return process.env.PAA_BROKER_HOME ?? join(homedir(), ".atn", "broker");
}
const brokerPidPath = () => join(brokerHome(), "broker.pid");
const brokerLogPath = () => join(brokerHome(), "broker.log");

const psBin = () => Bun.which("ps") ?? "/bin/ps";

async function psColumn(pid: number, column: "lstart" | "comm"): Promise<string | null> {
  try {
    const proc = Bun.spawn([psBin(), "-o", `${column}=`, "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim().replace(/\s+/g, " ");
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/**
 * プロセスの起動時刻(`ps -o lstart=`。秒精度)。プロセスが無ければ null。
 * pid だけでは「その番号のプロセスが生きているか」しか分からず、再起動後に前回 boot の pid が
 * 無関係なプロセス(pid 1 の launchd 等)に当たると「broker 生存」と誤判定して二度と起動できなくなる
 * (PBI-0048 レビュー AC-X3)。pid file には pid と起動時刻を対で書き、両方一致した時だけ生存とみなす
 */
const processStartTime = (pid: number) => psColumn(pid, "lstart");

/** pid file の 1 行。`<pid> <lstart>`。起動時刻が取れない(既に死んでいる)時は pid だけ */
async function pidRecord(pid: number): Promise<string> {
  const start = await processStartTime(pid);
  return start ? `${pid} ${start}` : String(pid);
}

/**
 * pid file が「今生きている broker」を指していればその pid。
 * - `<pid> <lstart>`(現行形式): その pid の現在の起動時刻が一致する時だけ生存
 * - `<pid>` のみ(旧形式 / 起動時刻が取れなかった行): 実行ファイル名が `atn-broker` の時だけ生存
 *   (更新前に起動した本物の broker を殺さず、再利用された無関係な pid は拾わない)
 */
async function runningBrokerPid(): Promise<number | undefined> {
  let raw: string;
  try {
    raw = (await readFile(brokerPidPath(), "utf8")).trim();
  } catch {
    return undefined;
  }
  const m = /^(\d+)(?:\s+(.+))?$/.exec(raw);
  if (!m) return undefined;
  const pid = Number(m[1]);
  const start = await processStartTime(pid);
  if (start === null) return undefined;
  if (m[2]) return start === m[2].replace(/\s+/g, " ") ? pid : undefined;
  const comm = await psColumn(pid, "comm");
  return comm !== null && /(^|\/)atn-broker$/.test(comm) ? pid : undefined;
}

/** repo checkout の root(broker binary の既定探索先の基点。apps/cli/src/ から 3 階層上) */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * broker binary の解決。`PAA_BROKER_BIN` は明示指定として fallback しない
 * (`PAA_CLI` と同じ設計)。未指定なら release → debug → 公開 Release からの取得先(PBI-0154) →
 * PATH の `atn-broker` の順。**見つからなければ null** —— 呼び出し側は spawn より前
 * (launchd 登録より前)に build 案内で止まる。launchd に登録してから binary 不在に気付くと、
 * 案内は launchd が起こす `atn broker` の log にしか出ず、`KeepAlive` が 10 秒毎に再起動し続ける
 * (PBI-0048 レビュー AC-X2)
 */
function resolveBrokerBin(): string | null {
  if (process.env.PAA_BROKER_BIN) {
    return existsSync(process.env.PAA_BROKER_BIN) ? process.env.PAA_BROKER_BIN : null;
  }
  const release = join(REPO_ROOT, "broker", "target", "release", "atn-broker");
  if (existsSync(release)) return release;
  const debug = join(REPO_ROOT, "broker", "target", "debug", "atn-broker");
  if (existsSync(debug)) return debug;
  const downloaded = join(binDir(), "atn-broker");
  if (existsSync(downloaded)) return downloaded;
  return Bun.which("atn-broker");
}

const BROKER_BUILD_HINT =
  "The broker binary was not found. Run 'cargo build --release --manifest-path broker/Cargo.toml'\n" +
  "  (your credential is saved; after the build, 'atn broker' starts it)";

/**
 * repo checkout も cargo も無い配布先(README の Quickstart)向け: broker binary がどこにも
 * 無ければ公開 Release から取得を試みる(PBI-0154)。取れなくても黙って cargo 案内(呼び出し側の
 * `BROKER_BUILD_HINT`)に倒す —— network が無いだけで `atn login` を失敗させない。
 * checksum 不一致だけは特別扱いする: 「build し直せ」という cargo 案内は誤りなので、
 * ここで壊れている旨を出して止める
 */
async function ensureBrokerBinary(): Promise<void> {
  const found = resolveBrokerBin();
  // 手元 build / PATH / `PAA_BROKER_BIN` が在るならそれを使う(取りに行かない)。**取得先に置いた物
  // だけは毎回 ensureBinary に通す** —— ここで「在るから何もしない」にすると、paa を新しくしても
  // broker だけ初回に取った版のまま固定される(版が同じなら stamp を見て present で即返るので、
  // 通しても download は起きない)
  if (found && found !== join(binDir(), "atn-broker")) return;
  const outcome = await ensureBinary("atn-broker");
  if (outcome.status === "checksum_mismatch") {
    fail(`NG the downloaded file is corrupt: ${outcome.detail}`);
  }
}

/**
 * broker(Rust)へ渡す env。`PAA_CLI` は dev repo で `atn` が PATH に無いため必須(broker/src/adopt.rs)。
 * argv0 は `process.execPath`(bun 自体の絶対 path)にする —— launchd 環境は最小 PATH しか持たず
 * bare な `"bun"` を解決できないため(PBI-0048。detached spawn は `process.env` を継承するので
 * 従来の `"bun"` 決め打ちでも動いていたが、launchd 経由では broker(Rust)が起こす `atn adopt` が
 * 解決に失敗する)
 */
function brokerEnv(credential: RuntimeCredential): Record<string, string> {
  return {
    ...process.env,
    PAA_RUNTIME_TOKEN: credential.token,
    PAA_BROKER_WS_URL: `${credential.base_url.replace(/^http/, "ws")}/v1/broker/ws`,
    PAA_CLI: `${process.execPath}:${fileURLToPath(import.meta.url)}`,
  } as Record<string, string>;
}

/**
 * 前景で broker を起こし、終了コードをそのまま返す(`--foreground` / `broker` command / launchd)。
 * launchd 経由・手動前景どちらで起きても同じ pid file 排他生成を通す(PBI-0048) —— これにより
 * 「今 broker が生きているか」の判定(`runningBrokerPid`)が起動経路によらず一本化される
 */
async function runBrokerForeground(credential: RuntimeCredential): Promise<number> {
  const bin = resolveBrokerBin();
  if (!bin) fail(BROKER_BUILD_HINT);
  await mkdir(brokerHome(), { recursive: true });
  if (!(await claimBrokerPidFile())) fail("The broker is already running (the pid file points at a live process)");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([bin], {
      env: brokerEnv(credential),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    await rm(brokerPidPath(), { force: true });
    fail(BROKER_BUILD_HINT);
  }
  await writePidFileAtomic(child.pid);
  return await child.exited;
}

type DetachedOutcome = "started" | "already_running" | "build_needed";

/**
 * pid file を torn-write の窓無く書き換える。`writeFile(path, …)` を直接呼ぶと
 * open→truncate→write の間に他プロセスが「部分的に書かれた内容」を読み得る ——
 * 実測: 5 桁の pid を書いている最中に別プロセスが読むと "401"(先頭 3 桁だけ)のような
 * 半端な数値になり、それが偶然どのプロセスの pid でもないと「死んでいる」と誤判定して
 * 二重起動を許してしまう。`credentials.ts` の `writeCredentials` と同じ temp file + `rename`
 * にする —— rename は「置き換え先の内容が旧か新かのどちらか」しか見せない
 */
async function writePidFileAtomic(pid: number): Promise<void> {
  const tmp = `${brokerPidPath()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, await pidRecord(pid));
  await rename(tmp, brokerPidPath());
}

/** stale pid file の取り直しを直列化する lock(dir)。持ち主が途中で死んで残った時の回収閾値 */
const brokerClaimLockPath = () => join(brokerHome(), "broker.pid.lock");
const STALE_LOCK_MS = 10_000;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `mkdir` の「無ければ作る / 有れば EEXIST」を mutex に使い、`fn` を 1 プロセスずつ実行する。
 * 先客がいる間は短く待って再試行し、閾値を超えて古い lock は持ち主のクラッシュとみなして回収する。
 *
 * 待ち切れなかった時に**「先客が起動したはず」という値を返さない**(PBI-0218)。以前はここで
 * `fallback = false`(= 他が起動中)を返していたので、先客が起動前に終了していると全員が
 * 「他が起動中」と判断して**誰も broker を起こさないまま終わる**。lock を取れたかどうかだけを
 * 呼び出し側に返し、譲る / 取りにいくの判断は呼び出し側が pid file を**読み直して**決める
 */
type LockOutcome<T> = { acquired: true; value: T } | { acquired: false };

async function withStaleTakeoverLock<T>(fn: () => Promise<T>): Promise<LockOutcome<T>> {
  const lock = brokerClaimLockPath();
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await mkdir(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await sleepMs(50);
      continue;
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  return { acquired: false };
}

/**
 * 譲るか取るかが決まらないまま粘る上限。`STALE_LOCK_MS` より十分長く取る —— 持ち主が死んで
 * 残った lock は `STALE_LOCK_MS` 経過後に回収されるので、この上限に達したということは
 * **生きた誰かが lock を握り続けている**(＝その誰かが起動の可否を決めに行っている)を意味する。
 * 短くすると「回収を待てば取れたのに諦めた」= 誰も起動しない、に戻る
 */
const CLAIM_DEADLINE_MS = 20_000;

/**
 * pid file の排他生成を早い者勝ちの lock として使う。`link()` は「target が無ければ作る、
 * 有れば EEXIST」を **1 回の atomic 操作**で行う —— `open(path,"wx")` の後に別の `write` を
 * 呼ぶ 2 段階方式と違い、target が他プロセスから見える瞬間には(temp file へ先に書き終えた)
 * 内容が既に完成している(torn write の窓が無い)。
 *
 * stale file(前回クラッシュ / 再起動で残った死んだ pid)の再利用は **`withStaleTakeoverLock` の
 * 中で 1 プロセスずつ**行う。lock 無しの `readFile → rm → link` では、後発の `rm` が先発の
 * `link` 済み file を消す窓が残り、2 本同時の `atn login` が両方 spawn した
 * (20 回に 1 回。PBI-0046 レビュー AC-X3)。
 *
 * **譲る根拠は「生きた broker を確認できた」だけ**(PBI-0218)。「先客がいたはず」「内容が読めない」
 * のような**仮定で false を返さない** —— 仮定で譲ると、先客が起動前に終了していた時に全員が
 * 譲って broker が 1 本も上がらず、`atn login` だけが成功したように見える(hero ③ が黙って崩れる)。
 * 判定が付かない間は「読み直して決め直す」を上限付きで繰り返す
 */
async function claimBrokerPidFile(): Promise<boolean> {
  await mkdir(brokerHome(), { recursive: true });
  const tmp = `${brokerPidPath()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, await pidRecord(process.pid));
  const tryLink = async (): Promise<boolean> => {
    try {
      await link(tmp, brokerPidPath());
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  /**
   * pid file が「生きた broker(or それを起こす途中の CLI)」を指していない = 取り直してよい。
   * 空 / 数字でない / 途中で切れた行も**ここでは「壊れている」に倒す** —— pid file は
   * `link`(完成した temp からの atomic な出現)と `rename`(atomic な置換)でしか書かれないので、
   * 「書きかけを覗いた」状態は存在せず、判定不能 = 誰の物でもない。
   * ここを「不明だから譲る」に倒すと、空の broker.pid 1 つで `atn login` が
   * **恒久的に**「already running」と言い続けて 1 本も起動しない(PBI-0218 AC-X2)
   */
  const takeOver = async (): Promise<"claimed" | "yield" | "retry"> => {
    if (await runningBrokerPid()) return "yield";
    await rm(brokerPidPath(), { force: true });
    return (await tryLink()) ? "claimed" : "retry";
  };
  try {
    const deadline = Date.now() + CLAIM_DEADLINE_MS;
    for (;;) {
      if (await tryLink()) return true;
      // pid file が在る。**生きたプロセスを指している時だけ**譲る
      if (await runningBrokerPid()) return false;
      const outcome = await withStaleTakeoverLock(takeOver);
      if (outcome.acquired && outcome.value !== "retry") return outcome.value === "claimed";
      // lock を取れなかった / 取ったが横から link された。**仮定で終わらせず読み直して決め直す**。
      // ここで lock の外で `rm → link` に逃げてはいけない —— 後発の `rm` が先発の `link` 済み file を
      // 消す窓が開き、PBI-0046 レビュー AC-X3 の「2 本同時が両方 spawn」がそのまま戻る
      if (Date.now() > deadline) return false;
      await sleepMs(20 + Math.floor(Math.random() * 40));
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/** `login` から呼ぶ detached 起動。pid file が生きているプロセスを指していれば二重起動しない */
async function startBrokerDetached(credential: RuntimeCredential): Promise<DetachedOutcome> {
  if (await runningBrokerPid()) return "already_running";
  const bin = resolveBrokerBin();
  if (!bin) return "build_needed";
  await mkdir(brokerHome(), { recursive: true });
  if (!(await claimBrokerPidFile())) return "already_running";
  const log = await open(brokerLogPath(), "a");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([bin], {
      env: brokerEnv(credential),
      stdin: "ignore",
      stdout: log.fd,
      stderr: log.fd,
    });
  } catch {
    await log.close();
    await rm(brokerPidPath(), { force: true });
    return "build_needed";
  }
  // claim 時に書いた自分(CLI)の pid を、起こした broker の pid に差し替える(temp + rename)
  await writePidFileAtomic(child.pid);
  child.unref();
  await log.close();
  return "started";
}

// ---------- launchd 常駐(darwin。PBI-0048) ----------
// 実マシンの ~/Library/LaunchAgents と実 launchctl には test から絶対に触れない —— PAA_BROKER_BIN /
// PAA_CLI と同じ設計で、常に env 経由の差し替え口を通す。

/**
 * plist が焼いた「login 時の PATH」の別名(PBI-0236)。**この env が在る = 今の PATH は写し**
 * という 1 つの意味しか持たない —— 在る時だけ `atn adopt` が login shell を起こす。
 * 人が手で打つ `atn install` / `atn adopt`、test、detached 起動には無いので probe は走らない。
 */
const LOGIN_PATH_SNAPSHOT = "PAA_LOGIN_PATH";

/** login shell の出力から PATH だけを切り出す marker。rc file の挨拶が混ざっても拾える */
const LOGIN_PATH_MARK = "__ATN_PATH__";
/** interactive な rc file(oh-my-zsh 等)が重い端末でも、ここで諦めて snapshot に落ちる */
const LOGIN_SHELL_TIMEOUT_MS = 5000;

/**
 * 締切付きで stream を読み切る(PBI-0236 レビュー 2026-09-04)。締切を過ぎたら **stream を cancel して**
 * `null` を返す —— shell を kill するだけでは足りない: rc file が起こした背景 daemon
 * (powerlevel10k の gitstatusd・zsh-async・mise 等)は shell の stdout を継承するので、
 * shell が死んでも pipe は開いたままで、読みが終わらない。実測でこの経路が 37 秒待った
 * (broker の `ADOPT_TIMEOUT` = 60 秒を食い潰し、PBI-0190 が直した「MCP が 1 つも登録されない」に戻る)。
 * cancel は fd も手放すので、`atn adopt` 自身の終了も背景の子に人質に取られない。
 */
async function readWithDeadline(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  return expired ? null : out;
}

/** `-l -i -c` と `"$PATH"` を POSIX どおりに解釈する shell だけを起こす(fish は list なので別物) */
const LOGIN_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

/**
 * **今の** login shell が持つ PATH を 1 回だけ読む(PBI-0236)。取れなければ `null`。
 *
 * `-i` が要るのは nvm / rbenv / mise の init が `.zshrc` に居るため —— zsh は `.zshrc` を
 * interactive の時しか読まないので、`-l` だけでは「版を切り替えた」が反映されない。
 * 代わりに interactive は遅い・喋る・入力を待つので、**stdin は /dev/null・stderr は捨てる・
 * 5 秒で読みを打ち切って stream ごと捨てる**の 3 点で閉じ込め、出力は marker で挟んで切り出す。
 *
 * 返す前に「PATH の形か」を見る(2 つ以上の絶対 path)。fish のように `"$PATH"` が空白区切りに
 * なる shell を allowlist の外に置いた上で、**出力側でももう一度**弾く —— 壊れた PATH を
 * 先頭に載せるのは、PATH を取り直さないより悪い。
 */
async function freshLoginPath(): Promise<string | null> {
  const override = process.env.PAA_LOGIN_SHELL;
  if (override === "") return null; // 明示的に無効化(probe を望まない端末・test の口)
  const shell = override ?? process.env.SHELL ?? "/bin/zsh";
  if (override === undefined && !LOGIN_SHELLS.has(shell.split("/").pop() ?? "")) return null;
  const script = `printf '${LOGIN_PATH_MARK}%s${LOGIN_PATH_MARK}' "$PATH"`;
  const proc = (() => {
    try {
      return Bun.spawn([shell, "-l", "-i", "-c", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      return null; // shell が実在しない / 実行権が無い
    }
  })();
  if (!proc) return null;
  // 締切は **読む側**に置く。`proc.kill(9)` だけでは背景の子が握った stdout が閉じない
  const out = await readWithDeadline(proc.stdout, LOGIN_SHELL_TIMEOUT_MS);
  proc.kill(9); // 黙り込んだ shell 本体もここで落とす(既に終わっていれば no-op)
  if (out === null) return null;
  const parts = out.split(LOGIN_PATH_MARK);
  const dirs = (parts.length >= 3 ? parts[1]! : "").split(":").filter(Boolean);
  if (dirs.length < 2 || !dirs.every((d) => d.startsWith("/"))) return null;
  return dirs.join(":");
}

/**
 * `atn adopt` が runtime CLI(`codex mcp add` 等)を起こす時の env(PBI-0236)。
 *
 * `PAA_LOGIN_PATH` が無い = 自分の PATH は今の環境そのもの → **何もしない**。
 * 在る時だけ「今の login shell の PATH」→「焼いた snapshot」→「今の PATH」の順に繋いで重複を落とす。
 * **fresh を先頭に置く**のが要点 —— 版を切り替えた人の古い dir がまだ実在する時、後ろに置くと
 * 古い方が先に解決されて AC-1 が閉じない。snapshot を捨てずに後ろへ残すのは、login を打った
 * shell にしか無かった dir(direnv 等)を落とさないため。probe が失敗すれば snapshot だけ = 今日と同じ。
 */
async function adoptEnv(): Promise<Record<string, string | undefined>> {
  const snapshot = process.env[LOGIN_PATH_SNAPSHOT];
  if (!snapshot) return process.env;
  const fresh = await freshLoginPath();
  const merged = [
    ...(fresh ?? "").split(":"),
    ...snapshot.split(":"),
    ...(process.env.PATH ?? "").split(":"),
  ].filter(Boolean);
  const path = [...new Set(merged)].join(":");
  // 診断は **stdout** へ(broker は stdout を捨てる)。stderr は失敗理由 1 行だけの場所で、
  // ここに書くと broker が拾う `register_ack.detail` が診断行に化ける
  console.log(`adopt: PATH ${fresh ? "refreshed from the login shell" : "kept from the plist snapshot"}`);
  return { ...process.env, PATH: path };
}

function launchAgentsDir(): string {
  return process.env.PAA_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
}
const LAUNCHD_LABEL = "com.atn.broker";
const plistPath = () => join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
const launchctlBin = () => process.env.PAA_LAUNCHCTL ?? "launchctl";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * plist は world-readable な file なので **token を絶対に書かない**(§4 と同格の secret 漏洩)。
 * `atn broker` は起動時に credentials.json(0600)から自分で token を読む(PBI-0046)ので、
 * plist が運ぶのは argv と(test の隔離環境を launchd 経由でも保つための)非 secret env だけ。
 * argv0 に `process.execPath` を使うのは launchd の最小 PATH が bare な `"bun"` を解決できないため。
 */
function plistXml(): string {
  const args = [process.execPath, fileURLToPath(import.meta.url), "broker"];
  const argXml = args.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  // **PATH も渡す**(PBI-0190) —— launchd の既定 PATH は `/usr/bin:/bin:/usr/sbin:/sbin` しか無く、
  // adopt が呼ぶ **runtime 側の CLI** が解決できない(2026-09-04 実測:
  // `codex mcp add failed: env: node: No such file or directory`)。argv0 に execPath を使って
  // bun だけ解決していたが、その先で呼ばれる CLI の PATH は誰も面倒を見ていなかった。
  // login を打った shell の PATH をそのまま焼く —— その shell で runtime CLI が動いていたのだから、
  // 同じ PATH なら adopt も動く
  //
  // **焼いた PATH は snapshot**(PBI-0236) —— nvm / rbenv / mise を使う人が後で版を切り替えると
  // ここは古い版の dir を指したままになり、`codex` の shebang が呼ぶ `node` が消える。
  // そこで **同じ値を `PAA_LOGIN_PATH` にも焼く**: これは `atn adopt` に対する
  // 「お前が今持っている PATH は login の瞬間の写しだ」という印で、adopt はこれが在る時だけ
  // login shell を起こして今の PATH を取り直す。`SHELL` はその時に起こす shell
  // (launchd の env には無い)。`PATH` を止めないのは broker(Rust) の discovery が
  // `env::var_os("PATH")` を見るため —— 外すと PBI-0190 の半分が戻る。
  const passthroughKeys = ["PAA_HOME", "PAA_BROKER_HOME", "PAA_BROKER_BIN", "PAA_URL", "PATH", "SHELL"] as const;
  const plistEnv: [string, string][] = passthroughKeys
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]!]);
  if (process.env.PATH) plistEnv.push([LOGIN_PATH_SNAPSHOT, process.env.PATH]);
  const envEntries = plistEnv
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");
  const logPath = escapeXml(brokerLogPath());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>${
    envEntries
      ? `
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>`
      : ""
  }
</dict>
</plist>
`;
}

async function runLaunchctl(args: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const proc = Bun.spawn([launchctlBin(), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, detail: (stderr.trim() || stdout.trim()) as string };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * darwin 専用。既に load 済み(`launchctl list`)なら何もせず成功扱い —— 重複 load は環境によって
 * エラーになるため、「re-load しない」で冪等性を担保する(PBI-0048 不確実性欄)。
 */
async function tryInstallLaunchdBroker(): Promise<boolean> {
  const already = await runLaunchctl(["list", LAUNCHD_LABEL]);
  if (already.ok) return true;
  try {
    await mkdir(brokerHome(), { recursive: true });
    await mkdir(launchAgentsDir(), { recursive: true });
    await writeFile(plistPath(), plistXml());
  } catch {
    return false;
  }
  return (await runLaunchctl(["load", "-w", plistPath()])).ok;
}

type StartOutcome = DetachedOutcome | "started_launchd";

/**
 * `login` が呼ぶ統一入口。darwin は launchd 常駐を優先し、失敗時のみ detached へ fallback する。
 * binary の有無は **launchd 登録より前**に確かめる(登録してから気付いても launchd 側で失敗し続けるだけ)
 */
async function startBroker(credential: RuntimeCredential): Promise<StartOutcome> {
  if (await runningBrokerPid()) return "already_running";
  if (!resolveBrokerBin()) return "build_needed";
  if (process.platform === "darwin" && (await tryInstallLaunchdBroker())) return "started_launchd";
  return startBrokerDetached(credential);
}

function printFindings(findings: Finding[]): boolean {
  for (const f of findings) console.log(`  ${f.ok ? "OK " : "NG "} ${f.label}: ${f.detail}`);
  return findings.every((f) => f.ok);
}

/**
 * 繋がった先の account。**確かめられなかったこと**を undefined に潰さず理由と一緒に持つ ——
 * 「@? という account に繋がった」に読める表示を作らない為(PBI-0234 AC-X1)。
 */
type ConnectedAccount = { handle: string } | { handle: undefined; detail: string };

/** whoami を待つ上限。接続そのものは済んでいるので、遅い server に完了報告ごと張り付かない */
const ACCOUNT_CONFIRM_TIMEOUT_MS = 10_000;

/**
 * 繋がった先の account を 1 回だけ確かめる。**例外を投げない** —— ここで throw すると
 * 「繋がったのに何も表示されない」になり、名乗ること自体が失敗経路で丸ごと消える。
 */
async function confirmAccount(credential: RuntimeCredential): Promise<ConnectedAccount> {
  try {
    const who = await apiCall(credential.base_url, "/v1/whoami", {
      token: credential.token,
      signal: AbortSignal.timeout(ACCOUNT_CONFIRM_TIMEOUT_MS),
    });
    if (who.status === 200 && typeof who.body?.handle === "string") return { handle: who.body.handle };
    return {
      handle: undefined,
      detail: who.status === 401 ? "the credential was rejected (401)" : `whoami returned ${who.status}`,
    };
  } catch (e) {
    return { handle: undefined, detail: `whoami could not be reached (${(e as Error).message})` };
  }
}

/**
 * 接続の完了表示。**繋がった先の @account を必ず名乗る**(PBI-0234)。
 *
 * `pending` の pairing 行は誰の物でもない(device code flow の性質・図6)ので、`user_code` を
 * 握った human は**自分の** account でその要求を承認できる。接続した本人が「どの account に
 * 入ったか」をその場で読めることが最後の砦なので、login / install / pair の 3 経路は必ず
 * ここを通す —— 文言を各 case に散らすと、次に直す人がまた 1 経路だけ直す。
 */
async function reportConnected(
  credential: RuntimeCredential,
  subject: string,
  tail = "",
  account?: ConnectedAccount,
): Promise<void> {
  const who = account ?? (await confirmAccount(credential));
  if (who.handle !== undefined) {
    console.log(`\n${subject} is now connected to @${who.handle}.${tail}`);
    return;
  }
  // 「繋がった」と「どの account かは確かめられなかった」を**両方**言う。片方だけにすると、
  // 他人の account に入っていた時に気づく手掛かりが消える(@? は後者を前者に見せかける)
  console.log(
    `\n${subject} is now connected, but the account it landed in could not be confirmed ` +
      `(${who.detail}). Open Settings → Connected runtimes on the web to see which account has it`,
  );
}

function requireAdapter(id: string | undefined) {
  if (!id) fail(`Specify a runtime (${SUPPORTED_IDS.join(", ")})`);
  const adapter = findAdapter(id);
  if (!adapter) {
    fail(`Unsupported runtime: ${id}\nSupported: ${SUPPORTED_IDS.join(", ")}`);
  }
  return adapter;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const [command, ...args] = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const baseUrl = baseUrlOf(args);

/** `--flag value` を 1 つ読む(値が無ければ undefined) */
/**
 * `atn login` が名乗る名前(PBI-0227 AC-4)。**この文字列が承認画面にそのまま出る** ——
 * 承認する人はこれだけを頼りに「自分の Mac か」を決めるので、hostname を必ず載せる
 * (server 既定の "unnamed runtime" に落ちると、送りつけられた code と自分の端末が見分けられない)。
 * 逆に os の user 名・mail は載せない —— この面は **user_code を握った相手にも見える**ので、
 * 端末の識別に要らない個人情報は増やさない。
 */
function loginRuntimeName(): string {
  return hostname().trim() || "this machine (no hostname)";
}

function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : undefined;
}

switch (command) {
  case "login": {
    // 冪等性: broker credential が有効ならこの Mac は既に接続済みとして扱い、pair し直さない。
    // 複数 account は非対応 —— 別 account の credential が残っていても whoami 200 なら同一とみなす。
    // ただし `--url` で別 server を明示された時は既存 credential を無条件には使い回さない
    // (installRuntime の urlChanged と同じ理由 —— 旧 server の token を新 server 宛てに使い回すと
    // 「接続しました」の表示だけが嘘になる)
    const requestedUrl = baseUrl?.replace(/\/$/, "");
    let credential = await getCredential("broker");
    if (credential && requestedUrl != null && credential.base_url !== requestedUrl) {
      credential = undefined;
    }
    let account: ConnectedAccount | undefined;
    if (credential) {
      account = await confirmAccount(credential);
      // 確かめられない credential は使い回さない(既存挙動 —— whoami が 200 でなければ再 pairing)
      if (account.handle === undefined) {
        credential = undefined;
        account = undefined;
      }
    }
    if (!credential) {
      const outcome = await pairRuntime({
        // 2 度目の login(credential が失効した端末)も、前回 login した server へ戻る(図7.1)
        baseUrl: await accountBaseUrl(requestedUrl),
        kind: "broker",
        name: loginRuntimeName(),
        onPrompt: showPrompt,
      });
      if (outcome.status === "denied") fail("NG pairing was denied");
      if (outcome.status === "expired") fail("NG pairing expired. Run it again");
      if (outcome.status === "failed") fail(`NG pairing failed: ${outcome.detail}`);
      credential = outcome.credential;
      account = await confirmAccount(credential);
    }
    // **login が決めた URL を account の既定にする**(PBI-0246・図7.1)。以後 `--url` 無しの
    // pair / install / doctor はここへ行く —— 書き戻すのは pairing が実際に成功した URL
    // (`credential.base_url`)であって要求値ではない。名乗る先と繋ぐ先を割らない。
    // 既に接続済みの端末で `atn login` を打ち直した時も通るので、この機能より前に
    // login した端末もここで直る
    await saveAccountUrl(credential.base_url);
    // **broker を触る前に名乗る**(PBI-0234 AC-3b): already_running の break・build_needed の
    // fail・--foreground の 3 経路が、後ろに置いた handle 行を飛ばしていた
    await reportConnected(
      credential,
      "This machine",
      " The AIs on it are found automatically and appear under Your AI",
      account,
    );
    await ensureBrokerBinary();
    if (args.includes("--foreground")) {
      process.exit(await runBrokerForeground(credential));
    }
    const outcome = await startBroker(credential);
    if (outcome === "build_needed") fail(BROKER_BUILD_HINT);
    if (outcome === "already_running") {
      console.log("The broker is already running");
      break;
    }
    if (outcome === "started_launchd") {
      console.log(`Registered with launchd (${plistPath()}). It starts automatically after a reboot`);
    } else {
      console.log(`broker log: ${brokerLogPath()}`);
    }
    break;
  }

  case "broker": {
    const sub = target;
    if (sub === "install") {
      if (process.platform !== "darwin") fail("broker install is macOS (launchd) only");
      const credential = await getCredential("broker");
      if (!credential) fail("Not connected. Run 'atn login' first");
      if (!resolveBrokerBin()) fail(BROKER_BUILD_HINT);
      const ok = await tryInstallLaunchdBroker();
      if (!ok) fail(`NG registering with launchd failed (plist: ${plistPath()})`);
      console.log(`Registered with launchd (${plistPath()}). The broker starts automatically after a reboot`);
      break;
    }
    if (sub === "uninstall") {
      const existed = existsSync(plistPath());
      const unload = await runLaunchctl(["unload", plistPath()]);
      await rm(plistPath(), { force: true });
      console.log(
        `Removed the launchd registration${existed ? "" : " (there was no plist to begin with)"}` +
          (unload.ok || !existed ? "" : ` (warning on unload: ${unload.detail})`),
      );
      break;
    }
    if (sub === "status") {
      const plistInstalled = existsSync(plistPath());
      const list = await runLaunchctl(["list", LAUNCHD_LABEL]);
      const pid = await runningBrokerPid();
      console.log(`launchd plist: ${plistInstalled ? `installed (${plistPath()})` : "not installed"}`);
      console.log(`launchd job: ${list.ok ? "registered" : "not registered"}`);
      console.log(`broker process: ${pid ? `running (pid ${pid})` : "stopped"}`);
      break;
    }
    if (sub !== undefined) fail(`Unknown broker subcommand: ${sub}\nSupported: install / uninstall / status`);
    const credential = await getCredential("broker");
    if (!credential) fail("Not connected. Run 'atn login' first");
    process.exit(await runBrokerForeground(credential));
    break;
  }

  case "install": {
    const adapter = requireAdapter(target);
    const outcome = await installRuntime({
      adapter,
      ctx,
      baseUrl,
      onPrompt: showPrompt,
      repair: args.includes("--repair"),
    });
    if (outcome.status === "runtime_not_found") fail(`NG ${outcome.detail}`);
    if (outcome.status === "denied") fail("NG pairing was denied");
    if (outcome.status === "expired") fail("NG pairing expired. Run it again");
    if (outcome.status === "failed") fail(`NG pairing failed: ${outcome.detail}`);
    // credential.name は `<host> / <displayName>` なので、subject に displayName を足すと二重になる
    await reportConnected(
      outcome.credential,
      outcome.credential.name,
      outcome.paired ? "" : " The existing credential was reused.",
    );
    if (!printFindings(outcome.findings)) process.exit(1);
    console.log(`\nRestart ${adapter.displayName} and the @account tools become available`);
    break;
  }

  case "adopt": {
    // 自動登録(PBI-0023)の materialize 面。broker が hello の応答(`registered`)を受けて
    // 非対話で spawn する —— pairing は既に済んでいる(端末の承認が兼ねる。要件 §45.2)ので、
    // ここでやるのは credential の保存と MCP config の登録だけ。credentials.json の書式・lock 手順・
    // `claude mcp add` の呼び方の正本を TS 側 1 箇所に保つため、broker(Rust)には写さない。
    //
    // token は **stdin から**受ける。argv に載せると同一ホストの他プロセスから `ps` で見える。
    const kind = flagValue("--kind");
    const runtimeId = flagValue("--runtime-id");
    const url = flagValue("--base-url");
    const name = flagValue("--name");
    if (!args.includes("--token-stdin")) {
      fail("adopt: --token-stdin is required (the token is not accepted on argv)", 2);
    }
    if (!kind || !runtimeId || !url || !name) {
      fail("adopt: --kind / --runtime-id / --base-url / --name are required", 2);
    }
    // registry に entry があっても adapter 実装が無い runtime はここで落ちる(exit 2)。
    // Cloud 側も adapter:null は登録対象から外すので、ここに来るのは配布のずれ
    const adapter = findAdapter(kind);
    if (!adapter) fail(`adopt: unsupported runtime: ${kind}\nSupported: ${SUPPORTED_IDS.join(", ")}`, 2);
    const token = (await Bun.stdin.text()).trim();
    if (!token) fail("adopt: could not read the token from stdin", 2);
    const cleanUrl = url.replace(/\/$/, "");
    // 同じ端末に human が `atn install` で入れた同 kind の credential があれば奪わない(AC-11)。
    // credentials.json は kind 単位の 1 entry なので、上書きすると Cloud 側の既定 runtime
    // (getDefaultRuntime)と実際に認証する runtime がずれ、per-actor read state(§19/§23.1)が割れる。
    // 「どの credential がこの端末に居るか」は端末しか知らないので、判定は CLI 側に置く
    // (Cloud で「pair 行があれば登録しない」にすると、別の端末で pair 済みという正当な構成を潰す)。
    // 1 行目を bare token にするのは broker が stderr の 1 行目を reason にするため。
    //
    // fail-closed(PBI-0023 F2): 「生きているか確認できない」は「奪ってよい」ではない。
    // 確認が取れるのは相手が明示的に 401(= credential が既に失効している)を返した時だけで、
    // それ以外(200 = 生きている、5xx、network 到達不能で例外)は全部拒否する。到達不能を素通り
    // させると、server が落ちている・DNS が引けないだけで human の credential を上書きできてしまう
    // (実測: base_url を到達不能にすると旧実装は exit 0 で上書きしていた)。拒否しても損はない ——
    // 機械的失敗(retry)として server 側が次の hello で同じ id を再発行する
    const owned = await getCredential(adapter.id);
    if (owned && owned.runtime_id !== runtimeId) {
      const who = await apiCall(owned.base_url, "/v1/whoami", { token: owned.token }).catch(
        () => null,
      );
      if (who?.status !== 401) {
        console.error(who?.status === 200 ? CREDENTIAL_OWNED_BY_HUMAN : CREDENTIAL_CHECK_FAILED);
        console.error(
          `  ${adapter.displayName} is already connected as ${owned.name} (${owned.runtime_id}), or its state ` +
            `cannot be verified. Auto-registration will not replace it`,
        );
        process.exit(2);
      }
    }
    await saveCredential(adapter.id, {
      runtime_id: runtimeId,
      token,
      base_url: cleanUrl,
      name,
      paired_at: new Date().toISOString(),
    });
    try {
      // 起こす runtime CLI(とその shebang が呼ぶ node)は **今の** PATH で解決する(PBI-0236)。
      // launchd 経路以外では process.env がそのまま返る
      await adapter.register({ env: await adoptEnv() }, {
        serverEntry: MCP_SERVER_ENTRY,
        runtimeKind: adapter.id,
        baseUrl: cleanUrl,
        serverName: MCP_SERVER_NAME,
      });
    } catch (e) {
      // exit != 0 で broker が `register_ack ok:false` を返し、Cloud が行を revoke する
      // (credential だけ生きて MCP config が無い半端な状態を残さない)。
      // **1 行目が detail になる** ので、runtime CLI がどこにも無い時は named reason を行頭へ置く
      // (PBI-0236 AC-X1: broker 側の `paa_cli_not_found` = atn 自身が無い、と区別できるように)
      const message = (e as Error).message;
      fail(
        message.startsWith(RUNTIME_CLI_NOT_FOUND)
          ? message
          : `adopt: registering the MCP server failed: ${message}`,
        2,
      );
    }
    console.log(`adopt: connected ${adapter.displayName} as ${name} (${runtimeId})`);
    break;
  }

  case "uninstall": {
    const adapter = requireAdapter(target);
    const outcome = await uninstallRuntime({ adapter, ctx, baseUrl });
    console.log(
      `${adapter.displayName}: MCP registration ${outcome.unregistered ? "removed" : "could not be removed"} / ` +
        `credential ${outcome.credentialRemoved ? "removed" : "none"}`,
    );
    // 「未登録だった」と「CLI が壊れていて消せなかった」を混ぜない
    if (outcome.detail) console.log(`  reason: ${outcome.detail}`);
    console.log("To disconnect on the account side, use Settings → Connected runtimes on the web");
    break;
  }

  case "pair": {
    const adapter = requireAdapter(target);
    const outcome = await pairRuntime({
      // `?? DEFAULT_BASE_URL` に戻さないこと(PBI-0246・図7.1)—— login で URL を決めた人が
      // `atn pair claude` を打つと localhost に行って ConnectionRefused で死ぬ。
      // まだ pair していない runtime には引き継ぐ credential が無いので account の URL が要る
      baseUrl: await accountBaseUrl(baseUrl),
      kind: adapter.id,
      name: `${hostname()} / ${adapter.displayName}`,
      onPrompt: showPrompt,
    });
    if (outcome.status === "denied") fail("NG pairing was denied");
    if (outcome.status === "expired") fail("NG pairing expired");
    if (outcome.status === "failed") fail(`NG pairing failed: ${outcome.detail}`);
    await reportConnected(
      outcome.credential,
      `${outcome.credential.name} (${outcome.credential.runtime_id})`,
    );
    break;
  }

  case "status": {
    const credentials = (await loadCredentials()).runtimes;
    const entries = Object.entries(credentials);
    if (entries.length === 0) {
      fail("Not connected. Start with 'atn login'");
    }
    for (const [kind, credential] of entries) {
      const adapter = findAdapter(kind);
      console.log(`\n[${adapter?.displayName ?? kind}] ${credential.name}`);
      try {
        // 要件 §19: session 開始時に見せるのは metadata のみ(本文は出さない)
        console.log(formatBrief(await fetchBrief(credential.base_url, credential.token)));
      } catch (e) {
        console.log(`  NG ${(e as Error).message}`);
      }
    }
    break;
  }

  // PBI-0130: Claude Code の statusline に未読を出す。render 側(statusline.sh)は cache を
  // cat するだけなので、ここは「取り直して cache を更新する」背景側と、手で覗く読み出し側の 2 つ。
  case "statusline": {
    const cachePath = join(paaHome(), "statusline");
    if (!args.includes("--refresh")) {
      // 読み出しは network を触らない(statusline が HTTP を待たない事の担保)
      console.log((await readFile(cachePath, "utf8").catch(() => "")).trimEnd());
      break;
    }
    const credential = (await loadCredentials()).runtimes.claude;
    if (!credential) break; // 未接続なら黙って何もしない(statusline に error を出さない)
    try {
      const segment = formatStatusline(await fetchBrief(credential.base_url, credential.token));
      // atomic write —— 書きかけの空 file を statusline に読ませない。
      // 末尾に改行を付けない(cat した物がそのまま 1 行に載る)
      const tmp = `${cachePath}.tmp`;
      await writeFile(tmp, segment, { mode: 0o600 });
      await rename(tmp, cachePath);
      console.log(segment);
    } catch (e) {
      // server 断・auth 失効は「前の値を残す」。cache を消しも上書きもしない ——
      // 通信が切れた瞬間に statusline の表示が消えるのが一番わかりにくい。
      // 理由は stderr にだけ出す: statusline.sh は stderr を捨てるので表示は汚れず、
      // 手で `atn statusline --refresh` を叩いた時だけ原因が見える(黙って空になるのを避ける)
      console.error(`statusline refresh aborted: ${(e as Error).message}`);
    }
    break;
  }

  case "doctor": {
    let ok = true;
    for (const adapter of target ? [requireAdapter(target)] : ADAPTERS) {
      console.log(`\n[${adapter.displayName}]`);
      ok = printFindings(await doctorRuntime({ adapter, ctx, baseUrl })) && ok;
    }
    if (!ok) process.exit(1);
    break;
  }

  case "runtimes": {
    const credentials = (await loadCredentials()).runtimes;
    for (const adapter of ADAPTERS) {
      const detected = await adapter.detect(ctx);
      const credential = credentials[adapter.id];
      console.log(
        `${adapter.id.padEnd(8)} ${adapter.displayName.padEnd(14)} ` +
          `${detected.installed ? "detected" : "not detected"} / ` +
          `${credential ? `connected (${credential.runtime_id})` : "not connected"}`,
      );
    }
    break;
  }

  case "extensions": {
    const credentials = (await loadCredentials()).runtimes;
    const entry = Object.values(credentials)[0];
    if (!entry) fail("Not connected. Start with 'atn login'");
    const res = await apiCall(entry.base_url, "/v1/extensions", { token: entry.token });
    if (res.status !== 200) fail(`NG /v1/extensions returned ${res.status}`);
    const list = res.body as any[];
    if (list.length === 0) {
      console.log("No desired extensions registered yet");
      break;
    }
    for (const ext of list) {
      const status =
        (ext.materializations as any[])
          .map((m) => `${m.runtime_id}:${m.status}`)
          .join(", ") || "(not synced)";
      const flags = [ext.enabled ? null : "disabled", ext.deleted_at ? "pending deletion" : null]
        .filter(Boolean)
        .join(",");
      console.log(
        `${ext.name.padEnd(16)} ${ext.kind.padEnd(8)} rev${ext.revision}` +
          `${flags ? ` [${flags}]` : ""} — ${status}`,
      );
    }
    break;
  }

  case "sync": {
    const dryRun = args.includes("--dry-run");
    const credentials = (await loadCredentials()).runtimes;
    const targets: RuntimeAdapter[] = target
      ? [requireAdapter(target)]
      : ADAPTERS.filter((a) => credentials[a.id]);
    if (targets.length === 0) {
      fail("Not connected. Start with 'atn login'");
    }
    let anyFailed = false;
    for (const adapter of targets) {
      const credential = credentials[adapter.id];
      if (!credential) {
        console.log(`\n[${adapter.displayName}] not connected — skipped`);
        continue;
      }
      console.log(`\n[${adapter.displayName}]`);
      const result = await reconcile({
        adapter,
        ctx,
        baseUrl: credential.base_url,
        token: credential.token,
        runtimeId: credential.runtime_id,
        dryRun,
      });
      const acted = result.plan.filter((item) => item.action !== "noop");
      if (acted.length === 0) {
        console.log("  no changes");
      }
      for (const item of acted) {
        console.log(`  ${item.action.padEnd(12)} ${item.name}`);
      }
      if (dryRun) {
        console.log("  (dry-run: nothing was written)");
        continue;
      }
      for (const f of result.failed) {
        console.log(`  NG ${f.name}: ${f.detail}`);
      }
      if (result.failed.length > 0) anyFailed = true;
    }
    if (anyFailed) process.exit(1);
    break;
  }

  case "agent": {
    // 外部 API provider を端末側 runtime として 1 turn 動かす(EP-0009 B / PBI-0057)。
    // server 側 agent は E2EE(アーキ §9)により作れないので、復号できるこの端末で動かす
    const provider = target;
    if (!provider || !isAgentProvider(provider)) {
      fail(`agent needs a provider: ${AGENT_PROVIDERS.join(" / ")}`);
    }
    const threadId = flagValue("--thread");
    if (!threadId) fail("agent needs --thread <id>");
    const waitRaw = flagValue("--wait");
    const result = await runAgent({
      provider,
      threadId,
      model: flagValue("--model"),
      waitSec: waitRaw != null ? Number(waitRaw) : undefined,
    });
    if (result.status === "sent") {
      console.log("Sent");
      break;
    }
    if (result.status === "ask_approval_required") {
      console.log(`ask_approval_required — waiting for approval (approval_id=${result.approvalId})`);
      break;
    }
    if (result.status === "already_handled") {
      console.log("already_handled — this thread was already handled");
      break;
    }
    fail(`NG ${result.detail ?? result.status}`);
  }

  case "admin": {
    // 運営が助ける道(PBI-0135・図51 ③)。recovery code を控えていない人を 1 コマンドで戻す。
    // server 側は PAA_ADMIN_TOKEN が無ければ 503(既定で無効)で、成功も失敗も activity に残る。
    // `--url` の値を positional と誤認しないよう、直前が --url の要素は除く
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");
    const [sub, rawHandle] = positional;
    if (sub !== "recover") {
      fail(`Unknown admin subcommand: ${sub ?? "(none)"}\nSupported: admin recover <handle>`);
    }
    const handle = rawHandle?.replace(/^@+/, "");
    if (!handle) fail("Specify a handle (e.g. atn admin recover shibu)");
    const adminToken = process.env.PAA_ADMIN_TOKEN;
    if (!adminToken) {
      fail("PAA_ADMIN_TOKEN is not set. Pass the same value as the server's env");
    }
    const url = await accountBaseUrl(baseUrl);
    const res = await apiCall(url, "/v1/admin/sessions", {
      method: "POST",
      token: adminToken,
      body: { handle },
    });
    if (res.status === 503) fail("NG the server has no PAA_ADMIN_TOKEN (the admin path is disabled by default)");
    if (res.status === 401 || res.status === 403) fail("NG wrong admin token");
    if (res.status === 404) fail(`NG @${handle} was not found`);
    if (res.status !== 200) fail(`NG could not issue a session (HTTP ${res.status})`);
    console.log(`Session token for @${res.body.handle}:\n\n  ${res.body.token}\n`);
    console.log(
      `Hand it to the account holder over a safe channel. Pasting it into "Session token" on Sign in (${url}) gets them in.\n` +
        "Then tell them to set up a passkey or recovery codes under Settings › Sign-in methods",
    );
    break;
  }

  case "--help":
  case "help":
  case undefined:
    console.log(USAGE);
    break;

  default:
    fail(`Unknown command: ${command}\n\n${USAGE}`);
}
