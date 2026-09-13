import {
  apiCall,
  credentialRejectedHint,
  e2eeCallFor,
  getCredential,
  openIfEnvelope,
  sealForHandle,
  type E2eeCall,
} from "@openroly/adapter";
import {
  API_PROVIDERS,
  apiProvider,
  apiProviderKind,
  connectionTokenEnvName,
  isCustomProviderId,
  type MessageContent,
} from "@openroly/core";

// `openroly agent <provider>` —— 外部 API provider を「端末で動く runtime」として扱う本体
// (EP-0009 B / PBI-0057)。E2EE(アーキ §9)により server は本文を復号できないので、
// provider API を呼べるのは device key を持つ端末側だけ。ここは **1 turn の下書き** に
// 徹する: tool 実行・自律 loop・streaming は持たない(要件 §35 Model router にしない)。
//
// 経路: runtime credential で thread を読む → device key で復号 → Connections の API key を
// resolve(初回は Connection-scoped ASK を通る) → OpenAI 互換 /chat/completions を 1 回 →
// 返信は POST /v1/threads/:id/reply = decideSend の READ/ASK/AUTO を runtime actor として通る。

/** provider ごとの接続先は **`@openroly/core` の `API_PROVIDERS` 表**(PBI-0210 で 1 箇所に)。
 * **model 名は cutoff 後に変わる**ので `--model` / OPENROLY_AGENT_MODEL で上書きできる */
export type AgentProvider = string;
export const AGENT_PROVIDERS: readonly string[] = API_PROVIDERS.map((p) => p.id);
/** 持ち込みの endpoint(PBI-0276)は表に載らない —— 接続先と model は `/resolve` が鍵と一緒に返す */
export const isAgentProvider = (p: string): p is AgentProvider =>
  apiProvider(p) !== undefined || isCustomProviderId(p);

/** credential store / device key store の単位。claude / codex と同じ 1 kind = 1 runtime_id */
export const agentKind = (provider: AgentProvider): string => apiProviderKind(provider);

const SYSTEM_PROMPT =
  "You act on behalf of this account. Write exactly one draft reply to the message you received. " +
  "Return only the body — no preamble, no signature, and do not repeat the salutation.";

export interface AgentOptions {
  provider: AgentProvider;
  threadId: string;
  model?: string;
  /** connection 承認を待つ上限秒。0 で待たない */
  waitSec?: number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface AgentResult {
  status: "sent" | "ask_approval_required" | "denied" | "already_handled" | "failed";
  detail?: string;
  approvalId?: string;
}

interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  content: MessageContent;
}

const APPROVAL_POLL_INTERVAL_MS = 2_000;

/**
 * Connections から API key を取り出す。初回は Connection-scoped ASK(PBI-0055)が入るので
 * 202 pending_approval を受け取り、human が承認するまで `approval_get` を polling する。
 * **key は返り値としてだけ扱い、ファイルにも log にも書かない**(要件 §40.3)。
 */
export async function resolveApiKey(
  baseUrl: string,
  token: string,
  provider: AgentProvider,
  waitSec: number,
  log: (line: string) => void,
): Promise<
  { ok: true; key: string; endpoint?: { baseUrl: string; model: string } } | { ok: false; detail: string }
> {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const res = await apiCall(baseUrl, `/v1/connections/${provider}/resolve`, {
      token,
      method: "POST",
    });
    if (res.status === 200) {
      const key = res.body?.env?.[connectionTokenEnvName(provider)];
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false, detail: "connection_resolve_empty" };
      }
      // 持ち込みの endpoint は接続先も一緒に返る(表を引けないので行が正本)
      const url = res.body?.base_url;
      const model = res.body?.model;
      return typeof url === "string" && typeof model === "string"
        ? { ok: true, key, endpoint: { baseUrl: url, model } }
        : { ok: true, key };
    }
    if (res.status === 202) {
      if (waitSec <= 0) {
        return { ok: false, detail: `waiting for approval (approval_id=${res.body?.approval_id})` };
      }
      log(`Using the ${provider} API key needs approval. Waiting for approval...`);
      const approvalId = res.body?.approval_id as string | undefined;
      // 承認されると次の resolve が 200 を返す(approved 行を消費する)ので、
      // ここでは approval の状態だけを見て「待つのをやめる条件」を判定する
      for (;;) {
        if (Date.now() > deadline) return { ok: false, detail: "timed out waiting for approval" };
        await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS));
        if (!approvalId) break;
        const st = await apiCall(baseUrl, `/v1/approvals/${approvalId}`, { token });
        if (st.status !== 200) break;
        if (st.body?.status === "approved") break;
        if (st.body?.status === "rejected") return { ok: false, detail: "approval was rejected" };
      }
      continue;
    }
    if (res.status === 403) return { ok: false, detail: "connection_use_denied" };
    return { ok: false, detail: `connection_unavailable(${res.status})` };
  }
}

