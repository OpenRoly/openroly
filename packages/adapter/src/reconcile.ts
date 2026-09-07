import {
  planReconciliation,
  type DesiredExtension,
  type MaterializationState,
  type PlanAction,
} from "@openroly/core";
import { apiCall } from "./api.ts";
import type { AdapterContext, RuntimeAdapter } from "./contract.ts";
import { loadSecrets } from "./credentials.ts";

// Reconcile engine(PBI-0005)。Common Installation Engine(install.ts)と同じ場所に置く:
// desired を API から取得 → listExtensions で actual → planReconciliation → applyExtension
// を 1 件ずつ → noop 以外の結果を POST /v1/extensions/:id/status へ返す。
// credential_ref の解決は scheme で分岐する(PBI-0009): env:NAME はここでローカル解決
// (process.env.NAME。secret は Account を一度も通らない)、connection:<provider> は
// POST /v1/connections/:provider/resolve で Account 側に解決させる(§40)。
// 1 件の失敗で全体を止めない(残りは適用し、失敗分だけ failed を報告する)。

type Env = Record<string, string | undefined>;

export interface ReconcileOptions {
  adapter: RuntimeAdapter;
  ctx: AdapterContext;
  baseUrl: string;
  /** 対象 runtime の credential token */
  token: string;
  runtimeId: string;
  /** plan だけ出して native/DB に一切書き込まない */
  dryRun?: boolean;
  /** credential_ref(env:NAME)解決用。既定は process.env */
  env?: Env;
}

export interface ReconcileItemResult {
  action: PlanAction["action"];
  name: string;
}

export interface ReconcileFailure {
  name: string;
  detail: string;
}

export interface ReconcileResult {
  plan: PlanAction[];
  applied: ReconcileItemResult[];
  failed: ReconcileFailure[];
}

interface DesiredWireMaterialization {
  runtime_id: string;
  status: string;
  applied_revision: number | null;
  detail: string | null;
}

interface DesiredWire {
  id: string;
  kind: DesiredExtension["kind"];
  name: string;
  spec: Record<string, unknown>;
  credential_ref: string | null;
  enabled: boolean;
  revision: number;
  deleted_at: string | null;
  materializations: DesiredWireMaterialization[];
}

/**
 * status 報告。**HTTP 応答を検査する**(PBI-0023 F3) —— apiCall は非 2xx でも throw せず
 * `{status, body}` を返すので、戻り値を捨てると 403/404/500 が「適用済み」として集計され、
 * CLI が成功を表示して exit 0 で終わる(DB は無変更)。AC-14 の exit 1 も AC-16 の
 * 「2 回目は全件 noop」も、この検査が無いと嘘になる。
 */
async function reportStatus(
  options: ReconcileOptions,
  extensionId: string,
  body: { status: string; appliedRevision?: number | null; detail?: string },
): Promise<void> {
  const res = await apiCall(options.baseUrl, `/v1/extensions/${extensionId}/status`, {
    token: options.token,
    method: "POST",
    body: {
      status: body.status,
      applied_revision: body.appliedRevision ?? null,
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `status report failed (${res.status}): POST /v1/extensions/${extensionId}/status`,
    );
  }
}

/**
 * credential_ref を解決する。scheme は 2 種:
 * - env:NAME(`,` 区切りで複数可)→ ローカル解決。**process.env → `~/.openroly/secrets.json`** の順で
 *   引く(PBI-0212)。吸い上げ(`openroly share`)が置いた値はこの file にしか無く、Account 側は
 *   名前しか持たない —— 秘密は Account を一度も通らない(§40)
 * - connection:<provider> → Account 側(server)で解決(PBI-0009。§40「解決は Account 側で行う」)。
 *   POST /v1/connections/:provider/resolve を叩き、返る env をそのまま注入する。
 *   secret は runtime のローカル credential store(credentials.ts)へは一切書かない —
 *   毎 sync で引き直すだけ(§40.4「credential 複製しない」)
 */
async function resolveCredentialRef(
  ref: string | null,
  env: Env,
  options: ReconcileOptions,
): Promise<{ ok: true; env: Record<string, string> } | { ok: false; detail: string }> {
  if (ref == null) return { ok: true, env: {} };
  if (ref.startsWith("env:")) {
    const names = ref.slice("env:".length).split(",").filter(Boolean);
    if (names.length === 0) return { ok: false, detail: `cannot resolve ${ref}` };
    let stored: Record<string, string>;
    try {
      stored = await loadSecrets(env);
    } catch (e) {
      // 壊れた secrets.json を空として扱わない —— 「解決できた」と誤認させず理由を名指しする
      return { ok: false, detail: `cannot read the local secret store: ${(e as Error).message}` };
    }
    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const value = env[name] || stored[name];
      if (!value) missing.push(name);
      else out[name] = value;
    }
    if (missing.length > 0) {
      return { ok: false, detail: `cannot resolve env:${missing.join(",")} (not in the environment or ~/.openroly/secrets.json)` };
    }
    return { ok: true, env: out };
  }
  const connMatch = /^connection:(.+)$/.exec(ref);
  if (connMatch) {
    const provider = connMatch[1]!;
    const res = await apiCall<{ env?: Record<string, string> }>(
      options.baseUrl,
      `/v1/connections/${provider}/resolve`,
      { token: options.token, method: "POST" },
    );
    if (res.status !== 200 || !res.body?.env) {
      return { ok: false, detail: `cannot resolve ${ref}` };
    }
    return { ok: true, env: res.body.env };
  }
  return { ok: false, detail: `unsupported credential_ref scheme: ${ref}` };
}

