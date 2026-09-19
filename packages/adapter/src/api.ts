// Account API への最小 client。engine が使うのは pairing / whoami / inbox metadata だけで、
// runtime 向けの §16 contract は packages/mcp が持つ(依存の向きは mcp → adapter)。

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

/**
 * fetch が reject した時の 1 行。生の message(Bun: "Unable to connect. Is the computer able to
 * access the url?")は人向けの説明として長く、stack trace と見分けが付かないので、
 * error code(`ConnectionRefused` / `ECONNREFUSED` 等)が有ればそれだけを添える。
 * **文言はここが 1 箇所目で唯一**(PBI-0640 に pairing.ts から移した —— 2 箇所に割ると必ずずれる)
 */
export function unreachableDetail(baseUrl: string, e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const why = typeof code === "string" && code ? code : ((e as Error)?.message ?? String(e));
  return `cannot connect to ${baseUrl} (${why})`;
}

/**
 * account server に届かなかった(PBI-0640)。**素の fetch の reject を外へ出さない** ——
 * 出すと CLI は NG 1 行ではなく bun の stack trace(絶対 path 付き)で落ちる。実測 2026-09-16:
 * pair 済みの credential で `openroly continue` / `work list` がそうなっていた。
 * PBI-0046 レビューは同じ破れを **pairing.ts の中だけ**で塞いだので、`apiCall` を直に叩く
 * 58 か所が裸のまま残っていた(armed-tests の型⑥ 呼び出し元しか見ない)。
 *
 * `code` を持ち越すのは、呼び手が既に code だけを読んでいるから(pairing.ts の catch)。
 * 持ち越さないと あちらの 1 行が `cannot connect to X (cannot connect to X (…))` に入れ子になる。
 */
export class ApiUnreachableError extends Error {
  readonly code: string | undefined;
  constructor(baseUrl: string, cause: unknown) {
    super(unreachableDetail(baseUrl, cause), { cause });
    this.name = "ApiUnreachableError";
    const c = (cause as { code?: unknown })?.code;
    this.code = typeof c === "string" ? c : undefined;
  }
}

/** 409 のうち **lease が本当に競合している** code。これ以外の 409 を「lease conflict」と呼ばない */
const LEASE_CONFLICT_CODES = new Set(["not_holder", "lease_expired", "stale_epoch", "primary_held", "lease_held"]);

/**
 * server の拒否 → 人の言葉。**訳はここ 1 箇所**（PBI-0765）—— CLI（`worksErr`）も MCP（`OpenRolyApiError`）も
 * これを呼ぶ。route ごとに status だけを見て訳していた頃は、同じ 409 に別の原因が同居して
 * 「lease は何も競合していないのに lease conflict」（dogfood F69）、5xx は `HTTP 500` とだけ出て
 * 「自分の credential が悪いのか server が死んでいるのか」が分からなかった（F59 / F60）。
 * 先頭の `NG ` は付けない（面が付ける）。404 は面ごとに指す物が違うので面が持つ
 */
export function explainApiError(status: number, body: unknown): string {
  const err = (body as { error?: unknown } | null)?.error;
  const code = typeof err === "string" ? err : (err as { code?: unknown } | undefined)?.code;
  const named = typeof code === "string" && code ? code : undefined;
  if (status >= 500)
    return `the account server failed (HTTP ${status}${named ? ` ${named}` : ""}) — server-side, not your credential. 'openroly doctor' says which`;
  if (named === "human_only" || named === "explicit_user_intent_required")
    return `${named}: only a person can do this — this terminal has an AI runtime credential. Run 'openroly login' first`;
  if (status === 409 && named && LEASE_CONFLICT_CODES.has(named)) return `lease conflict: ${named}`;
  return named ?? `HTTP ${status}`;
}

export async function apiCall<T = any>(
  baseUrl: string,
  path: string,
  init: { token?: string; method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResponse<T>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        // session scope(PBI-0117 → PBI-0320)。broker が dedicated / Manual / API provider の
        // 子 env に載せた token を、この process から出る全 request に付ける。**付けないと
        // agent 面の状態変更が 403 scope_required になる**(床は runtime actor に scope を要求する)。
        // env が無い普通の CLI 実行では header ごと出ない = 従来どおり。正本は packages/mcp と同じ形
        ...(process.env.OPENROLY_SESSION_SCOPE
          ? { "x-openroly-session-scope": process.env.OPENROLY_SESSION_SCOPE }
          : {}),
      },
      // 呼び手が待つ上限を持てるようにする(PBI-0234: 接続報告の whoami)。
      // 渡さなければ従来どおり無制限
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    throw new ApiUnreachableError(baseUrl, e);
  }
  const body = (await res.json().catch(() => null)) as T;
  return { status: res.status, body };
}
