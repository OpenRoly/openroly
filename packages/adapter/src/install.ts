import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiCall } from "./api.ts";
import { buildBrief, unreadTotal } from "./brief.ts";
import { ensureBinary, type EnsureBinaryOutcome } from "./binary.ts";
import {
  getAccountUrl,
  getCredential,
  openrolyHome,
  removeCredential,
  type RuntimeCredential,
} from "./credentials.ts";
import { checkoutMcpNewerThanBinary } from "./mcp-config.ts";
import { pairRuntime, type PairPrompt } from "./pairing.ts";
import type { AdapterContext, Finding, ExtensionAdapter } from "./contract.ts";

// Common Installation Engine(配布戦略 §7.2)。
// UX は plugin-first でも、pairing / config detection / credential registration /
// upgrade / uninstall / diagnostics はここ 1 箇所に集約する。

/** runtime へ登録する MCP server の entry。repo checkout を bun で起動する */
export const MCP_SERVER_ENTRY = fileURLToPath(
  new URL("../../mcp/src/server.ts", import.meta.url),
);

/** runtime 側の設定に載る MCP server 名 */
export const MCP_SERVER_NAME = "openroly";

/**
 * 何も設定されていない端末の行き先(PBI-0641)。**localhost ではない** —— 公開した binary を
 * 手に入れた人が最初に打つ `pair` / `doctor` が名乗るのはこの 1 本で、そこに開発機の port を
 * 出していた(PBI-0638 実測: `cannot connect to` の後ろが開発機の localhost だった)。Android / Windows の
 * collector は最初からこの値を既定にしている。手元の server を指す時は `--url` /
 * `$OPENROLY_URL` / `openroly login --url` —— 下の優先順位がそのまま効く。
 */
export const DEFAULT_BASE_URL = "https://openroly.shibubu.ai";

/**
 * この端末が繋ぐ Account API の URL を決める **唯一の関数**(PBI-0246・図7.1)。
 *
 * 順序: 明示(`--url` / `$OPENROLY_URL`)> `openroly login` が決めた account の URL >
 * 呼び手が既に持っている credential の base_url > `DEFAULT_BASE_URL`。
 *
 * - **明示が必ず勝つ**: ここを崩すと、別 server へ繋ぎ替える手段が無くなる。
 * - **account の URL は credential より前**: 呼び手の credential は「その runtime が昔
 *   居た server」であって、この端末が今 login している account の server とは限らない。
 *   死んだ旧 server の URL で pair し直しても人は前に進めない。
 * - `?? DEFAULT_BASE_URL` を command 側に散らさない —— 散らした結果が「`install` は通るのに
 *   `pair` だけ localhost へ落ちる」(2026-09-04 の gate 実測で quickstart の 5 行目が死んだ)。
 */
export async function accountBaseUrl(
  explicit?: string,
  fallback?: string,
  env: Env = process.env,
): Promise<string> {
  const clean = (u: string) => u.replace(/\/$/, "");
  if (explicit) return clean(explicit);
  const saved = await getAccountUrl(env);
  if (saved) return clean(saved);
  if (fallback) return clean(fallback);
  return DEFAULT_BASE_URL;
}

type Env = Record<string, string | undefined>;

export interface EngineOptions {
  adapter: ExtensionAdapter;
  ctx: AdapterContext;
  baseUrl?: string;
  /** credential store 用の環境(OPENROLY_HOME)。既定は process.env */
  env?: Env;
  serverEntry?: string;
  serverName?: string;
}

export interface InstallOptions extends EngineOptions {
  onPrompt: (prompt: PairPrompt) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 既存 credential が有効でも pair し直す */
  repair?: boolean;
  hostLabel?: string;
}

export type InstallOutcome =
  | { status: "installed"; credential: RuntimeCredential; paired: boolean; findings: Finding[] }
  | { status: "runtime_not_found"; detail: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "failed"; detail: string };

