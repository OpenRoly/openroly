import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { apiCall } from "./api.ts";
import { ensureBinary, type EnsureBinaryOutcome } from "./binary.ts";
import {
  getAccountUrl,
  getCredential,
  removeCredential,
  type RuntimeCredential,
} from "./credentials.ts";
import { pairRuntime, type PairPrompt } from "./pairing.ts";
import type { AdapterContext, Finding, RuntimeAdapter } from "./contract.ts";

// Common Installation Engine(配布戦略 §7.2)。
// UX は plugin-first でも、pairing / config detection / credential registration /
// upgrade / uninstall / diagnostics はここ 1 箇所に集約する。

/** runtime へ登録する MCP server の entry。repo checkout を bun で起動する */
export const MCP_SERVER_ENTRY = fileURLToPath(
  new URL("../../mcp/src/server.ts", import.meta.url),
);

/** runtime 側の設定に載る MCP server 名 */
export const MCP_SERVER_NAME = "atn";

export const DEFAULT_BASE_URL = "http://localhost:8787";

/**
 * この端末が繋ぐ Account API の URL を決める **唯一の関数**(PBI-0246・図7.1)。
 *
 * 順序: 明示(`--url` / `$PAA_URL`)> `atn login` が決めた account の URL >
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
  adapter: RuntimeAdapter;
  ctx: AdapterContext;
  baseUrl?: string;
  /** credential store 用の環境(PAA_HOME)。既定は process.env */
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
  // 呼び手が明示した URL(`--url` / `$PAA_URL`)。**ここで既定値に潰さない** —— 潰すと
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
  // 明示だけを見ていると、`atn login --url <prod>` の後も、dev で作った credential が
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
  const binary = await ensureBinary("atn-mcp", { env });

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
    findings: [binaryFinding(binary), ...(await doctorRuntime({ ...options, serverName }))],
  };
}

/**
 * binary 取得の結果を 1 finding に。**取れなかったこと自体は失敗ではない**(bun 経路で動く)ので
 * ok:true —— ここを false にすると network が無いだけで `atn install` が exit 1 になる。
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
    // ここが「この端末は今どの server に繋ぎに行くのか」を人が読める唯一の面になる
    findings.push({
      ok: false,
      label: "credential",
      detail:
        `not paired. Run 'atn install ${adapter.id}' ` +
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
  findings.push(
    who.status === 200
      ? {
          ok: true,
          label: "Account connection",
          detail: `attached as @${who.body.handle} (unread ${who.body.unread})`,
        }
      : {
          ok: false,
          label: "Account connection",
          detail:
            who.status === 401
              ? `the credential was revoked. Reconnect with 'atn install ${adapter.id}'`
              : `whoami returned ${who.status}`,
        },
  );

  findings.push(...(await adapter.doctor(ctx, serverName)));
  findings.push(await extensionDriftFinding(credential.base_url, credential.token, credential.runtime_id));
  return findings;
}

/**
 * extension sync の drift(failed / revision 未追随)を 1 finding にまとめる。
 * fetch 失敗(旧 server・一時的ネットワーク断)や extension が 0 件の場合は ok:true にする ——
 * ここを false にすると 'atn install' の成否が Extension Sync という無関係な機能に
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
