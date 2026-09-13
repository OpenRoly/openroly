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
  type SessionBrief,
  getCredential,
  installRuntime,
  loadCredentials,
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  openrolyHome,
  pairRuntime,
  reconcile,
  RUNTIME_CLI_NOT_FOUND,
  shareExtensions,
  saveAccountUrl,
  removeCredential,
  saveCredential,
  uninstallRuntime,
  readCasPayload,
  writeCasPayload,
  type AdapterContext,
  type Finding,
  type PairPrompt,
  type ExtensionAdapter,
  type RuntimeCredential,
} from "@openroly/adapter";
import { countPendingContextValues, e2eeCallFor, resolveContextEntries, type ContextIndexRow } from "@openroly/adapter";
import { adoptLegacyEnv, buildCapsule, countInbox, buildManifest, CAPSULE_FIELDS, CapsuleConversationError, CapsuleCredentialRefError, CREDENTIAL_CHECK_FAILED, CREDENTIAL_OWNED_BY_HUMAN, egressEnforcementText, egressScopeText, legacyDir, LEGACY_STATE_DIR, parseEgressByRuntime, parseEgressEnforcement, STATE_DIR, TASK_MERGE_PATHS_MAX, type MergeDecision } from "@openroly/core";
import { applyGitCheckpoint, checkoutForkFolder, mergeTaskFolder, type GitState } from "@openroly/core/node";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROVIDERS, isAgentProvider, resolveApiKey, runAgent } from "./agent.ts";
import { addLocalRuntime, importShellProfiles, loadProfiles, localCatalogPath, profileProblem, profilesPath, removeProfile } from "@openroly/adapter";
import { followSession, listSessions, rawPeek, renderList, renderSession, SESSION_ID_RE } from "./peek.ts";
import { ADAPTERS, findAdapter, SUPPORTED_IDS, VARIANT_CLASSES } from "./registry.ts";

// openroly —— Personal Agent Account の入口(配布戦略 §7.2 Common Installation Engine の CLI 面)。
// plugin-first UX でもここを通るので、pairing / install / 診断のロジックは 1 系統。

const USAGE = `openroly —— OpenRoly

Usage: openroly <command>
       (from a repo checkout: bun run openroly <command>)

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
  status                Who is attached and what is unread (counts only, never bodies).
                        Also lists live sessions reported by the local broker
  cancel <request_id>   Stop a live session (broker kills the child process; SIGTERM → 5s → SIGKILL)
  statusline [--refresh] One line for a status bar (--refresh re-fetches and writes the cache)
  doctor [runtime]      Diagnose the connection
  runtimes              Supported runtimes and their connection state
  runtimes add <name> --binary <command> --mcp-file <path> [--format json] [--key mcpServers]
                        Add an AI that is not in the catalog (this machine only; listed as local-<name>)
  profiles import [--shell <rc>] | list | remove <class>
                        Turn shell wrappers like claude-zai() (same binary, another provider) into
                        runtime profiles. Only URLs and model names are stored; keys come from Connections
  run <class> [--bin <path>] -- <args>
                        Start a profile's binary with its env (what the broker runs on wake)
  extensions            Desired extensions + per-runtime status
  sync [runtime]        Run Extension Sync (all attached runtimes when omitted)
  share [runtime]       Offer what you already installed in your AIs (MCP servers / skills) to the
                        account as proposals. Approve them on the web and every AI gets them.
                        Secrets stay on this machine: the account only sees the env var names
  watch-dirs            Print the files and dirs whose changes mean "an AI here changed"
                        (one path per line; the broker watches these and runs share for you)
  admin recover <handle> [--keep-sessions]
                        Operator only: issue one session for an account that lost its token
                        (needs $OPENROLY_ADMIN_TOKEN — the same value as the server's env).
                        Every other session of that account is signed out unless you pass
                        --keep-sessions

  agent <provider> --thread <id>
                        Run an external API provider as this machine's runtime for one turn and
                        hand the draft reply to the thread (${AGENT_PROVIDERS.join(" / ")})
  peek [id] [--list] [--follow] [--json]
                        Show what the model actually received in a dedicated session (instruction
                        and tool calls, masked exactly as the model saw them; values never appear)

  work list [--status <s>] [--json]
                        Works that belong to your account (not to a session) with their write
                        lease epoch and holder
  work get <id> [--json]
                        One work with the full lease state
  work claim <id> --run <runId> [--json]
                        Take the write lease (fails with 409 lease_held if another run holds it)
  work intent <id> --action <transfer_primary|stop_primary> [--json]
                        Issue a one-time token for an explicit-user-intent action (human callers
                        only — a runtime credential gets 403 human_only)
  work freeze <id> --intent <token> [--json]
                        Give the lease back (stop_primary — requires a token from 'work intent').
                        The previous epoch is rejected forever after
  work events <id> [--after <n>] [--json]
                        Event log of one work in work_sequence order (--after = cursor to
                        resume from)
  work proof <id> --status <passed|failed|skipped|unknown> [--passed <n>] [--failed <n>]
                        Record test evidence as the lease holder — writes the proof row and a
                        proof_added event together. [--detail <s>] [--json]
  work promote <threadId> [--json]
                        Promote a triage-action thread into a work (idempotent: a second call
                        reports the same work)
  work handoff <id> [--to <runtimeId>] [--note <s>] [--json]
                        Re-assign who handles a work (the human override path — independent of
                        the write lease) and/or set its handoff note
  context show [--task <s>] [--json]
                        The Context Package your AIs are given (<= 1000 tokens): identity /
                        constraints / preferences / capabilities go into the managed block of
                        each AI, current_work / pointers into the session instruction. Anything
                        over the budget is cut and listed, never dropped silently

  --url <base-url>      Account API (default: $OPENROLY_URL, then the URL 'openroly login' connected to,
                        then ${DEFAULT_BASE_URL})
  --json                Machine-readable output on status / doctor / runtimes / extensions / sync /
                        share / work / context — one JSON document on stdout ({ok, data} / {ok, error}).
                        Default stays human-readable text
  --repair              Recreate the credential on install
  --dry-run             On sync / share, print the plan without writing anything
  --auto                On share, offer only what changed since the last share
  --no-open             Don't open the approval URL automatically (login / install / pair)
  --foreground          Run the broker in the foreground on login instead of detached
  --thread <id>         Thread the agent replies to
  --model <name>        Model the agent uses (default per provider; $OPENROLY_AGENT_MODEL also works)
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
  return process.env.OPENROLY_URL;
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
 * 抑止条件(いずれか true なら開かない): `--no-open` / `OPENROLY_NO_BROWSER=1` / 非 TTY / CI。
 * open コマンド自体の起動失敗は握り潰す —— URL は既に表示済みで、pairing の polling は継続する。
 */
function maybeOpenBrowser(url: string): void {
  if (args.includes("--no-open")) return;
  if (process.env.OPENROLY_NO_BROWSER === "1") return;
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
  // 旧 `~/.atn/broker` だけが在る端末ではそれを引き継ぐ(PBI-0344 AC-3)
  return (
    process.env.OPENROLY_BROKER_HOME ??
    legacyDir(
      join(homedir(), STATE_DIR, "broker"),
      join(homedir(), LEGACY_STATE_DIR, "broker"),
      existsSync,
    )
  );
}
const brokerPidPath = () => join(brokerHome(), "broker.pid");
const brokerLogPath = () => join(brokerHome(), "broker.log");

/** broker の hook socket の path。serve_hook_socket(broker/src/triggers.rs)が 0600 で bind するので
 * 同一 user の CLI だけが話せる(status 一覧 / cancel の actor は「この端末の人」に限定される) */
const brokerHookSocketPath = () => join(brokerHome(), "broker.sock");

/**
 * hook socket に 1 行送って 1 行受け取る(PBI-0229)。`openroly status` の live 一覧と `openroly cancel` は
 * **server を経由せず broker に聞く**(broker が「いま動いている session」の正本)。
 * broker 未起動 / socket 消滅 / 2 秒無応答は null —— status の表示から live を黙って落とし、
 * cancel は「届かなかった」を名乗る。tool 報告(packages/mcp の peek.ts)と同じ 1 接続 1 行。
 */
async function brokerHookRpc(line: string): Promise<string | null> {
  const path = brokerHookSocketPath();
  if (!existsSync(path)) return null;
  return await new Promise((resolve) => {
    const client = netConnect(path);
    let buf = "";
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy();
      } catch {
        /* 既に落ちている socket は放ってよい */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 2000);
    client.on("connect", () => client.write(line.endsWith("\n") ? line : `${line}\n`));
    client.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("\n")) done(buf.split("\n")[0] ?? null);
    });
    client.on("error", () => done(null));
  });
}

/** hook socket の status 応答(`{"sessions":[...],"capacity":{...}}`)のうち CLI が読む部分 */
type BrokerLiveSession = {
  request_id: string;
  lane: string;
  runtime: string;
  thread_id: string;
  started_at: number;
  state: string;
  last_tool: string | null;
  tool_count: number;
};
async function brokerLiveSessions(): Promise<{ sessions: BrokerLiveSession[]; capacity: unknown } | null> {
  const answer = await brokerHookRpc(JSON.stringify({ type: "status" }));
  if (!answer) return null;
  try {
    const parsed = JSON.parse(answer) as Record<string, unknown>;
    if (!Array.isArray(parsed.sessions)) return null;
    return { sessions: parsed.sessions as BrokerLiveSession[], capacity: parsed.capacity ?? null };
  } catch {
    return null;
  }
}

/** elapsed の短い形("just now" / "4m" / "2h" / "3d")。status 行の 1 列分 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[86_400, "d"], [3_600, "h"], [60, "m"]];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n}${name}`;
  }
  return "just now";
}

const psBin = () => Bun.which("ps") ?? "/bin/ps";
/**
 * 1 回の `ps` の上限。**返らない** ps(hang)も exit≠0 と同じ「分からない」に倒す —— これが無いと claim は最初の
 * ps で永久に止まり、`CLAIM_DEADLINE_MS` の「永久に待たない」が ps が答える時にしか効かない(PBI-0270 レビュー
 * 攻撃11)。既定 120s は、混雑下で ps の exec が 20s+ 遅れた実測(PBI-0218 レビュー・load 350)を「壊れた」に
 * 数えない余裕 —— 短くすると全 suite の負荷で全員が undetermined に倒れる。test は `OPENROLY_PS_TIMEOUT_MS` で縮める
 */
const PS_TIMEOUT_MS = Number(process.env.OPENROLY_PS_TIMEOUT_MS) || 120_000;

/**
 * `ps -o <column>= -p <pid>` の 1 行。**3 値** —— 文字列 = その pid は生きている / null = 居ない(ps が exit 1 で空)/
 * undefined = **分からない**(ps を spawn できない・signal で死んだ・usage error・上限まで返らない。混雑で EAGAIN /
 * OOM の時)。「分からない」を「居ない」に潰すと、混雑の最中に生きた broker の pid file を消して 2 本目を起こす /
 * 生きた持ち主の lock を回収して 2 本が takeOver に入る(PBI-0270)。**取る根拠は「死んだと確かめた」だけ**
 * (譲る根拠が「生きたと確かめた」だけなのと対。PBI-0218)
 */
