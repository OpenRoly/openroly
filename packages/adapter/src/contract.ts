import type { ExtensionKind } from "@paa/core";
import { accessSync, constants as fsConstants } from "node:fs";

// Runtime Adapter Contract(配布戦略 §8)。
// 「Runtime ごとに Account pairing logic を再発明しない」(§7.2 Invariant)ため、
// runtime 固有なのは "その runtime へ MCP server をどう登録するか" だけに絞る。
// pairing / credential / 診断の本体は packages/adapter の engine 側にある。

/** 図 7 の adapter-contract ブロックと一致させる(diagrams-check.sh が検査) */
export const ADAPTER_OPS = [
  "id",
  "displayName",
  "capabilities",
  "detect",
  "register",
  "unregister",
  "doctor",
  "extensionKinds",
  "listExtensions",
  "applyExtension",
] as const;

export type AdapterOp = (typeof ADAPTER_OPS)[number];

/** 配布戦略 §8 の想定 contract に対する対応可否の宣言 */
export interface AdapterCapabilities {
  pair: boolean;
  status: boolean;
  notify: boolean;
  /** runtime への push(notify)と wake 系は Device Broker(要件 §21)が要る。Stage 0 は false */
  wake: boolean;
  createSession: boolean;
  sendInstruction: boolean;
}

export const STAGE0_CAPABILITIES: AdapterCapabilities = {
  pair: true,
  status: true,
  notify: false,
  wake: false,
  createSession: false,
  sendInstruction: false,
};

/** 子プロセス(runtime CLI)へ渡す環境。test は temp HOME / CODEX_HOME を注入する */
export interface AdapterContext {
  env: Record<string, string | undefined>;
}

export interface RegisterInput {
  /** MCP server の entry file(bun で起動する) */
  serverEntry: string;
  /** credential store 内の key。MCP server は PAA_RUNTIME_KIND でこれを選ぶ */
  runtimeKind: string;
  baseUrl: string;
  /** runtime 側に登録する MCP server 名 */
  serverName: string;
}

export interface DetectResult {
  /** runtime の CLI / 設定が見つかったか */
  installed: boolean;
  /** 見つからない時に人へ出す説明 */
  detail: string;
  /** 設定 file の場所(見つかった時) */
  configPath?: string;
}

export interface Finding {
  ok: boolean;
  label: string;
  detail: string;
}

/** listExtensions の結果。今のところ mcp のみなので kind は持たない(採用したら足す) */
export interface ExtensionListing {
  name: string;
}

export type ExtensionApplyAction =
  | {
      action: "install";
      name: string;
      kind: ExtensionKind;
      spec: Record<string, unknown>;
      /** credential_ref をローカル解決した結果を含む、native へそのまま渡す env */
      env: Record<string, string>;
    }
  | {
      action: "update";
      name: string;
      kind: ExtensionKind;
      spec: Record<string, unknown>;
      env: Record<string, string>;
    }
  | { action: "disable"; name: string }
  | { action: "uninstall"; name: string };