export async function installRuntime(options: InstallOptions): Promise<InstallOutcome> {
  const { adapter, ctx } = options;
  const env = options.env ?? process.env;
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  // 呼び手が明示した URL(`--url` / `$OPENROLY_URL`)。**ここで既定値に潰さない** —— 潰すと
  // 「明示された」と「省略された」が区別できなくなり、resolver の 1 行目が常に勝ってしまう
  const requestedUrl = options.baseUrl?.replace(/\/$/, "");

  const detected = await adapter.detect(ctx);
  if (!detected.installed) return { status: "runtime_not_found", detail: detected.detail };

  // upgrade 経路: 既に有効な credential があれば pair し直さない(§7.2 upgrade)。
  // ただし**行き先が変わった**なら再利用できない —— そのまま進むと旧 server の token と URL が
  // runtime に登録され、「接続しました」の表示だけが嘘になる
  let credential = await getCredential(adapter.id, env);
  let paired = false;
  // URL 未指定なら account の URL(login が決めた物)→ 既存 credential の server の順(図7.1)
  const baseUrl = await accountBaseUrl(requestedUrl, credential?.base_url, env);
  // 比べるのは **resolver が決めた行き先**であって、明示された値ではない(PBI-0246 レビュー)。
  // 明示だけを見ていると、`openroly login --url <prod>` の後も、dev で作った credential が
  // まだ 200 を返す間は install がそこに留まる —— doctor は prod を名乗り register は dev を
  // 書く「名乗る先と繋ぐ先が割れた」状態になる。account_url が無い時は baseUrl が
  // credential.base_url に落ちるので、この式は今までどおり false(AC-16 は動いたまま)
  const urlChanged = credential != null && credential.base_url.replace(/\/$/, "") !== baseUrl;
  if (options.repair || !credential || urlChanged || !(await isCredentialValid(credential))) {
    const outcome = await pairRuntime({
      baseUrl,
      kind: adapter.id,
      name: `${options.hostLabel ?? hostname()} / ${adapter.displayName}`,
      onPrompt: options.onPrompt,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.now ? { now: options.now } : {}),
      env,
    });
    if (outcome.status !== "paired") return outcome;
    credential = outcome.credential;
    paired = true;
  }

  // register の**前**に binary を置く —— register が書き込む command は
  // resolveMcpServerCommand(PBI-0132)の結果なので、順序が逆だと今回の install だけ bun のまま残る
  const binary = await ensureBinary("openroly-mcp", { env });
  // plugin dir の bundle(PBI-0597)。**生成物なので repo には入っていない** —— plugin 経由で
  // 起こされた時の bun 経路(launcher の 3 段目)がここで揃う。binary が在れば使われない道なので、
  // 作れない事は失敗ではない(bun が無い / repo の外から入れた = binary 経路で動く)
  const bundle = buildPluginBundles();

  await adapter.register(ctx, {
    serverEntry: options.serverEntry ?? MCP_SERVER_ENTRY,
    runtimeKind: adapter.id,
    baseUrl: credential.base_url,
    serverName,
  });

  return {
    status: "installed",
    credential,
    paired,
    findings: [binaryFinding(binary), bundle, ...(await doctorRuntime({ ...options, serverName }))],
  };
}

/**
 * plugin dir の `mcp-server.bundle.js` を source から作る(PBI-0597)。**追跡をやめた生成物**を、
 * 実際に要る瞬間(install)に置く。手順の正本は package.json の `plugin:build` —— ここで build 行を
 * 写さず、その script をそのまま呼ぶ(2 箇所に置くと必ずずれる。それが PBI-0597 の発端)。
 *
 * 失敗は **ok:true** で返す: bundle は launcher の 3 段目(bun 経路)の材料でしかなく、binary が
 * 在る端末では 1 度も使われない。ここを ok:false にすると、bun の無い端末で `openroly install` が
 * exit 1 になる(binary で完全に動くのに)。
 */