async function psColumn(pid: number, column: "lstart" | "comm"): Promise<string | null | undefined> {
  try {
    const proc = Bun.spawn([psBin(), "-o", `${column}=`, "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: PS_TIMEOUT_MS,
    });
    const out = (await new Response(proc.stdout).text()).trim().replace(/\s+/g, " ");
    const code = await proc.exited;
    if (code === 0 && out) return out;
    if (code === 1 && !out) return null; // ps は「該当 pid 無し」を exit 1 で言う
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * プロセスの起動時刻(`ps -o lstart=`。秒精度)。プロセスが無ければ null。
 * pid だけでは「その番号のプロセスが生きているか」しか分からず、再起動後に前回 boot の pid が
 * 無関係なプロセス(pid 1 の launchd 等)に当たると「broker 生存」と誤判定して二度と起動できなくなる
 * (PBI-0048 レビュー AC-X3)。pid file には pid と起動時刻を対で書き、両方一致した時だけ生存とみなす
 */
const processStartTime = (pid: number) => psColumn(pid, "lstart");

/**
 * `<pid> <lstart>` の行が今も同じプロセスを指しているか。起動時刻まで見るのは pid 再利用対策
 * (`runningBrokerPid` と同じ理由)。lstart が無い行は pid の生死だけで判定する。
 * **undefined = 分からない**(`ps` が走らない)。呼び側は true の時だけ「生きている」、false の時だけ
 * 「死んでいる」と扱い、undefined では回収も deadline の延長もしない(PBI-0270)
 */
async function pidRecordAlive(record: string): Promise<boolean | undefined> {
  const m = /^(\d+)(?:\s+(.+))?$/.exec(record.trim());
  if (!m) return false;
  const start = await processStartTime(Number(m[1]));
  if (start === undefined) return undefined;
  if (start === null) return false;
  return m[2] ? start === m[2].replace(/\s+/g, " ") : true;
}

/** pid file の 1 行。`<pid> <lstart>`。起動時刻が取れない(既に死んでいる)時は pid だけ */
async function pidRecord(pid: number): Promise<string> {
  const start = await processStartTime(pid);
  return start ? `${pid} ${start}` : String(pid);
}

/**
 * pid file が「今生きている broker」を指していればその pid。
 * - `<pid> <lstart>`(現行形式): その pid の現在の起動時刻が一致する時だけ生存
 * - `<pid>` のみ(旧形式 / 起動時刻が取れなかった行): 実行ファイル名が `openroly-broker` の時だけ生存
 *   (更新前に起動した本物の broker を殺さず、再利用された無関係な pid は拾わない)
 * - `"unknown"`: pid file は在るが `ps` が走らず生死を確かめられない(PBI-0270)。**取る側**(`takeOver`・
 *   `broker status`)だけがこれを見る —— 譲る側は `runningBrokerPid`(生きた pid だけ)で足りる
 */
async function probeBroker(): Promise<number | "unknown" | undefined> {
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
  if (start === undefined) return "unknown";
  if (start === null) return undefined;
  if (m[2]) return start === m[2].replace(/\s+/g, " ") ? pid : undefined;
  const comm = await psColumn(pid, "comm");
  if (comm === undefined) return "unknown";
  return comm !== null && /(^|\/)openroly-broker$/.test(comm) ? pid : undefined;
}
/** 生きていると**確かめられた** broker の pid だけ(分からない時は undefined = 譲らない。PBI-0218 / PBI-0270) */
async function runningBrokerPid(): Promise<number | undefined> {
  const live = await probeBroker();
  return typeof live === "number" ? live : undefined;
}

/** repo checkout の root(broker binary の既定探索先の基点。apps/cli/src/ から 3 階層上) */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * broker binary の解決。`OPENROLY_BROKER_BIN` は明示指定として fallback しない
 * (`OPENROLY_CLI` と同じ設計)。未指定なら release → debug → 公開 Release からの取得先(PBI-0154) →
 * PATH の `openroly-broker` の順。**見つからなければ null** —— 呼び出し側は spawn より前
 * (launchd 登録より前)に build 案内で止まる。launchd に登録してから binary 不在に気付くと、
 * 案内は launchd が起こす `openroly broker` の log にしか出ず、`KeepAlive` が 10 秒毎に再起動し続ける
 * (PBI-0048 レビュー AC-X2)
 */
function resolveBrokerBin(): string | null {
  if (process.env.OPENROLY_BROKER_BIN) {
    return existsSync(process.env.OPENROLY_BROKER_BIN) ? process.env.OPENROLY_BROKER_BIN : null;
  }
  const release = join(REPO_ROOT, "broker", "target", "release", "openroly-broker");
  if (existsSync(release)) return release;
  const debug = join(REPO_ROOT, "broker", "target", "debug", "openroly-broker");
  if (existsSync(debug)) return debug;
  const downloaded = join(binDir(), "openroly-broker");
  if (existsSync(downloaded)) return downloaded;
  return Bun.which("openroly-broker");
}

const BROKER_BUILD_HINT =
  "The broker binary was not found. Run 'cargo build --release --manifest-path broker/Cargo.toml'\n" +
  "  (your credential is saved; after the build, 'openroly broker' starts it)";

/**
 * repo checkout も cargo も無い配布先(README の Quickstart)向け: broker binary がどこにも
 * 無ければ公開 Release から取得を試みる(PBI-0154)。取れなくても黙って cargo 案内(呼び出し側の
 * `BROKER_BUILD_HINT`)に倒す —— network が無いだけで `openroly login` を失敗させない。
 * checksum 不一致だけは特別扱いする: 「build し直せ」という cargo 案内は誤りなので、
 * ここで壊れている旨を出して止める
 */
async function ensureBrokerBinary(): Promise<void> {
  const found = resolveBrokerBin();
  // 手元 build / PATH / `OPENROLY_BROKER_BIN` が在るならそれを使う(取りに行かない)。**取得先に置いた物
  // だけは毎回 ensureBinary に通す** —— ここで「在るから何もしない」にすると、openroly を新しくしても
  // broker だけ初回に取った版のまま固定される(版が同じなら stamp を見て present で即返るので、
  // 通しても download は起きない)
  if (found && found !== join(binDir(), "openroly-broker")) return;
  const outcome = await ensureBinary("openroly-broker");
  if (outcome.status === "checksum_mismatch") {
    fail(`NG the downloaded file is corrupt: ${outcome.detail}`);
  }
}

/**
 * broker(Rust)へ渡す env。`OPENROLY_CLI` は dev repo で `openroly` が PATH に無いため必須(broker/src/adopt.rs)。
 * argv0 は `process.execPath`(bun 自体の絶対 path)にする —— launchd 環境は最小 PATH しか持たず
 * bare な `"bun"` を解決できないため(PBI-0048。detached spawn は `process.env` を継承するので
 * 従来の `"bun"` 決め打ちでも動いていたが、launchd 経由では broker(Rust)が起こす `openroly adopt` が
 * 解決に失敗する)
 */
function brokerEnv(credential: RuntimeCredential): Record<string, string> {
  return {
    ...process.env,
    OPENROLY_RUNTIME_TOKEN: credential.token,
    OPENROLY_BROKER_WS_URL: `${credential.base_url.replace(/^http/, "ws")}/v1/broker/ws`,
    OPENROLY_CLI: `${process.execPath}:${fileURLToPath(import.meta.url)}`,
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
  const claim = await claimBrokerPidFile();
  if (claim === "running") fail("The broker is already running (the pid file points at a live process)");
  if (claim === "undetermined") fail(await claimUndeterminedHint());
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

type DetachedOutcome = "started" | "already_running" | "build_needed" | "claim_undetermined";

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

/**
 * stale pid file の取り直しを直列化する lock。**中身が名札**(誰が握っているか)で、
 * **回収してよいかは持ち主の生死で決める**(時限は下の最後の砦だけ)
 */
const brokerClaimLockPath = () => join(brokerHome(), "broker.pid.lock");
/**
 * 名札の読めない lock(旧版が残した dir 等)にだけ効く最後の砦。**生きている持ち主の lock は
 * どれだけ古くても奪わない**(PBI-0218 レビュー) —— 時限だけで奪うと、遅い持ち主の lock を
 * 後発が横取りして **2 本が同時に takeOver に入る**(= pid file の rm→link が競合して二重起動)。
 * 逆に持ち主が死んでいれば時限を待たずに回収する —— 待つと 1 個の置き土産で全員が 10 秒止まり、
 * `CLAIM_DEADLINE_MS` の予算をそこで食い潰す(実測 11s。`scripts/serial.sh` / PBI-0249 と同じ型)
 */
const STALE_LOCK_MS = 10_000;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `mkdir` の「無ければ作る / 有れば EEXIST」を mutex に使い、`fn` を 1 プロセスずつ実行する。
 *
 * 待ち切れなかった時に**「先客が起動したはず」という値を返さない**(PBI-0218)。以前はここで
 * `fallback = false`(= 他が起動中)を返していたので、先客が起動前に終了していると全員が
 * 「他が起動中」と判断して**誰も broker を起こさないまま終わる**。lock を取れたかどうかだけを
 * 呼び出し側に返し、譲る / 取りにいくの判断は呼び出し側が pid file を**読み直して**決める。
 *
 * `heldByLive` は「生きた誰かが今この lock を握っている」= その誰かが起動の可否を決めに行っている、
 * を意味する。呼び出し側はこの間、諦めの上限を進めない(進めると 0 本になる)
 */
type LockOutcome<T> = { acquired: true; value: T } | { acquired: false; heldByLive: boolean };

/** lock の同一性。inode だけだと ext4 等は unlink 直後に同じ番号を配り直すので mtime も対にする */
type LockIdentity = { ino: number; mtimeMs: number };

/**
 * `lock` に今在る物を **`rename` で atomic に掴んでから**消す。掴めたのが `expect`(判断した時に見た物)と
 * 同じ時だけ消し、違えば(判断した後にその隙で張られた**新しい** lock)そのまま戻す。
 *
 * 「消す直前に `stat` で同一性を確かめてから `rm`」では足りなかった(PBI-0263) —— stat と rm の間は
 * 閉じないので、2 本が同じ古い lock を同時に回収すると:
 *   (a) 後発の `rm(recursive)` が、先発が回収して `link` し直した**新しい** lock を消し、2 本が takeOver に
 *       入る(実測: 3 本同時で 6/120。PBI-0218 レビューが閉じたつもりだった窓が残っていた)
 *   (b) 同じ dir を 2 本が同時に `rm(recursive)` すると Bun 1.3 が ENOENT でなく **EFAULT を投げ**、
 *       CLI が stack trace で exit 1 する(実測 15/120)。全 suite で 8 回中 4 回赤に見えた
 *       `started=1 yielded=0` の正体 = 負け側が「already running」を言う前に例外で落ちていた
 * `rename` は同じ inode を **1 人しか掴めず**(2 人目は ENOENT)、消すのは自分だけの path なので、
 * (a) の「他人の新しい lock を消す」も (b) の「同じ dir を 2 本で消す」も起きない
 * (`scripts/serial.sh` の owner file の rename と同じ型。実測: 同条件 200 回で 0/200・0/200)。
 *
 * **掴むのも「判断した時と同じ物」だけ**(PBI-0263 レビュー)。`expect` は呼び側が `ps` を挟む前に見た物なので、
 * 後発の判断は先発が回収して link し直した**生きた** lock を前にして古い。そこで rename すると、戻すまでの
 * 数十 µs だけ lock の path が空く —— 3 本目がそこへ link すると戻す rename がその lock を潰す(3 本目は
 * stillHeld で退くが取り直し)、持ち主がその隙に解放すると戻した lock が **持ち主の居ない名札**として残り、
 * 持ち主の process が生きている間は誰も回収できない(機序 probe 3 本同時 200 回: 掴み違い 1〜3 / 200・
 * 置き去り 1 回)。rename の直前に stat で照合し、違えば触らない(同 probe 0 / 200)。stat と rename の間の
 * 窓は残るので、掴んだ後の照合と戻す枝はその為に残す
 * 返り値は呼び側が待つ／取りに行くを決める為の 3 値
 */
async function reapLock(lock: string, expect: LockIdentity): Promise<"reaped" | "gone" | "someone_elses"> {
  const now = await stat(lock).catch(() => null);
  if (!now || now.ino !== expect.ino || now.mtimeMs !== expect.mtimeMs) return now ? "someone_elses" : "gone";
  const grab = `${lock}.reap.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await rename(lock, grab);
  } catch {
    return "gone"; // 他が先に掴んだ(回収した)。次の link で分かる
  }
  const got = await stat(grab).catch(() => null);
  if (got && got.ino === expect.ino && got.mtimeMs === expect.mtimeMs) {
    // 自分だけの path なので誰とも競合しない。それでも失敗したら残骸は放置する(lock ではないので害は無い)
    await rm(grab, { recursive: true, force: true }).catch(() => {});
    return "reaped";
  }
  await rename(grab, lock).catch(() => {});
  return "someone_elses";
}

async function withStaleTakeoverLock<T>(
  fn: (stillHeld: () => Promise<boolean>) => Promise<T>,
): Promise<LockOutcome<T>> {
  const lock = brokerClaimLockPath();
  // 名札(誰が握っているか)は **lock が見えた最初の瞬間から読めなければならない** ——
  // `mkdir` してから中に名札を書く 2 段階だと、その隙間に見た者が「持ち主不明 = 回収してよい」と
  // 判断し、**生きた持ち主の lock を奪う**。奪われた側は自分が握っている前提のまま takeOver に
  // 居るので、2 本が同時に `rm(pid file) → link` を撃って**両方が claim を勝つ**
  // (実測: 空の lock dir を 1 つ置くだけで 8 回中 1 回 `started=2`。PBI-0218 レビュー)。
  // pid file と同じ手 —— temp に書き切ってから `link` —— で、名札込みで atomic に出現させる
  const me = `${Math.random().toString(36).slice(2)}${process.pid}\n${await pidRecord(process.pid)}`;
  const tmp = `${lock}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, me);
  // `link` は inode を共有するので、lock が今も自分の物かは temp の同一性で分かる(内容を読み直すより確か)
  const mine: LockIdentity = await stat(tmp);
  const stillHeld = async () => {
    const now = await stat(lock).catch(() => null);
    return now !== null && now.ino === mine.ino && now.mtimeMs === mine.mtimeMs;
  };
  let heldByLive = false;
  // **claim の判断を 1 行で残す**(PBI-0312)。`OPENROLY_CLAIM_TRACE=1` の時だけ stderr に出す ——
  // bash 5 の arithmetic error が待ち側の wait loop を中断し、lock 保持中の dir に owner を書く
  // （0312 review の実測。CI の `started=2` はこの経路・macOS は出ない）。
  // 実物の CI から「どの枝を通って link に成功したか」を読む為の窓
  const trace: string[] = [];
  const t = (s: string) => {
    if (process.env.OPENROLY_CLAIM_TRACE) trace.push(s);
  };
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await link(tmp, lock);
        t(`a${attempt}:link-ok`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // 生死の確認は `ps` を起こすので毎回はやらない(200ms 毎。死んだ持ち主はそれで十分速く回収される)
        if (attempt % 4 !== 0) {
          await sleepMs(50);
          continue;
        }
        const st = await stat(lock).catch(() => null);
        const held = st ? await readFile(lock, "utf8").catch(() => null) : null;
        // true / false / undefined(= ps が走らず分からない。PBI-0270)
        const owner = held === null ? null : await pidRecordAlive(held.split("\n")[1] ?? "");
        heldByLive = owner === true;
        // 回収してよいのは **持ち主が死んでいると確かめられた**時だけ(分からない時は待つ。deadline も
        // 延ばさないので、ps が壊れたままなら上限で undetermined に降りる)。名札が読めない lock
        // (旧版が残した dir 等)は時限だけが根拠なので、そちらは STALE_LOCK_MS を待つ。
        // 消すのは **判断した時と同じ物**だけ —— reapLock が rename で掴んでから照合する
        // (掴めなければ他が回収した / 別物なら戻す。どちらも次の link で分かるので結果は見ない)
        if (st && (held === null ? Date.now() - st.mtimeMs > STALE_LOCK_MS : owner === false)) {
          const r = await reapLock(lock, st);
          t(`a${attempt}:reap=${r}/held=${held === null ? "null" : "named"}/own=${owner}/ino=${st.ino}/mt=${st.mtimeMs}`);
          continue;
        }
        t(`a${attempt}:wait/held=${held === null ? "null" : "named"}/own=${owner}/age=${st ? Math.round(Date.now() - st.mtimeMs) : "-"}`);
        await sleepMs(50);
        continue;
      }
      try {
        return { acquired: true, value: await fn(stillHeld) };
      } finally {
        // 自分の物(同じ inode)である時だけ消す(横から回収された後に後任の lock を巻き添えにしない)
        await reapLock(lock, mine);
      }
    }
    return { acquired: false, heldByLive };
  } finally {
    await rm(tmp, { force: true });
    if (trace.length > 0) console.error(`TRACE ${process.pid} ${trace.join(" ")}`);
  }
}

/**
 * 譲るか取るかが決まらないまま粘る上限。**生きた誰かが lock を握っている間はこの上限を進めない**
 * (PBI-0218 レビュー) —— 握っている側は今まさに起動の可否を決めに行っているので、そこで諦めるのは
 * 「誰も起こさない」を自分から作ることになる。実測: `ps` の exec が 20 秒以上遅れる混雑下では、
 * 正常に決めに行っている先客を待ち切れずに全員が降りた
 */
const CLAIM_DEADLINE_MS = 20_000;

/**
 * claim の結果。**`"undetermined"` を `"running"` に潰さない** —— 潰すと、broker が 1 本も
 * 上がっていないのに `openroly login` が「The broker is already running」と言って正常終了し、
 * 住所に届いても誰も起きない状態が成功に見える(hero ③ が黙って崩れる)
 */
type ClaimOutcome = "claimed" | "running" | "undetermined";

/**
 * pid file の排他生成を早い者勝ちの lock として使う。`link()` は「target が無ければ作る、
 * 有れば EEXIST」を **1 回の atomic 操作**で行う —— `open(path,"wx")` の後に別の `write` を
 * 呼ぶ 2 段階方式と違い、target が他プロセスから見える瞬間には(temp file へ先に書き終えた)
 * 内容が既に完成している(torn write の窓が無い)。
 *
 * stale file(前回クラッシュ / 再起動で残った死んだ pid)の再利用は **`withStaleTakeoverLock` の
 * 中で 1 プロセスずつ**行う。lock 無しの `readFile → rm → link` では、後発の `rm` が先発の
 * `link` 済み file を消す窓が残り、2 本同時の `openroly login` が両方 spawn した
 * (20 回に 1 回。PBI-0046 レビュー AC-X3)。
 *
 * **譲る根拠は「生きた broker を確認できた」だけ**(PBI-0218)。「先客がいたはず」「内容が読めない」
 * のような**仮定で false を返さない** —— 仮定で譲ると、先客が起動前に終了していた時に全員が
 * 譲って broker が 1 本も上がらず、`openroly login` だけが成功したように見える(hero ③ が黙って崩れる)。
 * 判定が付かない間は「読み直して決め直す」を上限付きで繰り返す
 */
async function claimBrokerPidFile(): Promise<ClaimOutcome> {
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
   * ここを「不明だから譲る」に倒すと、空の broker.pid 1 つで `openroly login` が
   * **恒久的に**「already running」と言い続けて 1 本も起動しない(PBI-0218 AC-X2)
   */
  const takeOver = async (stillHeld: () => Promise<boolean>): Promise<"claimed" | "yield" | "retry"> => {
    // **消してよいのは「中身を見て死んでいると確かめた、まさにその file」だけ**(PBI-0218 レビュー)。
    // `runningBrokerPid()` は 内容を読む → `ps` を叩く の 2 段階で、混雑下ではその間が 100ms 以上開く。
    // その隙に勝者が `writePidFileAtomic`(rename)で**生きた broker の記録**へ差し替えていると、
    // 古い判断(「死んでいる」)のまま新しい file を消して二重起動する ——
    // 実測(load 350): 勝者の CLI pid を読んだ後に `ps` を叩き、その時には勝者が既に exit していたので
    // 「死んでいる」と読み、勝者が置いた broker の記録を消して 2 本目を起こした。
    // rename も link も**必ず inode を差し替える**ので、消す直前に inode を照合すれば分かる
    const before = await stat(brokerPidPath()).catch(() => null);
    if (before === null) return (await tryLink()) ? "claimed" : "retry";
    const live = await probeBroker();
    // `ps` が走らない = 死んだと**確かめていない** → 消さずに読み直す(PBI-0270)。譲りもしない(嘘の already running)
    if (live === "unknown") return "retry";
    if (live) return "yield";
    const after = await stat(brokerPidPath()).catch(() => null);
    if (after === null || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) return "retry";
    // lock を横から回収されていたら(自分の名札がもう lock に無い)、ここで rm→link を撃つのは
    // lock 無しの取り直しと同じ —— 後発の rm が先発の link 済み file を消す窓が戻る(PBI-0263)。
    // 取り直さずに戻り、lock を取り直してから決め直す
    if (!(await stillHeld())) return "retry";
    await rm(brokerPidPath(), { force: true });
    return (await tryLink()) ? "claimed" : "retry";
  };
  try {
    let deadline = Date.now() + CLAIM_DEADLINE_MS;
    for (;;) {
      if (await tryLink()) return "claimed";
      // pid file が在る。**生きたプロセスを指している時だけ**譲る
      if (await runningBrokerPid()) return "running";
      const outcome = await withStaleTakeoverLock(takeOver);
      if (outcome.acquired && outcome.value !== "retry") {
        return outcome.value === "claimed" ? "claimed" : "running";
      }
      // lock を取れなかった / 取ったが横から link された。**仮定で終わらせず読み直して決め直す**。
      // ここで lock の外で `rm → link` に逃げてはいけない —— 後発の `rm` が先発の `link` 済み file を
      // 消す窓が開き、PBI-0046 レビュー AC-X3 の「2 本同時が両方 spawn」がそのまま戻る
      if (!outcome.acquired && outcome.heldByLive) deadline = Date.now() + CLAIM_DEADLINE_MS;
      // 諦める時も「他が起動中」とは言わない —— 確かめられなかった、として上へ返す
      if (Date.now() > deadline) return "undetermined";
      await sleepMs(20 + Math.floor(Math.random() * 40));
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * `claimBrokerPidFile` が決められなかった時に人へ出す文言(0 本を成功に見せない)。原因は **今の pid file を
 * 読み直して**分ける —— ps が走らないのに「another openroly process is holding the lock」と言うと、人は run it again を
 * 繰り返すだけで原因(ps)に辿り着けない(PBI-0270 レビュー 攻撃12。`broker status` の "ps did not run" と同じ名指し)
 */
const claimUndeterminedHint = async () =>
  "NG could not tell whether a broker is running: " +
  ((await probeBroker()) === "unknown"
    ? `ps did not run on this machine, so ${brokerPidPath()} could not be checked. Nothing was started — ` +
      "check that `ps -p $$` works, then run it again"
    : `another openroly process is holding ${brokerClaimLockPath()}. Nothing was started — run it again`);

/** `login` から呼ぶ detached 起動。pid file が生きているプロセスを指していれば二重起動しない */
async function startBrokerDetached(credential: RuntimeCredential): Promise<DetachedOutcome> {
  if (await runningBrokerPid()) return "already_running";
  const bin = resolveBrokerBin();
  if (!bin) return "build_needed";
  await mkdir(brokerHome(), { recursive: true });
  const claim = await claimBrokerPidFile();
  if (claim === "running") return "already_running";
  if (claim === "undetermined") return "claim_undetermined";
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
// 実マシンの ~/Library/LaunchAgents と実 launchctl には test から絶対に触れない —— OPENROLY_BROKER_BIN /
// OPENROLY_CLI と同じ設計で、常に env 経由の差し替え口を通す。

/**
 * plist が焼いた「login 時の PATH」の別名(PBI-0236)。**この env が在る = 今の PATH は写し**
 * という 1 つの意味しか持たない —— 在る時だけ `openroly adopt` が login shell を起こす。
 * 人が手で打つ `openroly install` / `openroly adopt`、test、detached 起動には無いので probe は走らない。
 */
const LOGIN_PATH_SNAPSHOT = "OPENROLY_LOGIN_PATH";

/** login shell の出力から PATH だけを切り出す marker。rc file の挨拶が混ざっても拾える */
const LOGIN_PATH_MARK = "__OPENROLY_PATH__";
/** interactive な rc file(oh-my-zsh 等)が重い端末でも、ここで諦めて snapshot に落ちる */
const LOGIN_SHELL_TIMEOUT_MS = 5000;

/**
 * 締切付きで stream を読み切る(PBI-0236 レビュー 2026-09-04)。締切を過ぎたら **stream を cancel して**
 * `null` を返す —— shell を kill するだけでは足りない: rc file が起こした背景 daemon
 * (powerlevel10k の gitstatusd・zsh-async・mise 等)は shell の stdout を継承するので、
 * shell が死んでも pipe は開いたままで、読みが終わらない。実測でこの経路が 37 秒待った
 * (broker の `ADOPT_TIMEOUT` = 60 秒を食い潰し、PBI-0190 が直した「MCP が 1 つも登録されない」に戻る)。
 * cancel は fd も手放すので、`openroly adopt` 自身の終了も背景の子に人質に取られない。
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
  const override = process.env.OPENROLY_LOGIN_SHELL;
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
 * `openroly adopt` が runtime CLI(`codex mcp add` 等)を起こす時の env(PBI-0236)。
 *
 * `OPENROLY_LOGIN_PATH` が無い = 自分の PATH は今の環境そのもの → **何もしない**。
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
  return process.env.OPENROLY_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
}
const LAUNCHD_LABEL = "com.openroly.broker";
const plistPath = () => join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
const launchctlBin = () => process.env.OPENROLY_LAUNCHCTL ?? "launchctl";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * plist は world-readable な file なので **token を絶対に書かない**(§4 と同格の secret 漏洩)。
 * `openroly broker` は起動時に credentials.json(0600)から自分で token を読む(PBI-0046)ので、
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
  // そこで **同じ値を `OPENROLY_LOGIN_PATH` にも焼く**: これは `openroly adopt` に対する
  // 「お前が今持っている PATH は login の瞬間の写しだ」という印で、adopt はこれが在る時だけ
  // login shell を起こして今の PATH を取り直す。`SHELL` はその時に起こす shell
  // (launchd の env には無い)。`PATH` を止めないのは broker(Rust) の discovery が
  // `env::var_os("PATH")` を見るため —— 外すと PBI-0190 の半分が戻る。
  const passthroughKeys = ["OPENROLY_HOME", "OPENROLY_BROKER_HOME", "OPENROLY_BROKER_BIN", "OPENROLY_URL", "PATH", "SHELL"] as const;
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

/** `openroly doctor` の「sandbox: seatbelt ok / unavailable(<理由>)」「egress: ok」の 2 行(PBI-0238 AC-5)。
 * 正本は broker が起動時に書く `<broker home>/sandbox-status.json`(broker/src/sandbox.rs)。
 * ここで sandbox-exec を叩き直さないのは、判定を 2 箇所に持たないため(broker が断る理由と
 * doctor が言う理由がずれると人が迷う)。 */
async function brokerSandboxFindings(): Promise<Finding[]> {
  const path = join(brokerHome(), "sandbox-status.json");
  let status: {
    sandbox?: unknown;
    egress?: unknown;
    egress_enforcement?: unknown;
    egress_enforcement_by_runtime?: unknown;
    sandbox_strength?: unknown;
  };
  try {
    status = JSON.parse(await readFile(path, "utf8")) as typeof status;
  } catch {
    const detail = "unknown (the broker has not started yet; dedicated sessions need it — run 'openroly login')";
    return [
      { ok: false, label: "sandbox", detail },
      { ok: false, label: "egress", detail },
      { ok: false, label: "egress scope", detail },
    ];
  }
  const line = (v: unknown): string => (typeof v === "string" ? v.slice(0, 200) : "unknown");
  const sandbox = line(status.sandbox);
  const egress = line(status.egress);
  // PBI-0441: port-scoped は壊れているのではなく「閉じていない事を名乗っている」ので OK。
  // 名乗らない broker(旧版)は unknown で NG —— host-scoped と推測して黙らない(AC-X2)
  const scope = parseEgressEnforcement(status.egress_enforcement);
  // C1(PBI-0441 ③)で claude だけ閉じている端末では、床の文に「host-scoped for: claude」を添える。
  // OK/NG は **床** で決める —— claude だけ閉じても、他の runtime は port-scoped のままなので
  // 「閉じた」とは言わせない(上げた側を隠さず、床を偽らない)
  const byRuntime = parseEgressByRuntime(status.egress_enforcement_by_runtime);
  const findings: Finding[] = [
    { ok: /\bok$/.test(sandbox), label: "sandbox", detail: sandbox },
    { ok: egress === "ok", label: "egress", detail: egress },
    { ok: scope === "host_scoped" || scope === "port_scoped", label: "egress scope", detail: egressScopeText(scope, byRuntime) },
  ];
  // PBI-0331 AC-X3: 同じ「landlock ok」でも kernel(Landlock の ABI)ごとに掛かる壁が違う。broker が名乗った
  // 時だけ出す —— 文は掛からない壁を名指しするので、弱い kernel に落ちた事を人が読める。OK/NG は sandbox 行が持つ
  if (typeof status.sandbox_strength === "string") {
    findings.push({ ok: true, label: "sandbox strength", detail: line(status.sandbox_strength) });
  }
  return findings;
}

/**
 * 繋がった先の account。**確かめられなかったこと**を undefined に潰さず理由と一緒に持つ ——
 * 「@? という account に繋がった」に読める表示を作らない為(PBI-0234 AC-X1)。
 */
type ConnectedAccount = { handle: string } | { handle: undefined; detail: string };

/** whoami を待つ上限。接続そのものは済んでいるので、遅い server に完了報告ごと張り付かない */
const ACCOUNT_CONFIRM_TIMEOUT_MS = 10_000;

/**
 * 名乗れる handle の形。**200 が返ったことは「account を確認できた」ではない**(有界レビュー) ——
 * 空文字は `connected to @.` に、空白や改行を含む値は完了表示に**偽の行**を差し込める形になり、
 * どちらも `@?` と同じ「確認できていないのに account に見える表示」に戻る。
 * server 側の規則(`[a-z][a-z0-9_]*`)より緩く取る —— 規則が広がっても既存 account を
 * 名乗れなくしない為で、ここで見たいのは「1 語の名前として画面に出せるか」だけ。
 */
const HANDLE_SHAPE = /^[a-z0-9_.-]{1,64}$/i;

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
    const handle = typeof who.body?.handle === "string" ? who.body.handle : "";
    if (who.status === 200 && HANDLE_SHAPE.test(handle)) return { handle };
    return {
      handle: undefined,
      detail:
        who.status === 401
          ? "the credential was rejected (401)"
          : who.status === 200
            ? "whoami did not name an account"
            : `whoami returned ${who.status}`,
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
    // **主語は identity**(PBI-0424・positioning §8 ⑥)。「<machine> が @handle に繋がった」だと
    // runtime / 端末が主語で、account は繋がる先の 1 つに見える。向きは逆 —— account が在って、
    // runtime はそこに attach する。**handle を先に置く**
    console.log(`\n@${who.handle} now has ${subject} attached.${tail}`);
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
  // --json の時は stdout に外枠 1 つだけを返す(AC-X2: 半分だけテキストにしない)。
  // message は stderr には出さない —— 機械は stdout だけを見る契約にする
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message } }) + "\n");
    process.exit(code);
  }
  console.error(message);
  process.exit(code);
}