export interface RuntimeAdapter {
  /** credential store の key 兼 CLI 引数(例: "claude") */
  id: string;
  /** §32.4 Connected runtimes の表示名(例: "Claude Code") */
  displayName: string;
  capabilities: AdapterCapabilities;
  detect(ctx: AdapterContext): Promise<DetectResult>;
  register(ctx: AdapterContext, input: RegisterInput): Promise<void>;
  unregister(ctx: AdapterContext, serverName: string): Promise<void>;
  /** runtime 側の登録状態のみ見る。Account 側の診断は engine の doctorRuntime が行う */
  doctor(ctx: AdapterContext, serverName: string): Promise<Finding[]>;
  /** この runtime が materialize できる Extension kind(PBI-0005 では official 2 実装とも ["mcp"]) */
  extensionKinds: ExtensionKind[];
  /** native に実在する extension(今のところ mcp server のみ)の一覧 */
  listExtensions(ctx: AdapterContext): Promise<ExtensionListing[]>;
  /** install/update/disable/uninstall を native へ反映する。書式は runtime CLI に任せる */
  applyExtension(ctx: AdapterContext, action: ExtensionApplyAction): Promise<void>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

/**
 * `run()` が bare な command を解決する時に PATH の後ろへ足す dir(PBI-0050)。
 * broker の discovery `default_bin_dirs`(broker/src/discovery.rs) と同じ一覧 — launchd が
 * `atn broker` を最小 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)で起こした時も、adopt →
 * `claude mcp add` がユーザーの install 先(`~/.local/bin` 等)を解決できるようにする。
 * broker が検出した場所で登録できないと自動登録(EP-0004)が heartbeat 毎に失敗し続けるので、
 * この一覧は broker 側と意図的に同じ内容を保つ(片方だけ直ると検出と登録が噛み合わない)
 */
function extraPathDirs(env: Record<string, string>): string[] {
  // 上書きの口(PBI-0050 レビュー 2026-08-28): 未設定なら本番どおりの既定一覧。設定した時は
  // それだけで置き換える(空文字 = 補強なし)。test が「CLI 無し / fake のみ」の env を作る時に
  // 実機の /usr/local/bin 等へ届かないようにするための口で、本番の launchd では未設定のまま
  if (env.PAA_EXTRA_PATH_DIRS !== undefined) {
    return env.PAA_EXTRA_PATH_DIRS.split(":").filter(Boolean);
  }
  const dirs = ["/usr/local/bin", "/opt/homebrew/bin"];
  if (env.HOME) {
    dirs.push(`${env.HOME}/.local/bin`, `${env.HOME}/.cargo/bin`, `${env.HOME}/.npm-global/bin`);
  }
  if (env.NPM_CONFIG_PREFIX) dirs.push(`${env.NPM_CONFIG_PREFIX}/bin`);
  return dirs;
}

/**
 * **runtime 側の CLI がどこにも無い**時の named reason(PBI-0236)。broker の `register_ack.detail` と
 * broker log(`broker: adopt kind=… detail=…`)にそのまま載るので、`paa_cli_not_found`
 * (= broker が **`atn` 自身**を起こせない)と**混ざらない別の名前**を持たせる —— 混ぜると
 * 「node/CLI を入れ直せ」と「atn が配布で PATH に無い」が同じ顔になり、人が直せなくなる。
 */
export const RUNTIME_CLI_NOT_FOUND = "runtime_cli_not_found";

/**
 * bare な command を PATH で解決する。PATH に無ければ `extraPathDirs` も見て absolute path を
 * 返す(`/` を含む command はそのまま)。どこにも無ければ名前の付いた Error —— ENOENT の生を
 * register の error message(= broker の register_ack detail)に晒さない(PBI-0050 AC-X2)。
 *
 * `Bun.which` を使わず自前で走査する —— 実測(2026-08-28)では `Bun.which(cmd, { env })` が
 * `env.PATH` を無視して **親 process の PATH**(`process.env.PATH`)から解決する。launchd 最小
 * PATH の再現(test)や、将来 PATH を意図的に絞る呼び出しで契約が壊れるので、渡された env の
 * PATH だけを見る解決をこの file に持つ
 */
function whichIn(dirs: string[], cmd: string): string | null {
  for (const dir of dirs) {
    if (!dir) continue;
    const p = `${dir}/${cmd}`;
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch {
      // 次の dir へ
    }
  }
  return null;
}

function resolveCommand(env: Record<string, string>, cmd: string): string {
  if (cmd.includes("/")) return cmd;
  const pathDirs = (env.PATH ?? "").split(":");
  const direct = whichIn(pathDirs, cmd);
  if (direct) return direct;
  const found = whichIn(extraPathDirs(env), cmd);
  if (found) return found;
  throw new Error(
    `${RUNTIME_CLI_NOT_FOUND}: ${cmd} was not found in PATH or the fallback dirs ` +
      `(if it is installed, check PATH; otherwise install the runtime first)`,
  );
}

/** adapter 実装が runtime CLI を叩くための共通 helper */
export async function run(
  ctx: AdapterContext,
  cmd: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) env[k] = v;
  const program = resolveCommand(env, cmd[0]!);
  const proc = Bun.spawn([program, ...cmd.slice(1)], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}