function asStringRecord(v: unknown): Record<string, string> {
  if (v == null || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const env = options.env ?? process.env;
  const res = await apiCall<DesiredWire[]>(options.baseUrl, "/v1/extensions", {
    token: options.token,
  });
  if (res.status !== 200) {
    throw new Error(`GET /v1/extensions failed: ${res.status}`);
  }

  const desired: DesiredExtension[] = res.body.map((d) => ({
    id: d.id,
    kind: d.kind,
    name: d.name,
    spec: d.spec,
    credentialRef: d.credential_ref,
    enabled: d.enabled,
    revision: d.revision,
    deletedAt: d.deleted_at,
  }));
  const materialized: MaterializationState[] = res.body.flatMap((d) =>
    d.materializations
      .filter((m) => m.runtime_id === options.runtimeId)
      .map((m) => ({
        extensionId: d.id,
        status: m.status as MaterializationState["status"],
        appliedRevision: m.applied_revision,
      })),
  );

  const listing = await options.adapter.listExtensions(options.ctx);
  const actual = listing.map((l) => l.name);

  const plan = planReconciliation({
    desired,
    materialized,
    actual,
    supportedKinds: options.adapter.extensionKinds,
  });

  if (options.dryRun) return { plan, applied: [], failed: [] };

  const applied: ReconcileItemResult[] = [];
  const failed: ReconcileFailure[] = [];

  /**
   * failed の報告は best-effort。ここまで来ている時点で native 適用か status 報告の
   * どちらかが既に失敗しているので、報告自体の失敗で 1 件目の失敗理由を握り潰さない
   * (残りの extension の処理も止めない — 「1 件の失敗で全体を止めない」の維持)
   */
  const reportFailure = async (extensionId: string, detail: string): Promise<void> => {
    await reportStatus(options, extensionId, { status: "failed", detail }).catch(() => {});
  };

  for (const item of plan) {
    if (item.action === "noop") continue;

    if (item.action === "unsupported") {
      try {
        await reportStatus(options, item.extensionId, {
          status: "unsupported",
          detail: item.detail,
        });
        applied.push({ action: item.action, name: item.name });
      } catch (e) {
        failed.push({ name: item.name, detail: (e as Error).message });
      }
      continue;
    }

    if (item.action === "uninstall" || item.action === "disable") {
      try {
        await options.adapter.applyExtension(options.ctx, { action: item.action, name: item.name });
        await reportStatus(options, item.extensionId, {
          status: item.action === "uninstall" ? "uninstalled" : "disabled",
        });
        applied.push({ action: item.action, name: item.name });
      } catch (e) {
        const detail = (e as Error).message;
        failed.push({ name: item.name, detail });
        await reportFailure(item.extensionId, detail);
      }
      continue;
    }

    // install | update
    const resolved = await resolveCredentialRef(item.credentialRef, env, options);
    if (!resolved.ok) {
      failed.push({ name: item.name, detail: resolved.detail });
      await reportFailure(item.extensionId, resolved.detail);
      continue;
    }
    try {
      await options.adapter.applyExtension(options.ctx, {
        action: item.action,
        name: item.name,
        kind: item.kind,
        spec: item.spec,
        env: { ...asStringRecord(item.spec.env), ...resolved.env },
      });
      await reportStatus(options, item.extensionId, {
        status: "applied",
        appliedRevision: item.revision,
      });
      applied.push({ action: item.action, name: item.name });
    } catch (e) {
      const detail = (e as Error).message;
      failed.push({ name: item.name, detail });
      await reportFailure(item.extensionId, detail);
    }
  }

  return { plan, applied, failed };
}