const [command, ...args] = process.argv.slice(2);
adoptLegacyEnv(); // 旧 PAA_* env を採り込む(PBI-0344 AC-3。使った時だけ 1 行警告)
const target = args.find((a) => !a.startsWith("--"));
const baseUrl = baseUrlOf(args);

// PBI-0334: 状態を返すコマンドの機械向け出力。`peek --json`(jsonl の生渡し)と違い、
// こちらは「stdout 全体がただ 1 つの JSON document」になる外枠を持つ(AC-4)。
// 各コマンドは人間向けの行を 1 行も出さずに data を組み、最後に jsonOut を 1 回だけ呼ぶ。
// statusline は対象外 —— cache を cat する render 側(statusline.sh)との契約が既に機械向けで、
// JSON を足すと 2 つ目の契約になる(不確実性表の決め方に従い先に決めた)
const JSON_COMMANDS = new Set([
  "status", "doctor", "runtimes", "extensions", "sync", "share", "work", "context",
]);
const jsonMode = command != null && JSON_COMMANDS.has(command) && args.includes("--json");

/**
 * `--json` の共通外枠。`ok` はコマンドの終了状態(= exit code と同じ値)であって
 * 「JSON を出せたか」ではない —— doctor が NG を data に持つ時は ok:false + exit 1(AC-3)。
 * 「そもそも命令が通らなかった」(未接続・引数違い)は fail() の error 外枠で返す
 */