/** provider の応答本文は表に出さない —— key を echo する API があるため status だけを見せる */
async function draftReply(
  provider: AgentProvider,
  apiKey: string,
  model: string,
  baseUrl: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      }),
    });
  } catch (e) {
    return { ok: false, detail: `provider_unreachable(${(e as Error).name})` };
  }
  if (!res.ok) return { ok: false, detail: `provider_error(${res.status})` };
  const body = (await res.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null;
  const text = body?.choices?.[0]?.message?.content ?? "";
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, detail: "empty_draft" };
  }
  return { ok: true, text };
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const kind = agentKind(opts.provider);
  const credential = await getCredential(kind, env);
  if (!credential) {
    return {
      status: "failed",
      detail: `${opts.provider} is not connected. Run 'openroly login' to connect this machine`,
    };
  }
  const { base_url: baseUrl, token } = credential;
  // E2eeCall の契約(PBI-0259 / PBI-0253): 非 2xx は `status` と応答 `body` を持つ error。
  // resolveSealTargets は 404 だけを「宛先がまだ account 鍵を持たない = 平文」と読み、それ以外は
  // この error をそのまま投げ直す。`body` は同じ status の理由を分ける為に要る(409 device_revoked)。
  // 作り方は adapter の 1 箇所(pairing の後の名乗り直しと同じ物)
  const call: E2eeCall = e2eeCallFor(baseUrl, token, kind);

  const threadRes = await apiCall(baseUrl, `/v1/threads/${opts.threadId}`, { token });
  // 401 = credential が失効(人が Revoke を押した・PBI-0264 は token ごと落とす)。戻り道を名乗って終わる
  if (threadRes.status === 401) return { status: "failed", detail: credentialRejectedHint(kind) };
  if (threadRes.status !== 200) {
    return { status: "failed", detail: `could not read the thread (${threadRes.status})` };
  }
  const peerHandle = threadRes.body?.peer_handle as string | null;
  const messages = (threadRes.body?.messages ?? []) as ThreadMessage[];

  // 復号できない message は履歴から落とす(平文を作らない・provider にも渡さない)
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const opened = await openIfEnvelope(kind, m, call);
    const text = (opened.content as MessageContent).text;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    history.push({ role: m.direction === "in" ? "user" : "assistant", content: text });
  }
  if (history.length === 0) {
    return { status: "failed", detail: "no message body this device can read" };
  }

  const table = apiProvider(opts.provider);
  // 持ち込みの endpoint(PBI-0276)は表に無い。接続先と model は resolve の応答が持つ
  if (!table && !isCustomProviderId(opts.provider)) {
    return { status: "failed", detail: `unknown provider ${opts.provider}` };
  }
  // `auth: "none"`(Ollama / LM Studio / Jan の local 口)は Connections を持たない = 鍵解決を飛ばす。
  // 鍵 "" は Authorization を付けない(local 口は header を見ない)
  const key = table?.auth === "none"
    ? ({ ok: true, key: "" } as const)
    : await resolveApiKey(baseUrl, token, opts.provider, opts.waitSec ?? 300, log);
  if (!key.ok) return { status: "failed", detail: key.detail };

  const endpoint = "endpoint" in key ? key.endpoint : undefined;
  const resolvedBaseUrl = endpoint?.baseUrl ?? table?.baseUrl;
  // 持ち込みなのに接続先が返らなかった = 行が壊れている。表の URL に落とすと**別の provider へ
  // 鍵を投げる**ので、名乗って止める
  if (!resolvedBaseUrl) return { status: "failed", detail: "connection_endpoint_missing" };
  const providerBaseUrl = env.OPENROLY_AGENT_BASE_URL ?? resolvedBaseUrl;
  const model = opts.model ?? env.OPENROLY_AGENT_MODEL ?? endpoint?.model ?? table?.defaultModel;
  if (!model) return { status: "failed", detail: "connection_endpoint_missing" };
  const draft = await draftReply(opts.provider, key.key, model, providerBaseUrl, history);
  if (!draft.ok) return { status: "failed", detail: draft.detail };

  // seal は @openroly/adapter の e2ee(MCP tools と同じ経路)。相手に account 鍵が無い時だけ平文。
  // 封をできない時は **平文で送らずに止める**(PBI-0254 AC-X1) —— 自分の account 鍵が引けない
  // ままの送信は「送った本人だけが永久に読めない 1 通」になる。無人で動く agent なので生の stack trace では
  // なく理由を名乗って終わる(PBI-0253 AC-X1: revoke された device は `openroly pair <kind>` で鍵を作り直す —— `openroly login` は device 鍵に触らない)。
  let content: MessageContent;
  try {
    content = peerHandle
      ? await sealForHandle(call, kind, peerHandle, { text: draft.text })
      : { text: draft.text };
  } catch (e) {
    return { status: "failed", detail: `could not encrypt the reply — ${e instanceof Error ? e.message : String(e)}` };
  }
  const reply = await apiCall(baseUrl, `/v1/threads/${opts.threadId}/reply`, {
    token,
    method: "POST",
    body: content,
  });
  if (reply.status === 403) {
    return { status: "denied", detail: reply.body?.reason ?? "delegation_denied" };
  }
  if (reply.status === 409) return { status: "already_handled" };
  if (reply.status !== 202 && reply.status !== 200) {
    return { status: "failed", detail: `reply failed (${reply.status})` };
  }
  if (reply.body?.status === "ask_approval_required") {
    return { status: "ask_approval_required", approvalId: reply.body?.approval_id };
  }
  return { status: "sent" };
}