export function buildPluginBundles(): Finding {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const script = join(repoRoot, "package.json");
  if (!existsSync(script) || !existsSync(join(repoRoot, "adapters/official/claude"))) {
    return { ok: true, label: "Plugin bundle", detail: "skipped (not running from the repo; the binary path does not need it)" };
  }
  try {
    const built = Bun.spawnSync(["bun", "run", "plugin:build"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    return built.exitCode === 0
      ? { ok: true, label: "Plugin bundle", detail: "built into adapters/official/{claude,codex} (used when the plugin starts it with bun)" }
      : {
          ok: true,
          label: "Plugin bundle",
          detail: `could not be built (${built.stderr.toString().trim().split("\n").at(-1) ?? "unknown"}). The binary path still works`,
        };
  } catch (e) {
    // bun が PATH に無い機では spawnSync は exitCode を返さず **throw する**(PBI-0610 実測:
    // `Executable not found in $PATH: "bun"`)。失敗の扱いを exitCode 経路と 1 つにする ——
    // ここで落とすと「bun の無い端末で install を exit 1 にしない」という上の約束が破れる。
    return {
      ok: true,
      label: "Plugin bundle",
      detail: `could not be built (${e instanceof Error ? e.message : String(e)}). The binary path still works`,
    };
  }
}

/**
 * binary 取得の結果を 1 finding に。**取れなかったこと自体は失敗ではない**(bun 経路で動く)ので
 * ok:true —— ここを false にすると network が無いだけで `openroly install` が exit 1 になる。
 * checksum 不一致だけは ok:false(壊れた / すり替えられた binary は黙って流さない)。
 */
function binaryFinding(outcome: EnsureBinaryOutcome): Finding {
  switch (outcome.status) {
    case "present":
      return { ok: true, label: "MCP binary", detail: `${outcome.path} (already the latest version)` };
    case "downloaded":
      return {
        ok: true,
        label: "MCP binary",
        detail: `fetched the ${outcome.target} build into ${outcome.path} (runs without bun)`,
      };
    case "checksum_mismatch":
      return { ok: false, label: "MCP binary", detail: `${outcome.detail}. Nothing was placed` };
    default:
      return {
        ok: true,
        label: "MCP binary",
        detail: `${outcome.detail}. Registering the bun path instead (bun is required)`,
      };
  }
}

export interface UninstallOutcome {
  unregistered: boolean;
  credentialRemoved: boolean;
  /** unregister が失敗した理由。CLI はこれを出す(握り潰すと「未登録」と区別が付かない) */
  detail?: string;
}

export async function uninstallRuntime(options: EngineOptions): Promise<UninstallOutcome> {
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  let unregistered = true;
  let detail: string | undefined;
  try {
    await options.adapter.unregister(options.ctx, serverName);
  } catch (e) {
    // runtime CLI が壊れている / PATH に無い場合と「元々未登録」を混ぜない
    unregistered = false;
    detail = (e as Error).message;
  }
  // Cloud 側の credential 失効(revoke)は human session が要るので web/settings 側の操作。
  // ここで消すのはローカル保管分のみ。
  const credentialRemoved = await removeCredential(
    options.adapter.id,
    options.env ?? process.env,
  );
  return detail === undefined
    ? { unregistered, credentialRemoved }
    : { unregistered, credentialRemoved, detail };
}

export async function doctorRuntime(options: EngineOptions): Promise<Finding[]> {
  const { adapter, ctx } = options;
  const env = options.env ?? process.env;
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  const findings: Finding[] = [];

  const detected = await adapter.detect(ctx);
  findings.push({
    ok: detected.installed,
    label: `${adapter.displayName} detected`,
    detail: detected.detail,
  });

  const credential = await getCredential(adapter.id, env);
  if (!credential) {
    // **行き先を名乗る**(PBI-0246)—— 未 pair の runtime にはまだ credential が無いので、
    // ここが「この端末は今どの server に繋ぎに行くのか」を人が読める唯一の面になる。
    // **案内する command は README の語**(PBI-0641)。README §Get started は `login` → `pair` で、
    // `install` を 1 度も持たない —— 公開後に最初の 1 人が読むのは README なので、同じ行為を
    // 2 通りの名前で呼ばない(`pair` は credential を作り直すので、失効した時の道もこちらで足りる)
    findings.push({
      ok: false,
      label: "credential",
      detail:
        `not paired. Run 'openroly pair ${adapter.id}' ` +
        `(it will connect to ${await accountBaseUrl(options.baseUrl, undefined, env)})`,
    });
    return findings;
  }
  findings.push({
    ok: true,
    label: "credential",
    detail: `${credential.name} (${credential.runtime_id}) → ${credential.base_url}`,
  });

  const who = await apiCall(credential.base_url, "/v1/whoami", { token: credential.token });
  if (who.status !== 200) {
    // dogfood F60: 5xx の時「自分の credential が悪いのか server が死んでいるのか」を doctor が言う。
    // `/health` は DB を触らないので、200 なら process は生きていて裏（DB 等）が落ちている。
    // 届かなくても doctor は落とさない —— 下の 1 行に戻るだけ
    const health = who.status >= 500
      ? await apiCall(credential.base_url, "/health", { signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0)
      : 0;
    findings.push({
      ok: false,
      label: "Account connection",
      detail:
        who.status === 401
          ? `the credential was revoked. Reconnect with 'openroly pair ${adapter.id}'`
          : health === 200
            ? `the account server is up (/health 200) but its API fails (whoami ${who.status}) — server-side outage (database or quota), not this credential. Nothing to fix on this machine`
            : `whoami returned ${who.status}`,
    });
  } else {
    let messages: unknown[] = [];
    try {
      const inbox = await apiCall(credential.base_url, "/v1/inbox/messages", { token: credential.token });
      if (inbox.status === 200 && Array.isArray(inbox.body)) messages = inbox.body;
    } catch {
      /* 古い server / 401 は inbox 件数だけ（F54 と同じ） */
    }
    const brief = buildBrief(who.body, messages);
    findings.push({
      ok: true,
      label: "Account connection",
      detail: `attached as @${who.body.handle} (unread ${unreadTotal(brief)})`,
    });
  }

  findings.push(...(await adapter.doctor(ctx, serverName)));
  findings.push(await extensionDriftFinding(credential.base_url, credential.token, credential.runtime_id));
  const compiled = join(openrolyHome(env), "bin", "openroly-mcp");
  if (existsSync(MCP_SERVER_ENTRY)) {
    const stale = checkoutMcpNewerThanBinary(MCP_SERVER_ENTRY, compiled);
    findings.push({
      ok: true,
      label: "MCP source",
      detail: stale
        ? "checkout newer than compiled — next start uses bun (restart this session to load it)"
        : existsSync(compiled)
          ? `compiled ${compiled}`
          : `bun ${MCP_SERVER_ENTRY}`,
    });
  }
  if (options.env == null) {
    await import("./hub.ts").then((h) => h.applyOpenRolyMcp(env)).catch(() => null);
  }
  return findings;
}

/**
 * extension sync の drift(failed / revision 未追随)を 1 finding にまとめる。
 * fetch 失敗(旧 server・一時的ネットワーク断)や extension が 0 件の場合は ok:true にする ——
 * ここを false にすると 'openroly install' の成否が Extension Sync という無関係な機能に
 * 引きずられて exit code 1 になってしまう
 */
async function extensionDriftFinding(
  baseUrl: string,
  token: string,
  runtimeId: string,
): Promise<Finding> {
  const res = await apiCall(baseUrl, "/v1/extensions", { token }).catch(() => null);
  if (!res || res.status !== 200 || !Array.isArray(res.body)) {
    return { ok: true, label: "Extensions", detail: "could not be checked (the server may not support it)" };
  }
  let failed = 0;
  let behind = 0;
  for (const ext of res.body as any[]) {
    const mat = ext.materializations?.find((m: any) => m.runtime_id === runtimeId);
    if (!mat) continue;
    if (mat.status === "failed") failed++;
    else if (
      ext.enabled &&
      ext.deleted_at == null &&
      typeof mat.applied_revision === "number" &&
      mat.applied_revision < ext.revision
    ) {
      behind++;
    }
  }
  return {
    ok: failed === 0 && behind === 0,
    label: "Extensions",
    detail: `failed ${failed} / behind ${behind}`,
  };
}

async function isCredentialValid(credential: RuntimeCredential): Promise<boolean> {
  try {
    const who = await apiCall(credential.base_url, "/v1/whoami", { token: credential.token });
    return who.status === 200;
  } catch {
    return false;
  }
}