function jsonOut(ok: boolean, data: unknown): void {
  process.stdout.write(JSON.stringify(ok ? { ok: true, data } : { ok: false, data }) + "\n");
}

/** `--flag value` を 1 つ読む(値が無ければ undefined) */
/**
 * `openroly login` が名乗る名前(PBI-0227 AC-4)。**この文字列が承認画面にそのまま出る** ——
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

/** `--set key=value` を繰り返し受け取る(1 個の flag では 8 要素を同時に打てない為) */
function collectSetFlags(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--set") continue;
    const kv = args[i + 1];
    if (!kv || kv.startsWith("--")) fail('--set takes key=value (e.g. --set goal="ship V2")');
    const eq = kv.indexOf("=");
    if (eq <= 0) fail(`--set ${kv} is not key=value`);
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
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
    // 失効した credential の `base_url` = 前回 pairing した server。`account_url` を持たない端末
    // (PBI-0246 より前に login した端末)が再 pair する時、行き先はここにしか残っていない ——
    // 消してから resolver に渡すと DEFAULT_BASE_URL(localhost)へ落ちる
    const previousUrl = credential?.base_url;
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
        baseUrl: await accountBaseUrl(requestedUrl, previousUrl),
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
    // 既に接続済みの端末で `openroly login` を打ち直した時も通るので、この機能より前に
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
    // 「決められなかった」を「既に走っている」に潰さない —— 0 本のまま成功で終わらせない
    if (outcome === "claim_undetermined") fail(await claimUndeterminedHint());
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
      if (!credential) fail("Not connected. Run 'openroly login' first");
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
      const pid = await probeBroker();
      console.log(`launchd plist: ${plistInstalled ? `installed (${plistPath()})` : "not installed"}`);
      console.log(`launchd job: ${list.ok ? "registered" : "not registered"}`);
      console.log(
        `broker process: ${pid === "unknown" ? "unknown (ps did not run)" : pid ? `running (pid ${pid})` : "stopped"}`,
      );
      break;
    }
    if (sub !== undefined) fail(`Unknown broker subcommand: ${sub}\nSupported: install / uninstall / status`);
    const credential = await getCredential("broker");
    if (!credential) fail("Not connected. Run 'openroly login' first");
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
    //   --spec-stdin  = JSON 1 行 `{token, native?}`(PBI-0210。broker が署名検証済み registry の
    //                   `native` を添える → generic adapter を組む。bundled catalog より新しい entry でも動く)
    //   --token-stdin = 生の token 1 行(旧 broker 互換)
    const kind = flagValue("--kind");
    const runtimeId = flagValue("--runtime-id");
    const url = flagValue("--base-url");
    const name = flagValue("--name");
    const specStdin = args.includes("--spec-stdin");
    if (!specStdin && !args.includes("--token-stdin")) {
      fail("adopt: --spec-stdin or --token-stdin is required (the token is not accepted on argv)", 2);
    }
    if (!kind || !runtimeId || !url || !name) {
      fail("adopt: --kind / --runtime-id / --base-url / --name are required", 2);
    }
    const raw = (await Bun.stdin.text()).trim();
    let token = raw;
    let native: unknown = undefined;
    if (specStdin) {
      let spec: { token?: unknown; native?: unknown } | null = null;
      try {
        spec = JSON.parse(raw) as { token?: unknown; native?: unknown };
      } catch {
        fail("adopt: --spec-stdin expects one JSON line {token, native?} on stdin", 2);
      }
      token = typeof spec?.token === "string" ? spec.token : "";
      native = spec?.native ?? undefined;
    }
    if (!token) fail("adopt: could not read the token from stdin", 2);
    // runtime profile(PBI-0211): MCP / skills は親の登録を共有する(session の actor は親 kind)。
    // 保存するのは credential だけ —— `openroly run` が Connections の参照を解決する時に使う
    const variant = VARIANT_CLASSES.find((k) => k.id === kind);
    if (variant) {
      await saveCredential(kind, {
        runtime_id: runtimeId,
        token,
        base_url: url.replace(/\/$/, ""),
        name,
        paired_at: new Date().toISOString(),
      });
      console.log(`adopt: connected ${variant.displayName} as ${name} (${runtimeId}); it shares ${variant.of}'s config`);
      break;
    }
    // registry に entry があっても adapter 実装が無い runtime はここで落ちる(exit 2)。
    // Cloud 側も adapter:null は登録対象から外すので、ここに来るのは配布のずれ。
    // `native` が壊れていても exit 2(1 行目が detail になる) —— 推測で書き換えない
    let adapter: ExtensionAdapter | undefined;
    try {
      adapter = findAdapter(kind, native);
    } catch (e) {
      fail(`adopt: ${(e as Error).message}`, 2);
    }
    if (!adapter) fail(`adopt: unsupported runtime: ${kind}\nSupported: ${SUPPORTED_IDS.join(", ")}`, 2);
    const cleanUrl = url.replace(/\/$/, "");
    // 同じ端末に human が `openroly install` で入れた同 kind の credential があれば奪わない(AC-11)。
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
      // (credential だけ生きて MCP config が無い半端な状態を残さない)。**端末側も同じ状態にする** ——
      // 保存した credential をここで消さないと、Cloud が revoke した死んだ token が
      // credentials.json に残り、`openroly doctor` は「繋がっているのに 401」を出し、MCP server は
      // 401 で起動する(次の hello まで自己修復しない)。この runtime は今 register に失敗したので、
      // 端末に残す理由が無い
      await removeCredential(adapter.id).catch(() => false);
      // **1 行目が detail になる** ので、runtime CLI がどこにも無い時は named reason を行頭へ置く
      // (PBI-0236 AC-X1: broker 側の `openroly_cli_not_found` = openroly 自身が無い、と区別できるように)
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
      // `openroly pair claude` を打つと localhost に行って ConnectionRefused で死ぬ。
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
      fail("Not connected. Start with 'openroly login'");
    }
    // live session は broker に直接聞く(PBI-0229)。server に credential を使わないので
    // 接続できている runtime が 1 つも無くても表示できる
    const live = await brokerLiveSessions();
    if (jsonMode) {
      // brief は件数だけの SessionBrief(要件 §19)をそのまま出す —— 本文 key は入力に無いので
      // 出力にも作らない(AC-5)。fetch の失敗は runtime 行の error に構造で乗る(AC-3)
      const runtimes: { kind: string; name: string; brief?: unknown; error?: string }[] = [];
      for (const [kind, credential] of entries) {
        try {
          runtimes.push({ kind, name: credential.name, brief: await fetchBrief(credential.base_url, credential.token) });
        } catch (e) {
          runtimes.push({ kind, name: credential.name, error: (e as Error).message });
        }
      }
      jsonOut(true, { runtimes, live_sessions: live?.sessions ?? [] });
      break;
    }
    // **主語は identity**(PBI-0424・positioning §8 ⑥)。runtime を見出しにすると
    // 「Your runtime is not your agent.」と言いたい製品が runtime を主語にして喋ることになる。
    // 全 runtime は同じ account に attach しているので、handle と未読は **1 度だけ**出し、
    // runtime はその下の一覧に落とす。**取れた brief が 1 つも無い時に handle を名乗らない**
    // (reportConnected と同じ線 —— 「繋がっている」と「どの account かは確かめられなかった」を混ぜない)
    const rows: { label: string; name: string; brief?: SessionBrief; error?: string }[] = [];
    for (const [kind, credential] of entries) {
      const adapter = findAdapter(kind);
      try {
        // 要件 §19: session 開始時に見せるのは metadata のみ(本文は出さない)
        rows.push({
          label: adapter?.displayName ?? kind,
          name: credential.name,
          brief: await fetchBrief(credential.base_url, credential.token),
        });
      } catch (e) {
        rows.push({ label: adapter?.displayName ?? kind, name: credential.name, error: (e as Error).message });
      }
    }
    const account = rows.find((r) => r.brief)?.brief;
    if (account) {
      console.log(`\n@${account.handle}`);
      for (const line of formatBrief(account).split("\n")) console.log(`  ${line}`);
    } else {
      console.log("\nThe account could not be confirmed (no runtime answered)");
    }
    console.log("\n[Attached runtimes]");
    for (const r of rows) {
      console.log(`  ${r.label} · ${r.name}${r.error ? `  NG ${r.error}` : ""}`);
    }
    console.log("\n[Live sessions]");
    if (!live) {
      console.log("  No live sessions (broker not running)");
    } else if (live.sessions.length === 0) {
      console.log("  Idle");
    } else {
      for (const s of live.sessions) {
        // lane / runtime / thread / elapsed / last_tool + 4 状態(AC-A5-3)。boolean にしない
        const elapsed = s.started_at > 0 ? formatElapsed(Date.now() - s.started_at) : "just now";
        const thread = s.thread_id ? ` · ${s.thread_id}` : "";
        const tool = s.tool_count > 0 ? ` · ${s.tool_count} tools · ${s.last_tool ?? ""}` : "";
        console.log(`  ${s.request_id}  ${s.lane} · ${s.runtime} · ${s.state} · ${elapsed}${thread}${tool}`);
      }
    }
    break;
  }

  // PBI-0229 / AC-3・A6-1: この端末の人だけが(socket 0600)動いている session を止める。
  // broker が SIGTERM → 5 秒 → SIGKILL。in-memory の解除ではなく子 process が死ぬ
  case "cancel": {
    const id = args[0];
    if (!id) fail("Usage: openroly cancel <request_id>");
    const answer = await brokerHookRpc(JSON.stringify({ type: "cancel", session: id }));
    if (answer === null) fail("NG broker is not reachable (is it running?)");
    let ok = false;
    try {
      ok = JSON.parse(answer)?.ok === true;
    } catch {
      /* 壊れた応答は ok:false と同じ扱い */
    }
    if (!ok) fail(`NG no such session: ${id}`);
    console.log(`OK stop requested: ${id}`);
    break;
  }

  // PBI-0130: Claude Code の statusline に未読を出す。render 側(statusline.sh)は cache を
  // cat するだけなので、ここは「取り直して cache を更新する」背景側と、手で覗く読み出し側の 2 つ。
  case "statusline": {
    const cachePath = join(openrolyHome(), "statusline");
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
      // 手で `openroly statusline --refresh` を叩いた時だけ原因が見える(黙って空になるのを避ける)
      console.error(`statusline refresh aborted: ${(e as Error).message}`);
    }
    break;
  }

  case "doctor": {
    // PBI-0446: account へまだ上がっていない context の値。次の 30 秒 tick が再送するので数を見せるだけで NG にしない
    const contextSync: Finding = { ok: true, label: "context sync", detail: `${await countPendingContextValues()} pending` };
    if (jsonMode) {
      // NG は findings の ok:false として構造で出る(AC-3)。ok は人間向けの exit code と同じ値
      const targets: { runtime: string; findings: Finding[] }[] = [];
      for (const adapter of target ? [requireAdapter(target)] : ADAPTERS) {
        targets.push({ runtime: adapter.id, findings: await doctorRuntime({ adapter, ctx, baseUrl }) });
      }
      targets.push({ runtime: "broker", findings: await brokerSandboxFindings() });
      targets.push({ runtime: "context", findings: [contextSync] });
      const ok = targets.every((t) => t.findings.every((f) => f.ok));
      jsonOut(ok, { targets });
      if (!ok) process.exit(1);
      break;
    }
    let ok = true;
    for (const adapter of target ? [requireAdapter(target)] : ADAPTERS) {
      console.log(`\n[${adapter.displayName}]`);
      ok = printFindings(await doctorRuntime({ adapter, ctx, baseUrl })) && ok;
    }
    // 閉じ込めの土台(PBI-0238 / 図72)。broker が起動時の self_test の結果を status file に残す。
    // 無い = broker がまだ一度も起動していない(dedicated session は起こせない)ので NG に数える。
    console.log("\n[Broker]");
    ok = printFindings(await brokerSandboxFindings()) && ok;
    if (!ok) process.exit(1);
    break;
  }

  case "runtimes": {
    if (target === "add") {
      // PBI-0211: catalog に無い agent を端末だけに足す。broker の hello → server の自動登録 → adopt が拾う
      const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
      const name = positional[1];
      const binary = flagValue("--binary");
      const mcpFile = flagValue("--mcp-file");
      if (!name || !binary || !mcpFile) {
        fail("runtimes add <name> --binary <command> --mcp-file <path> [--format json] [--key mcpServers]");
      }
      let entry: Awaited<ReturnType<typeof addLocalRuntime>>;
      try {
        entry = await addLocalRuntime({ name, binary, mcpFile, format: flagValue("--format") ?? "json", key: flagValue("--key") ?? "mcpServers" });
      } catch (e) {
        fail(`runtimes add: ${(e as Error).message}`);
      }
      console.log(`Added ${entry.id} to ${localCatalogPath()}. The broker lists it in Your AI once '${binary}' is on PATH`);
      break;
    }
    const credentials = (await loadCredentials()).runtimes;
    if (jsonMode) {
      const runtimes = [];
      for (const adapter of ADAPTERS) {
        const detected = await adapter.detect(ctx);
        const credential = credentials[adapter.id];
        runtimes.push({
          id: adapter.id,
          display_name: adapter.displayName,
          detected: detected.installed,
          connected: !!credential,
          runtime_id: credential?.runtime_id ?? null,
        });
      }
      jsonOut(true, { runtimes });
      break;
    }
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
    if (!entry) fail("Not connected. Start with 'openroly login'");
    const res = await apiCall(entry.base_url, "/v1/extensions", { token: entry.token });
    if (res.status !== 200) fail(`NG /v1/extensions returned ${res.status}`);
    const list = res.body as any[];
    if (jsonMode) {
      // 0 件も「文言」ではなく空配列で出す(AC-3)。flags は人間向けの綴りでなく bool で持つ
      jsonOut(true, {
        extensions: list.map((ext) => ({
          name: ext.name,
          kind: ext.kind,
          revision: ext.revision,
          enabled: ext.enabled,
          deleted: ext.deleted_at != null,
          materializations: (ext.materializations as any[]).map((m) => ({
            runtime_id: m.runtime_id,
            status: m.status,
          })),
        })),
      });
      break;
    }
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
    const targets: ExtensionAdapter[] = target
      ? [requireAdapter(target)]
      : ADAPTERS.filter((a) => credentials[a.id]);
    if (targets.length === 0) {
      fail("Not connected. Start with 'openroly login'");
    }
    let anyFailed = false;
    // plan は人間向けが「変わった物だけ」なのに対し、JSON は reconcile が返す全行を出す ——
    // 機械は noop を自分で filter できる方が契約が単純になる。failed は NG として構造で出る(AC-3)
    const jsonTargets: { runtime: string; connected?: boolean; plan?: unknown[]; failed?: unknown[] }[] = [];
    for (const adapter of targets) {
      const credential = credentials[adapter.id];
      if (!credential) {
        if (jsonMode) {
          jsonTargets.push({ runtime: adapter.id, connected: false });
          continue;
        }
        console.log(`\n[${adapter.displayName}] not connected — skipped`);
        continue;
      }
      const result = await reconcile({
        adapter,
        ctx,
        baseUrl: credential.base_url,
        token: credential.token,
        runtimeId: credential.runtime_id,
        dryRun,
      });
      if (jsonMode) {
        jsonTargets.push({
          runtime: adapter.id,
          connected: true,
          plan: result.plan.map((item) => ({ action: item.action, name: item.name })),
          failed: result.failed,
        });
        if (result.failed.length > 0) anyFailed = true;
        continue;
      }
      console.log(`\n[${adapter.displayName}]`);
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
    if (jsonMode) {
      jsonOut(!anyFailed, { dry_run: dryRun, targets: jsonTargets });
      if (anyFailed) process.exit(1);
      break;
    }
    if (anyFailed) process.exit(1);
    break;
  }

  case "share": {
    // 吸い上げ → 提案(PBI-0212 / 図67)。sync の逆向きだが desired は書かない ——
    // 承認は web(または account 設定 auto_share)の仕事で、CLI は「見つけた」と言うだけ
    const dryRun = args.includes("--dry-run");
    const auto = args.includes("--auto");
    const credentials = (await loadCredentials()).runtimes;
    if (Object.keys(credentials).length === 0) fail("Not connected. Start with 'openroly login'");
    const adapters = target ? [requireAdapter(target)] : ADAPTERS;
    // secrets.json が書けない / server に届かない時は例外を投げる = 提案を 1 件も残さない(AC-X2)
    const result = await shareExtensions({ adapters, ctx, credentials, dryRun, auto }).catch(
      (e: Error) => fail(`NG share: ${e.message}`),
    );
    if (jsonMode) {
      // spec / fingerprint は出さない —— 機械が読むのは「何を提案したか・どう捌けたか」で十分で、
      // 中身の spec を CLI 面に広げる理由が無い(人間向け表示も出していない)
      jsonOut(result.failed.length === 0, {
        dry_run: dryRun,
        skipped: result.skipped.map((s) => ({
          name: s.name,
          runtime_kind: s.runtimeKind,
          reason: s.reason,
        })),
        plan: result.plan.map((p) => ({
          name: p.name,
          kind: p.kind,
          original_name: p.originalName,
          runtime_kind: p.runtimeKind,
          credential_ref: p.credentialRef,
        })),
        sent: result.sent,
        failed: result.failed,
      });
      if (result.failed.length > 0) process.exit(1);
      break;
    }
    for (const skip of result.skipped) {
      console.log(`  skipped ${skip.name} (${skip.runtimeKind}): ${skip.reason}`);
    }
    if (result.plan.length === 0) {
      console.log("Nothing new to share");
      break;
    }
    for (const item of result.plan) {
      const renamed = item.name === item.originalName ? "" : ` (was "${item.originalName}")`;
      const secret = item.credentialRef ? ` [${item.credentialRef} stays on this machine]` : "";
      console.log(`  ${item.kind.padEnd(6)} ${item.name}${renamed} from ${item.runtimeKind}${secret}`);
    }
    if (dryRun) {
      console.log("  (dry-run: nothing was sent and no secret was stored)");
      break;
    }
    const approved = result.sent.filter((x) => x.status === "approved").length;
    console.log(
      `\nOffered ${result.sent.length} item(s)` +
        (approved > 0 ? `, ${approved} approved automatically` : "") +
        ".\nOpen Your AI > Extensions on the web to approve the rest.",
    );
    for (const f of result.failed) console.log(`  NG ${f.name}: ${f.detail}`);
    if (result.failed.length > 0) process.exit(1);
    break;
  }

  case "watch-dirs": {
    // PBI-0213 / 図18: broker が「見張る場所」を訊く口。接続済み runtime の MCP config file と
    // skills dir を 1 行 1 path で出す。**path の正本は adapter 側 1 箇所**(Rust に写さない)
    // —— 76 agent 分の場所を broker に持たせると、片方だけ直る正本が 2 枚になる。
    //
    // `detect()` を通さないのは、あちらが `<bin> --version` を叩く(実測 3s)ため。見張る場所を
    // 知るのに probe は要らないし、**存在しない path も出す**(まだ無い skills dir が後から
    // 現れたのを見張り側が拾えるように)。
    const credentials = (await loadCredentials()).runtimes;
    const seen = new Set<string>();
    for (const adapter of ADAPTERS) {
      if (!credentials[adapter.id]) continue;
      for (const path of adapter.watchPaths(ctx)) {
        // 改行を含む path は 1 行 1 path の綴りを壊す(読み手が 2 つの path と読む)ので出さない
        if (path.includes("\n") || seen.has(path)) continue;
        seen.add(path);
        console.log(path);
      }
    }
    break;
  }

  case "profiles": {
    // runtime profile(PBI-0211)= 同じ binary の provider 差し替え。正本は端末の profiles.json(account に置かない)
    if (target === "import") {
      const shellFlag = flagValue("--shell");
      const rcPath = shellFlag ?? [join(homedir(), ".zshrc"), join(homedir(), ".bashrc")].find((p) => existsSync(p));
      let rc: string;
      try {
        if (!rcPath) throw new Error("no ~/.zshrc or ~/.bashrc");
        rc = await readFile(rcPath, "utf8");
      } catch (e) {
        // 読めない rc は「取り込む物が 0 件」であって失敗ではない(AC-X2)
        console.log(`Could not read ${rcPath ?? "a shell rc file"} (${(e as Error).message}). Imported 0 profiles`);
        break;
      }
      let result: Awaited<ReturnType<typeof importShellProfiles>>;
      try {
        result = await importShellProfiles(rc, VARIANT_CLASSES);
      } catch (e) {
        fail(`profiles import: ${(e as Error).message}. Nothing was written`);
      }
      for (const i of result.imported) {
        console.log(`Imported ${i.name} as ${i.class} (${VARIANT_CLASSES.find((k) => k.id === i.class)?.displayName ?? i.class})`);
      }
      for (const d of result.dropped) {
        console.log(`  ${d.name}: not stored — ${d.vars.join(", ")} (values are never written; keys come from Connections)`);
      }
      for (const s of result.skipped) console.log(`Skipped ${s.name}: ${s.reason}`);
      console.log(`Imported ${result.imported.length} profile(s) into ${profilesPath()}`);
      break;
    }
    if (target === "list") {
      let file: Awaited<ReturnType<typeof loadProfiles>>;
      try {
        file = await loadProfiles();
      } catch (e) {
        fail(`profiles list: ${(e as Error).message}`);
      }
      const entries = Object.entries(file.profiles);
      if (entries.length === 0) console.log("No runtime profiles. Import shell wrappers with 'openroly profiles import'");
      for (const [cls, p] of entries) {
        const k = VARIANT_CLASSES.find((c) => c.id === cls);
        const keys = Object.entries(p.secret_env).map(([v, ref]) => `${v} ← ${ref}`).join(", ");
        console.log(`${cls}  ${k?.displayName ?? "(unknown class)"}  from ${p.name}()  shares ${k?.of ?? "?"}'s config (MCP / skills)${keys ? `  ${keys}` : ""}`);
      }
      break;
    }
    if (target === "remove") {
      const cls = args.filter((a) => !a.startsWith("--"))[1];
      if (!cls) fail("profiles remove <class>");
      try {
        console.log((await removeProfile(cls)) ? `Removed ${cls}` : `No profile named ${cls}`);
      } catch (e) {
        fail(`profiles remove: ${(e as Error).message}`);
      }
      break;
    }
    fail("profiles needs import [--shell <rc>] | list | remove <class>");
  }

  case "run": {
    // profile の binary を profile の env で起こす(PBI-0211)。broker は variant の wake を
    // `openroly run <class> --bin <親 path> -- <親の argv>` で起こす。秘密は Connections の参照を
    // ここで解決し、**解決できなければ親を起こさない**(env 無しの親 = Anthropic 本番へ飛ぶ)
    const sep = args.indexOf("--");
    const own = sep >= 0 ? args.slice(0, sep) : args;
    const passthrough = sep >= 0 ? args.slice(sep + 1) : [];
    const cls = own.find((a, i) => !a.startsWith("--") && own[i - 1] !== "--bin");
    if (!cls) fail("run <class> [--bin <path>] -- <args>");
    const variant = VARIANT_CLASSES.find((k) => k.id === cls);
    let file: Awaited<ReturnType<typeof loadProfiles>>;
    try {
      file = await loadProfiles();
    } catch (e) {
      fail(`run: ${(e as Error).message}`);
    }
    const profile = file.profiles[cls];
    if (!variant || !profile) fail(`profile_not_found: ${cls} (import it with 'openroly profiles import')`);
    const problem = profileProblem(profile, variant);
    if (problem) fail(`run: ${problem}`);
    const binIdx = own.indexOf("--bin");
    const bin = (binIdx >= 0 ? own[binIdx + 1] : undefined) ?? Bun.which(variant.of);
    if (!bin) fail(`run: ${variant.of} is not installed`);
    const secrets: Record<string, string> = {};
    for (const [name, ref] of Object.entries(profile.secret_env)) {
      // class の provider 以外の参照は解決しない(書き換えた profile で別の鍵を別の host へ運ばせない)
      const provider = ref.startsWith("connection:") ? ref.slice("connection:".length) : undefined;
      if (!provider || provider !== variant.provider) fail(`run: ${name} refers to ${ref}, which ${cls} does not use`);
      const cred = (await getCredential(cls)) ?? (await getCredential(variant.of));
      if (!cred) fail("connection_unavailable: this machine is not connected (run 'openroly login')");
      const resolved = await resolveApiKey(cred.base_url, cred.token, provider, 0, (line) => console.error(line));
      if (!resolved.ok) fail(`run: ${resolved.detail}`);
      secrets[name] = resolved.key;
    }
    const child = Bun.spawn([bin, ...passthrough], {
      env: { ...process.env, ...profile.env, ...secrets },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
    process.exit(await child.exited);
  }

  case "agent": {
    // 外部 API provider を端末側 runtime として 1 turn 動かす(EP-0009 B / PBI-0057)。
    // server 側 agent は E2EE(アーキ §9)により作れないので、復号できるこの端末で動かす
    const provider = target;
    if (!provider || !isAgentProvider(provider)) {
      // 持ち込みの endpoint(PBI-0276)は名前が account ごとなので一覧に出せない。形だけ添える
      fail(`agent needs a provider: ${AGENT_PROVIDERS.join(" / ")} / custom-<name>`);
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

  // PBI-0393 / CAP-3: Work Ledger の CLI 面。仕事は session ではなく Account に属するので、
  // どの runtime credential で叩いても同じ一覧(最初の 1 本を使う)。人間向けの見出しは
  // identity 起点に書く(@handle · N works) — runtime 起点にすると「どの端末か」が先に来て
  // 「誰の仕事か」が見えなくなる(positioning §8 ⑥ と同型)
  case "work": {
    const sub = args[0];
    const WORK_SUBS = new Set([
      "list", "get", "claim", "freeze", "intent", "events", "proof", "promote", "handoff", "capsule",
      "capsules", "checkpoint-apply", "context", "transfer", "fork", "task",
    ]);
    if (!WORK_SUBS.has(sub as string)) {
      fail(
        `Usage: openroly work <list|get|claim|freeze|intent|transfer|fork|task|events|proof|promote|handoff|capsule|capsules|checkpoint-apply|context>\n  work list [--status <s>]\n  work get <id>\n  work intent <id> --action <transfer_primary|stop_primary>  (issues a one-time token — human callers only)\n  work claim <id> --run <runId>\n  work freeze <id> --intent <token>  (stop_primary — requires a token from 'work intent')\n  work transfer <id> --to <runtime> [--note <s>] [--set key=value ...]  (a runtime credential also needs --run <runId> --intent <token>)\n  work fork <id> --to <runtime> [--review] [--note <s>]  (branch the work without stopping it; --review = a blind reviewer)\n  work task merge <project> <task>  (apply the task's folder to this working tree — no commit; nothing is applied on a conflict)\n  work events <id> [--after <n>]\n  work proof <id> --status <s> [--passed <n>] [--failed <n>]\n  work promote <threadId>\n  work handoff <id> [--to <runtimeId>] [--note <s>]\n  work capsule <id> --set key=value [--set key2=value2 ...]  (keys: ${CAPSULE_FIELDS.join(", ")})\n  work capsule show <id> [--version <n>]  (reads the payload from this device's local store)\n  work capsules <id>\n  work context <id> [--key <k> ...] [--prefix <p>] [--kind context|source] [--query <q>]  (values come from this device's local store)\n  work context publish <task> --key <k> [--key <k2> ...]  (copy the task's keys to its Work Project)\n  work checkpoint-apply <id> [--version <n>] [--remote <name>] [--cwd <path>]`,
      );
    }
    const creds = await loadCredentials();
    const cred = creds.runtimes.claude ?? Object.values(creds.runtimes)[0];
    if (!cred) fail("NG not paired yet. Run 'openroly login' first");
    // resolver(accountBaseUrl)を通さない — ここは credential が生きている前提の操作なので
    // 接続先は credential.base_url で確定する(再接続先の解決は login / install の役割)
    const url = (baseUrl ?? cred.base_url).replace(/\/$/, "");
    const worksErr = (status: number, body: any): string =>
      status === 404 ? "NG no such work (wrong account or unknown id)"
      : status === 409 ? `NG lease conflict: ${body?.error?.code ?? "conflict"}`
      : `NG HTTP ${status}`;
    if (sub === "list") {
      const status = flagValue("--status");
      const q = status ? `?status=${encodeURIComponent(status)}` : "";
      const res = await apiCall(url, `/v1/works${q}`, { token: cred.token });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const works = res.body as Record<string, unknown>[];
      if (jsonMode) {
        jsonOut(true, { works });
        break;
      }
      const who = await apiCall(url, "/v1/whoami", { token: cred.token }).catch(() => null);
      console.log(`@${who?.body?.handle ?? "you"} · ${works.length} work${works.length === 1 ? "" : "s"}`);
      for (const w of works) {
        const lease = w.lease_holder_run
          ? `lease: ${w.lease_holder_run} (epoch ${w.lease_epoch})`
          : "lease: free";
        console.log(`  ${w.id}  ${String(w.status).padEnd(10)} ${w.title}  ${lease}`);
      }
      break;
    }
    if (sub === "get") {
      const id = args[1];
      if (!id) fail("Usage: openroly work get <id>");
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}`, { token: cred.token });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const w = res.body as Record<string, unknown>;
      if (jsonMode) {
        jsonOut(true, { work: w });
        break;
      }
      console.log(`${w.id}  ${w.title}`);
      console.log(`  status: ${w.status} · visibility: ${w.visibility} · priority: ${w.priority}`);
      console.log(
        w.lease_holder_run
          ? `  lease: ${w.lease_holder_run} (epoch ${w.lease_epoch}, acquired ${w.lease_acquired_at})`
          : `  lease: free (epoch ${w.lease_epoch})`,
      );
      // PBI-0444: inbox の件数と未読(無ければ出さない)
      const ib = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/context?prefix=inbox%2F`, { token: cred.token });
      const inbox = countInbox(ib.status === 200 ? (ib.body as { entries: ContextIndexRow[] }).entries : []);
      if (inbox.total > 0) console.log(`  inbox: ${inbox.total}${inbox.unread > 0 ? ` (${inbox.unread} unread)` : ""}`);
      // PBI-0439: 直近の transfer を 1 行(無ければ出さない)
      const tr = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/transfers`, { token: cred.token });
      const latest = tr.status === 200 ? (tr.body as Record<string, unknown>[])[0] : undefined;
      if (latest) {
        console.log(
          `  transfer: ${latest.state} → ${latest.to_runtime_kind} (${latest.id})${latest.reason ? ` · ${latest.reason}` : ""}`,
        );
      }
      // PBI-0440: 枝なら fork 元と profile、元なら枝の一覧(1 枝 1 行)
      if (w.forked_from_work_id) {
        console.log(`  forked from ${w.forked_from_work_id}@${w.forked_from_capsule_version} · profile ${w.context_profile}`);
      }
      const all = await apiCall(url, "/v1/works", { token: cred.token });
      const forks = all.status === 200 ? (all.body as Record<string, unknown>[]).filter((x) => x.forked_from_work_id === id) : [];
      for (const f of forks) {
        console.log(`  fork: ${f.id} · profile ${f.context_profile} · from v${f.forked_from_capsule_version}`);
      }
      break;
    }
    // PBI-0440: fork / review(図84)。MCP の work_fork と同じ手順 —— 元の最新 capsule の git_state をこの端末の CAS から
    // 読み、fork folder を checkoutForkFolder で作ってから forks を POST(断られたら folder を消す)。human の credential は許可行が要らない
    if (sub === "fork") {
      const id = args[1];
      const to = flagValue("--to");
      if (!id || !to) fail("Usage: openroly work fork <id> --to <runtime> [--review] [--note <s>]");
      const role = args.includes("--review") ? "reviewer" : "implementer";
      const note = flagValue("--note");
      const path = `/v1/works/${encodeURIComponent(id)}`;
      const cres = await apiCall(url, `${path}/capsules`, { token: cred.token });
      if (cres.status !== 200) fail(worksErr(cres.status, cres.body));
      const latest = (cres.body as { version: number; body: { payload_hash?: string } | null }[]).at(-1);
      if (!latest) fail(`NG no_capsule: ${id} has no capsule to fork from`);
      const payloadHash = latest.body?.payload_hash;
      const payload = typeof payloadHash === "string" ? await readCasPayload(payloadHash) : null;
      const gitState = payload?.git_state;
      if (!gitState || typeof gitState !== "object") {
        fail(`NG capsule v${latest.version} has no git_state on this device — the fork's folder cannot be built`);
      }
      const folder = join(openrolyHome(), "worktrees", crypto.randomUUID());
      try {
        checkoutForkFolder(process.cwd(), gitState as GitState, folder);
      } catch (e) {
        fail(`NG ${e instanceof Error ? e.message : String(e)}`);
      }
      const fres = await apiCall(url, `${path}/forks`, {
        method: "POST",
        token: cred.token,
        body: { to, role, capsuleVersion: latest.version, folder, ...(note ? { note } : {}) },
      });
      if (fres.status !== 201) {
        await rm(folder, { recursive: true, force: true });
        fail(fres.status === 422 ? `NG ${fres.body?.error?.code ?? "invalid request"}` : worksErr(fres.status, fres.body));
      }
      const { work, wake } = fres.body as { work: Record<string, unknown>; wake: { ok: boolean; reason: string | null } };
      if (jsonMode) {
        jsonOut(true, { work, folder, wake });
        break;
      }
      console.log(`OK forked ${id}@${latest.version} → ${work.id} (profile ${work.context_profile}) in ${folder}`);
      if (!wake.ok) console.log(`  not woken: ${wake.reason} — the branch stays ready; work_accept ${work.id} picks it up`);
      break;
    }
    // PBI-0447: task の folder を今の cwd(Work Project の作業ツリー)へ合流(図80c ⑥)。MCP の work_task_merge と同じ門の順 ——
    // team で project の task か → folder(worktree_missing)→ mergeTaskFolder → applied / conflict を task の events へ
    if (sub === "task") {
      const [verb, project, task] = [args[1], args[2], args[3]];
      if (verb !== "merge" || !project || !task) fail("Usage: openroly work task merge <project> <task>");
      const tres = await apiCall(url, `/v1/works/${encodeURIComponent(project)}/team`, { token: cred.token });
      if (tres.status !== 200) fail(worksErr(tres.status, tres.body));
      const team = tres.body as { project: { id: string }; tasks: { id: string }[] };
      if (team.project.id !== project || !team.tasks.some((t) => t.id === task)) {
        fail(`NG not_on_team: ${task} is not a task of Work Project ${project} — nothing was merged`);
      }
      let d: MergeDecision;
      try {
        d = mergeTaskFolder(join(openrolyHome(), "worktrees", task), process.cwd());
      } catch (e) {
        fail(`NG ${e instanceof Error ? e.message : String(e)}`);
      }
      if (d.result === "applied" || d.result === "conflict") {
        const rec = await apiCall(url, `/v1/works/${encodeURIComponent(task)}/merges`, {
          method: "POST",
          token: cred.token,
          body: { projectWorkId: project, merge: d.result, paths: d.paths.slice(0, TASK_MERGE_PATHS_MAX) },
        });
        if (rec.status !== 201) {
          fail(`NG ${d.result} in ${process.cwd()}, but recording it on ${task} failed: ${rec.body?.error?.code ?? `HTTP ${rec.status}`}`);
        }
      }
      if (jsonMode) {
        jsonOut(d.result === "applied" || d.result === "empty", { task_id: task, project_id: project, ...d });
        break;
      }
      if (d.result === "busy") fail("NG busy: another git operation holds this repo's index.lock — nothing was applied");
      if (d.result === "conflict") fail(`NG conflict: ${d.paths.join(", ")} — nothing was applied`);
      console.log(
        d.result === "empty"
          ? `OK nothing to merge — ${task} changed no files`
          : `OK merged ${task} into ${process.cwd()} · ${d.paths.length} file${d.paths.length === 1 ? "" : "s"}: ${d.paths.join(", ")} (not committed)`,
      );
      break;
    }
    // PBI-0439: runtime transfer(図84)。client 3 段は MCP の work_transfer と同じ手順 —— FREEZE → 予約 id・予約 epoch で
    // capsule(--set の要素)→ ROUTE(target を今の cwd で起こす)。human の credential なら intent は要らない
    // ponytail: CLI からの transfer は git_state を載せない(tree を読む computeGitState は packages/mcp に在る)。
    // CLI からも tree を運ぶ時は computeGitState を @openroly/core/node(applyGitCheckpoint の隣)へ寄せる
    if (sub === "transfer") {
      const id = args[1];
      const to = flagValue("--to");
      if (!id || !to) {
        fail("Usage: openroly work transfer <id> --to <runtime> [--note <s>] [--set key=value ...] [--run <runId> --intent <token>]");
      }
      const run = flagValue("--run");
      const intent = flagValue("--intent");
      const note = flagValue("--note");
      let built: ReturnType<typeof buildCapsule>;
      try {
        built = buildCapsule(collectSetFlags());
      } catch (e) {
        if (e instanceof CapsuleConversationError) fail(`NG ${e.code}: ${e.foundKeys.join(", ")}`);
        if (e instanceof CapsuleCredentialRefError) fail(`NG ${e.code}: ${JSON.stringify(e.value)} (only env:NAME is accepted)`);
        throw e;
      }
      const path = `/v1/works/${encodeURIComponent(id)}`;
      const wres = await apiCall(url, path, { token: cred.token });
      if (wres.status !== 200) fail(worksErr(wres.status, wres.body));
      const w = wres.body as Record<string, unknown>;
      const tres = await apiCall(url, `${path}/transfers`, {
        method: "POST",
        token: cred.token,
        body: { to, ...(run ? { runId: run, expectedWriteEpoch: w.lease_epoch } : {}), ...(intent ? { intent } : {}) },
      });
      if (tres.status !== 201) {
        fail(tres.status === 422 ? `NG ${tres.body?.error?.code ?? "invalid request"}` : worksErr(tres.status, tres.body));
      }
      const frozen = tres.body as { transfer_id: string; reserved_epoch: number; holder_run: string };
      const stopped = (state: string, detail: string): never =>
        fail(`NG transfer ${frozen.transfer_id} stopped at ${state}: ${detail}`);
      if (note) {
        const h = await apiCall(url, `${path}/handoff`, { method: "POST", token: cred.token, body: { note } });
        if (h.status !== 200) stopped("frozen", `note: ${h.body?.error?.code ?? `HTTP ${h.status}`}`);
      }
      const written = await writeCasPayload(built.body);
      const manifest = buildManifest(built.body, { hash: written.hash, size: written.size, mode: "0600" });
      const cres = await apiCall(url, `${path}/capsules`, {
        method: "POST",
        token: cred.token,
        body: { runId: frozen.holder_run, expectedWriteEpoch: frozen.reserved_epoch, ...manifest },
      });
      if (cres.status !== 201 && cres.status !== 200) stopped("frozen", `capsule: ${cres.body?.error?.code ?? `HTTP ${cres.status}`}`);
      const rres = await apiCall(url, `${path}/transfers/${encodeURIComponent(frozen.transfer_id)}/route`, {
        method: "POST",
        token: cred.token,
        body: { capsuleVersion: (cres.body as { capsule: { version: number } }).capsule.version, folder: process.cwd() },
      });
      if (rres.status !== 200) stopped("frozen", `route: ${rres.body?.error?.code ?? `HTTP ${rres.status}`}`);
      const transfer = (rres.body as { transfer: Record<string, unknown> }).transfer;
      if (transfer.state !== "routed") stopped(String(transfer.state), String(transfer.reason ?? "not routed"));
      if (jsonMode) {
        jsonOut(true, { transfer });
        break;
      }
      console.log(
        `OK transfer ${frozen.transfer_id}: routed → ${to} (lease reserved at epoch ${frozen.reserved_epoch} until ${to} accepts)`,
      );
      break;
    }
    // v0 Authority(PBI-0413): explicit user intent の起点。**human の credential でしか通らない**
    // (server が actor.kind==='human' を強制する。runtime credential で呼ぶと 403 human_only)
    if (sub === "intent") {
      const id = args[1];
      const action = flagValue("--action");
      if (!id || (action !== "transfer_primary" && action !== "stop_primary")) {
        fail("Usage: openroly work intent <id> --action <transfer_primary|stop_primary>");
      }
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/intent`, {
        method: "POST",
        token: cred.token,
        body: { action },
      });
      if (res.status !== 201) fail(worksErr(res.status, res.body));
      const body = res.body as { token: string; expires_at: string };
      if (jsonMode) {
        jsonOut(true, { token: body.token, expires_at: body.expires_at });
        break;
      }
      console.log(`OK intent token issued for ${action} (expires ${body.expires_at})`);
      console.log(body.token);
      break;
    }
    if (sub === "claim") {
      const id = args[1];
      const run = flagValue("--run");
      if (!id) fail("Usage: openroly work claim <id> --run <runId>");
      if (!run) fail("Specify the claiming RunId with --run <runId>");
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        token: cred.token,
        body: { runId: run },
      });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const w = res.body as Record<string, unknown>;
      if (jsonMode) {
        jsonOut(true, { work: w });
        break;
      }
      console.log(`OK claimed ${w.id} as ${w.lease_holder_run} (epoch ${w.lease_epoch})`);
      break;
    }
    // PBI-0397 / D2: thread を work へ昇格する(triage action だけ)。2 回目は 409 で同じ work を
    // 教える — 「もう昇格済み」は失敗ではなく冪等なのので OK 行で出す(exit 0)
    if (sub === "promote") {
      const threadId = args[1];
      if (!threadId) fail("Usage: openroly work promote <threadId>");
      const res = await apiCall(url, "/v1/works/promote", {
        method: "POST",
        token: cred.token,
        body: { threadId },
      });
      if (res.status === 409 && res.body?.error?.code === "already_promoted") {
        if (jsonMode) {
          jsonOut(true, { already: true, work_id: res.body?.work_id ?? null });
          break;
        }
        console.log(`OK already promoted: ${res.body?.work_id ?? "unknown"}`);
        break;
      }
      if (res.status !== 201) fail(worksErr(res.status, res.body));
      const w = res.body as Record<string, unknown>;
      if (jsonMode) {
        jsonOut(true, { work: w });
        break;
      }
      console.log(`OK promoted ${threadId} -> ${w.id} (${w.title})`);
      break;
    }
    // PBI-0397: work の係の差し替え(lease と無関係に人が変える口)
    if (sub === "handoff") {
      const id = args[1];
      const to = flagValue("--to");
      const note = flagValue("--note");
      if (!id) fail("Usage: openroly work handoff <id> [--to <runtimeId>] [--note <s>]");
      if (to === undefined && note === undefined) {
        fail("Specify --to <runtimeId> and/or --note <s> (empty handoff updates nothing)");
      }
      const body: Record<string, unknown> = {};
      if (to !== undefined) body.runtimeId = to;
      if (note !== undefined) body.note = note;
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/handoff`, {
        method: "POST",
        token: cred.token,
        body,
      });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const w = res.body as Record<string, unknown>;
      if (jsonMode) {
        jsonOut(true, { work: w });
        break;
      }
      const parts = [w.handled_runtime_id ? `handled by ${w.handled_runtime_id}` : null, w.handoff_note ? "note set" : null];
      console.log(`OK handoff ${w.id}${parts.filter(Boolean).length > 0 ? ` (${parts.filter(Boolean).join(", ")})` : ""}`);
      break;
    }
    // PBI-0395: event log の読み出し。人間向けの見出しは list と同じ identity 起点
    // (@handle · N events on <id>)。--after は work_sequence cursor(差分取得)
    if (sub === "events") {
      const id = args[1];
      if (!id) fail("Usage: openroly work events <id> [--after <n>]");
      const after = flagValue("--after");
      if (after !== undefined && !/^\d+$/.test(after.trim())) {
        fail("--after takes a non-negative integer (a work_sequence cursor)");
      }
      const q = after !== undefined ? `?after=${after.trim()}` : "";
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/events${q}`, { token: cred.token });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const events = res.body as Record<string, unknown>[];
      if (jsonMode) {
        jsonOut(true, { events });
        break;
      }
      const who = await apiCall(url, "/v1/whoami", { token: cred.token }).catch(() => null);
      console.log(`@${who?.body?.handle ?? "you"} · ${events.length} event${events.length === 1 ? "" : "s"} on ${id}`);
      for (const e of events) {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const hint = e.kind === "proof_added"
          ? `${String(p.status)} · ${p.passed ?? "-"} passed / ${p.failed ?? "-"} failed`
          : e.kind === "comment_added"
            ? String(p.body ?? "")
            : e.kind === "diagnostic"
              ? String(p.code ?? "")
              : "";
        console.log(
          `  #${String(e.work_sequence).padEnd(4)} ${String(e.kind).padEnd(16)} ${String(e.run_id ?? "-")}  ${hint}`.trimEnd(),
        );
      }
      break;
    }
    // proof: runtime が skill で打つ「32/34 tests pass」。test 出力は parse しない(方向 §59.6)。
    // runId / epoch は work の現在の lease から読む —— 打つのは lease holder の Run だけ
    if (sub === "proof") {
      const id = args[1];
      const status = flagValue("--status");
      const detail = flagValue("--detail");
      const count = (name: string): number | undefined => {
        const raw = flagValue(name);
        if (raw === undefined) return undefined;
        if (!/^\d+$/.test(raw.trim())) fail(`${name} takes a non-negative integer`);
        return Number.parseInt(raw.trim(), 10);
      };
      if (!id) {
        fail("Usage: openroly work proof <id> --status <passed|failed|skipped|unknown> [--passed <n>] [--failed <n>] [--detail <s>]");
      }
      if (!status) fail("Specify the proof status with --status <passed|failed|skipped|unknown>");
      if (!["passed", "failed", "skipped", "unknown"].includes(status)) {
        fail("--status must be one of: passed / failed / skipped / unknown");
      }
      const wres = await apiCall(url, `/v1/works/${encodeURIComponent(id)}`, { token: cred.token });
      if (wres.status !== 200) fail(worksErr(wres.status, wres.body));
      const w = wres.body as Record<string, unknown>;
      if (!w.lease_holder_run) {
        fail("NG no run holds this work — claim it first (openroly work claim <id> --run <runId>)");
      }
      const body: Record<string, unknown> = {
        runId: w.lease_holder_run,
        expectedWriteEpoch: w.lease_epoch,
        status,
      };
      const passed = count("--passed");
      const failed = count("--failed");
      if (passed !== undefined) body.passed = passed;
      if (failed !== undefined) body.failed = failed;
      if (detail !== undefined) body.detail = detail;
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/proofs`, {
        method: "POST",
        token: cred.token,
        body,
      });
      if (res.status !== 200 && res.status !== 201) fail(worksErr(res.status, res.body));
      const doc = res.body as { proof: Record<string, unknown>; event: Record<string, unknown> };
      if (jsonMode) {
        jsonOut(true, { proof: doc.proof, event: doc.event });
        break;
      }
      const p = doc.proof;
      const counts = p.passed != null || p.failed != null
        ? ` (${p.passed ?? 0} passed / ${p.failed ?? 0} failed)`
        : "";
      console.log(`OK proof on ${id}: ${p.status}${counts} · event #${doc.event.work_sequence}`);
      break;
    }
    // capsule: 8 要素のうち打ちたい分だけを --set で渡す。runId / epoch は proof と同じく
    // 「今の lease から読む」(名乗りは server が照合する — CLI が holder を偽らない)。
    // PBI-0414: 版の中身(8 要素の本文)は server に無い —— manifest の payload_hash から
    // **この端末の CAS** を読む(checkpoint-apply が git_state だけを取り出すのと同じ経路。
    // こちらは全 8 要素をそのまま見せる汎用の「開く」口)
    // PBI-0433: Work Project の context / source を読む。組み直しは MCP の work_context_search と同じ
    // (@openroly/adapter の resolveContextEntries) —— value は端末の CAS から、source は手元で再 hash
    // PBI-0443: task の key を Work Project へ公開する(project に出す口はこれだけ)
    if (sub === "context" && args[1] === "publish") {
      const id = args[2];
      const keys = args.flatMap((a, i) => (a === "--key" && args[i + 1] !== undefined ? [args[i + 1]!] : []));
      if (!id || keys.length === 0) fail("Usage: openroly work context publish <task> --key <k> [--key <k2> ...]");
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/context/publish`, {
        method: "POST",
        token: cred.token,
        body: { keys },
      });
      if (res.status !== 200) {
        fail(res.status === 404 ? worksErr(404, res.body) : `NG ${(res.body as any)?.error?.code ?? `HTTP ${res.status}`}${(res.body as any)?.error?.key ? ` (${(res.body as any).error.key})` : ""}`);
      }
      const entries = (res.body as { entries: ContextIndexRow[] }).entries;
      if (jsonMode) {
        jsonOut(true, { work_id: id, entries });
        break;
      }
      for (const e of entries) console.log(`OK published ${e.key} v${e.version} ← ${e.published_from_work_id}@${e.published_from_version}`);
      break;
    }
    if (sub === "context") {
      const id = args[1];
      if (!id) fail("Usage: openroly work context <id> [--key <k> ...] [--prefix <p>] [--kind context|source] [--query <q>] [--index] [--max-tokens <n>]");
      const params = new URLSearchParams();
      const kind = flagValue("--kind");
      if (kind) params.set("kind", kind);
      const prefix = flagValue("--prefix");
      if (prefix) params.set("prefix", prefix);
      args.forEach((a, i) => {
        const value = args[i + 1];
        if (a === "--key" && value !== undefined) params.append("key", value);
      });
      const qs = params.toString();
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/context${qs ? `?${qs}` : ""}`, {
        token: cred.token,
      });
      if (res.status !== 200) {
        fail(res.status === 422 ? `NG ${(res.body as any)?.error?.code ?? "invalid request"}` : worksErr(res.status, res.body));
      }
      // PBI-0438: --index = 値の代わりに est_tokens と preview / --max-tokens = 1 回の上限(MCP と同じ関数・同じ既定)
      const maxTokens = flagValue("--max-tokens");
      let resolved: Awaited<ReturnType<typeof resolveContextEntries>>;
      try {
        // PBI-0446: この端末に無い値は account から開く(MCP と同じ関数)。鍵はこの credential の kind の grant → device 鍵
        const credKind = Object.keys(creds.runtimes).find((k) => creds.runtimes[k] === cred) ?? "default";
        resolved = await resolveContextEntries((res.body as { entries: ContextIndexRow[] }).entries, {
          account: { call: e2eeCallFor(url, cred.token, credKind), deviceKind: credKind },
          cwd: process.cwd(),
          query: flagValue("--query"),
          indexOnly: args.includes("--index"),
          maxTokens: maxTokens === undefined ? undefined : Number(maxTokens),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("invalid_max_tokens")) fail(`NG ${message}`);
        throw e;
      }
      if (jsonMode) {
        jsonOut(true, { work_id: id, ...resolved });
        break;
      }
      const n = resolved.entries.length;
      console.log(
        `${id} · ${n} entr${n === 1 ? "y" : "ies"}${resolved.missing_on_device ? ` · ${resolved.missing_on_device} not on this device` : ""}`,
      );
      for (const e of resolved.entries) {
        const from = e.scope === "project" ? `  (project${e.published_from ? ` · from ${e.published_from}` : ""})` : "";
        const size = e.est_tokens !== undefined ? `  ~${e.est_tokens} tok` : "";
        if (e.kind === "source") console.log(`  source  ${e.key}  v${e.version}  ${e.source_status}${size}${from}`);
        else if (e.missing_on_device) console.log(`  ${e.key}  v${e.version}${size}  (value not on this device)${from}`);
        else console.log(`  ${e.key}  v${e.version}${size}  ${JSON.stringify(e.est_tokens !== undefined ? e.preview : e.value)}${from}`);
      }
      const { budget } = resolved;
      if (budget.omitted_count > 0) {
        const names = budget.omitted.map((o) => `${o.key} (~${o.est_tokens} tok)`).join(", ");
        const rest = budget.omitted_count - budget.omitted.length;
        console.log(`  … ${budget.omitted_count} more over --max-tokens ${budget.max_tokens}: ${names}${rest > 0 ? ` and ${rest} more` : ""}`);
      }
      break;
    }
    if (sub === "capsule" && args[1] === "show") {
      const id = args[2];
      if (!id) fail("Usage: openroly work capsule show <id> [--version <n>]");
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/capsules`, { token: cred.token });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const caps = res.body as { version: number; body: { payload_hash?: string } }[];
      if (caps.length === 0) fail("NG no capsule on this work yet");
      const versionFlag = flagValue("--version");
      const chosen =
        versionFlag !== undefined ? caps.find((c) => String(c.version) === versionFlag) : caps[caps.length - 1];
      if (!chosen) fail(`NG no such capsule version: ${versionFlag}`);
      const payloadHash = chosen.body?.payload_hash;
      if (!payloadHash || typeof payloadHash !== "string") {
        fail(`NG capsule v${chosen.version} has no payload (its content was cleared from the server — PBI-0414)`);
      }
      const payload = await readCasPayload(payloadHash);
      if (!payload) {
        fail(
          `NG payload for v${chosen.version} not found in this device's local store (~/.openroly/checkpoints/${payloadHash.slice(0, 12)}…) — ` +
            "either it was garbage-collected, or this isn't the device that pushed it",
        );
      }
      if (jsonMode) {
        jsonOut(true, { version: chosen.version, payload });
        break;
      }
      console.log(`v${chosen.version} on ${id}:`);
      console.log(JSON.stringify(payload, null, 2));
      break;
    }
    // PBI-0414: 本文は server に送らない —— ここで build して端末の CAS へ書き、
    // manifest(payload_hash/size/mode/refs)だけを POST する(AC-1 の本体)
    if (sub === "capsule") {
      const id = args[1];
      if (!id) fail("Usage: openroly work capsule <id> --set key=value [--set key2=value2 ...]");
      const fields = collectSetFlags();
      if (Object.keys(fields).length === 0) {
        fail(`Specify at least one --set key=value (keys: ${CAPSULE_FIELDS.join(", ")})`);
      }
      const wres = await apiCall(url, `/v1/works/${encodeURIComponent(id)}`, { token: cred.token });
      if (wres.status !== 200) fail(worksErr(wres.status, wres.body));
      const w = wres.body as Record<string, unknown>;
      if (!w.lease_holder_run) {
        fail("NG no run holds this work — claim it first (openroly work claim <id> --run <runId>)");
      }
      let built: ReturnType<typeof buildCapsule>;
      try {
        built = buildCapsule(fields);
      } catch (e) {
        if (e instanceof CapsuleConversationError) fail(`NG ${e.code}: ${e.foundKeys.join(", ")}`);
        if (e instanceof CapsuleCredentialRefError) fail(`NG ${e.code}: ${JSON.stringify(e.value)} (only env:NAME is accepted)`);
        throw e;
      }
      const written = await writeCasPayload(built.body);
      const manifest = buildManifest(built.body, { hash: written.hash, size: written.size, mode: "0600" });
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/capsules`, {
        method: "POST",
        token: cred.token,
        body: { runId: w.lease_holder_run, expectedWriteEpoch: w.lease_epoch, ...manifest },
      });
      if (res.status !== 200 && res.status !== 201) fail(worksErr(res.status, res.body));
      const doc = res.body as { capsule: Record<string, unknown>; deduped: boolean };
      if (jsonMode) {
        jsonOut(true, { ...doc, dropped_keys: built.droppedKeys });
        break;
      }
      console.log(
        doc.deduped
          ? `OK no change: v${doc.capsule.version} on ${id} (same content as the last capsule — nothing new was pushed)`
          : `OK capsule v${doc.capsule.version} on ${id} (hash ${String(doc.capsule.content_hash).slice(0, 12)}… — payload stored locally, not on the server)`,
      );
      if (built.droppedKeys.length > 0) {
        console.log(`  dropped (not one of the 8 capsule fields): ${built.droppedKeys.join(", ")}`);
      }
      break;
    }
    // capsules: version 昇順の一覧(版の中身は出さない — hash と時刻だけ。中身は必要な版を選んだ後)
    if (sub === "capsules") {
      const id = args[1];
      if (!id) fail("Usage: openroly work capsules <id>");
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/capsules`, { token: cred.token });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const caps = res.body as Record<string, unknown>[];
      if (jsonMode) {
        jsonOut(true, { capsules: caps });
        break;
      }
      console.log(`${caps.length} capsule${caps.length === 1 ? "" : "s"} on ${id}`);
      for (const cp of caps) {
        console.log(`  v${cp.version}  ${cp.content_hash}  ${cp.created_at}`);
      }
      break;
    }
    // PBI-0410 / CAP-3 V4(C: 引き継いだ側): 選んだ版の git_state を今の cwd の clean な working
    // tree へ再適用する。**account 越境は capsules 取得の時点で 404(0406 の既存の壁)** ——
    // ここは取得が成功した後にしか git へ触らないので、越境時は 1 file も書かれない(AC-X1)。
    // PBI-0414: manifest しか server に無いので、本文(git_state)は payload_hash から**この端末の
    // CAS**を読む。別の端末が push した checkpoint はまだここに来ない(V5 待ち — スコープ外の壁)。
    // その場合は「無い」を明確に言う(壊れているかのような誤読をさせない)
    if (sub === "checkpoint-apply") {
      const id = args[1];
      if (!id) fail("Usage: openroly work checkpoint-apply <id> [--version <n>] [--remote <name>] [--cwd <path>]");
      const res = await apiCall(url, `/v1/works/${encodeURIComponent(id)}/capsules`, { token: cred.token });
      if (res.status !== 200) fail(worksErr(res.status, res.body));
      const caps = res.body as { version: number; body: { payload_hash?: string } }[];
      if (caps.length === 0) fail("NG no capsule on this work yet");
      const versionFlag = flagValue("--version");
      const chosen =
        versionFlag !== undefined ? caps.find((c) => String(c.version) === versionFlag) : caps[caps.length - 1];
      if (!chosen) fail(`NG no such capsule version: ${versionFlag}`);
      const payloadHash = chosen.body?.payload_hash;
      if (!payloadHash || typeof payloadHash !== "string") {
        fail(`NG capsule v${chosen.version} has no payload (its content was cleared from the server — PBI-0414)`);
      }
      const payload = await readCasPayload(payloadHash);
      if (!payload) {
        fail(
          `NG payload for v${chosen.version} not found in this device's local store (~/.openroly/checkpoints/${payloadHash.slice(0, 12)}…) — ` +
            "either it was garbage-collected, or this isn't the device that pushed it (cross-device checkpoint transfer isn't built yet)",
        );
      }
      const gitState = payload.git_state;
      if (!gitState || typeof gitState !== "object") fail(`NG capsule v${chosen.version} has no git_state`);
      const remote = flagValue("--remote");
      const targetCwd = flagValue("--cwd") ?? process.cwd();
      applyGitCheckpoint(targetCwd, gitState as GitState, remote ? { remote } : {});
      if (jsonMode) {
        jsonOut(true, { applied: true, version: chosen.version, dirty: (gitState as GitState).dirty });
        break;
      }
      console.log(`OK applied capsule v${chosen.version} (dirty:${(gitState as GitState).dirty}) into ${targetCwd}`);
      break;
    }
    // freeze — v0 Authority(PBI-0413): stop_primary。explicit user intent が要る
    const fid = args[1];
    const freezeIntent = flagValue("--intent");
    if (!fid) fail("Usage: openroly work freeze <id> --intent <token>");
    const res = await apiCall(url, `/v1/works/${encodeURIComponent(fid)}/freeze`, {
      method: "POST",
      token: cred.token,
      body: { intent: freezeIntent ?? null },
    });
    if (res.status !== 200) fail(worksErr(res.status, res.body));
    const w = res.body as Record<string, unknown>;
    if (jsonMode) {
      jsonOut(true, { work: w });
      break;
    }
    console.log(`OK froze ${w.id} (epoch ${w.lease_epoch} — previous epochs are rejected forever)`);
    break;
  }

  // PBI-0398 / 図78: resolve 済みの Context Package を 1 つ出す。**確認用の口**(本命は
  // V9 = Work Tool API)。静的側と動的側を別々に印字するのは、分離(C11 #9)を目で確かめられる
  // ようにする為 —— 「current_work が管理ブロックに入っていないか」をここで見る
  case "context": {
    if (args[0] !== "show") fail("Usage: openroly context show [--task <s>] [--json]");
    const creds = await loadCredentials();
    const cred = creds.runtimes.claude ?? Object.values(creds.runtimes)[0];
    if (!cred) fail("NG not paired yet. Run 'openroly login' first");
    const url = (baseUrl ?? cred.base_url).replace(/\/$/, "");
    const task = flagValue("--task");
    const res = await apiCall(
      url,
      `/v1/context${task === undefined ? "" : `?task=${encodeURIComponent(task)}`}`,
      { token: cred.token },
    );
    if (res.status !== 200) {
      fail(res.status === 404 ? "NG no such account (wrong credential?)" : `NG HTTP ${res.status}`);
    }
    const doc = res.body as {
      context: {
        tokenEstimate: number;
        truncationReport: { element: string; original: number; kept: number; reason: string }[];
        nearLimit: string[];
      };
      budget: number;
      static: string;
      dynamic: string;
    };
    if (jsonMode) {
      jsonOut(true, doc);
      break;
    }
    const indent = (s: string): string =>
      s === "" ? "  (empty)" : s.split("\n").map((l) => `  ${l}`).join("\n");
    console.log(`context package · ${doc.context.tokenEstimate} / ${doc.budget} tokens`);
    console.log("\nstatic — the managed block in each AI's instructions file:");
    console.log(indent(doc.static));
    console.log("\ndynamic — the session instruction:");
    console.log(indent(doc.dynamic));
    if (doc.context.truncationReport.length > 0) {
      console.log("\ntruncated (the head was kept, the tail was cut — nothing is dropped silently):");
      for (const t of doc.context.truncationReport) {
        console.log(`  ${t.element}: ${t.original} -> ${t.kept} tokens (${t.reason})`);
      }
    }
    if (doc.context.nearLimit.length > 0) {
      // 切られた要素もここに入る(上流と同じ数え方 = 切る**前**の材料で数える)。
      // 「まだ切れていない物」と読まれないよう before truncation と書く
      console.log(
        `\nunder pressure (85% or more of their limit before truncation): ${doc.context.nearLimit.join(", ")}`,
      );
    }
    break;
  }

  case "admin": {
    // 運営が助ける道(PBI-0135・図51 ③)。recovery code を控えていない人を 1 コマンドで戻す。
    // server 側は OPENROLY_ADMIN_TOKEN が無ければ 503(既定で無効)で、成功も失敗も activity に残る。
    // `--url` の値を positional と誤認しないよう、直前が --url の要素は除く
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");
    const [sub, rawHandle] = positional;
    if (sub !== "recover") {
      fail(`Unknown admin subcommand: ${sub ?? "(none)"}\nSupported: admin recover <handle>`);
    }
    const handle = rawHandle?.replace(/^@+/, "");
    if (!handle) fail("Specify a handle (e.g. openroly admin recover shibu)");
    const adminToken = process.env.OPENROLY_ADMIN_TOKEN;
    if (!adminToken) {
      fail("OPENROLY_ADMIN_TOKEN is not set. Pass the same value as the server's env");
    }
    // PBI-0169: 既定は「今在る session を全部落としてから 1 本出す」。**残す側を既定にしない**
    // —— 「token を無くした」で来る人の裏には「盗まれた」が混じっており、既定で残すと
    // 助けた同じ操作で盗んだ側も生かす。本人の端末が生きていると分かっている時だけ明示する
    const keepSessions = args.includes("--keep-sessions");
    const url = await accountBaseUrl(baseUrl);
    const res = await apiCall(url, "/v1/admin/sessions", {
      method: "POST",
      token: adminToken,
      body: { handle, keep_sessions: keepSessions },
    });
    if (res.status === 503) fail("NG the server has no OPENROLY_ADMIN_TOKEN (the admin path is disabled by default)");
    if (res.status === 401 || res.status === 403) fail("NG wrong admin token");
    if (res.status === 404) fail(`NG @${handle} was not found`);
    if (res.status !== 200) fail(`NG could not issue a session (HTTP ${res.status})`);
    console.log(`Session token for @${res.body.handle}:\n\n  ${res.body.token}\n`);
    console.log(
      keepSessions
        ? "Their other sessions were left open (--keep-sessions)."
        : `Signed out ${res.body.revoked_sessions ?? 0} other session(s) of that account.`,
    );
    console.log(
      `Hand it to the account holder over a safe channel. Pasting it into "Session token" on Sign in (${url}) gets them in.\n` +
        "Then tell them to set up a passkey or recovery codes under Settings › Sign-in methods",
    );
    break;
  }

  case "peek": {
    // PBI-0224: dedicated session の「model が見た面」を端末で見せる。読むのは broker の session_dir だけで、
    // server にも web にも送らない(log は端末にしか無い)。値は一度も復元しない
    const sessionsDir = join(brokerHome(), "sessions");
    if (args.includes("--list")) {
      console.log(renderList(sessionsDir));
      break;
    }
    let dir: string;
    if (target) {
      if (!SESSION_ID_RE.test(target)) fail(`Invalid session id: ${target}`);
      dir = join(sessionsDir, target);
      if (!existsSync(dir)) fail(`No session ${target} in ${sessionsDir}\nRun 'openroly peek --list' to see what is there`);
    } else {
      const latest = listSessions(sessionsDir, 1).entries[0];
      if (!latest) fail(`No sessions in ${sessionsDir}\nA dedicated session (AUTO / draft / triage / work) leaves one here`);
      dir = latest.dir;
    }
    if (args.includes("--json")) {
      process.stdout.write(rawPeek(dir));
      break;
    }
    if (args.includes("--follow")) {
      await followSession(dir);
      break;
    }
    console.log(renderSession(dir));
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
