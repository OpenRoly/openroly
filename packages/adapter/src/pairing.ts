import { apiCall } from "./api.ts";
import { saveCredential, type RuntimeCredential } from "./credentials.ts";

// device code flow(要件 §15.2 / 図 6)。runtime は user_code と URL を人に見せ、
// 承認されるまで interval 秒間隔で claim を polling する。
// claim は生 token を 1 回しか返さないため、credential を書き終えてから成功を返す。
//
// polling は「人が承認画面を操作している 10 分間」ずっと走る。その間の一過性の失敗
// (server の 5xx、前段 proxy の HTML 502、瞬断)で pairing を畳まないこと。
// 畳んだ結果を "expired" と呼ぶと、人には「期限切れ」と嘘を伝えることになる。

export interface PairPrompt {
  /** 人が **端末の画面から読んで打つ** 文字列(PBI-0237 AC-2)。URL には載らない */
  user_code: string;
  /** 打ちに行く先(`<web>/connect`)。**code を含まない定数 path** */
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// `verification_uri_complete`(RFC 8628 §3.3.1 の任意項目)は **持たない**(PBI-0237)。
// 「開くだけで承認画面に code 入りで着く URL」は、送りつけるだけで成立する remote phishing
// (§5.4)の運び屋そのもので、server も返さなくなった。人に渡せるのは code の文字列だけにする。

export interface PairOptions {
  baseUrl: string;
  /** credential store の key（= adapter id） */
  kind: string;
  /** §32.4 の表示名。例: "MacBook / Claude Code" */
  name: string;
  onPrompt: (prompt: PairPrompt) => void;
  /** test から時間を潰すための注入点 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

export type PairOutcome =
  | { status: "paired"; credential: RuntimeCredential; polls: number }
  | { status: "denied" }
  | { status: "expired" }
  /** 期限切れでも拒否でもない —— server に届かない / 応答が約束の形をしていない */
  | { status: "failed"; detail: string };

/** 一過性の失敗をこの回数連続したら諦める(人を無言で待たせ続けないため) */
const MAX_CONSECUTIVE_TRANSIENT = 5;
/** 一過性の失敗時に interval を伸ばす上限(ms) */
const MAX_BACKOFF_MS = 30_000;
/** pair/start の撃ち直し間隔の初期値(ms)。0.5 → 1 → 2 → 4 秒、5 回目で諦める(合計 7.5 秒) */
const START_BACKOFF_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Poll =
  | { kind: "body"; body: any }
  /** retry する価値のある失敗(瞬断・5xx・429) */
  | { kind: "transient"; detail: string }
  /** retry しても直らない失敗(4xx・約束外の応答) */
  | { kind: "fatal"; detail: string };

/**
 * fetch が reject した時の 1 行。生の message(Bun: "Unable to connect. Is the computer able to
 * access the url?")は人向けの説明として長く、stack trace と見分けが付かないので、
 * error code(`ConnectionRefused` / `ECONNREFUSED` 等)が有ればそれだけを添える
 */
function unreachableDetail(baseUrl: string, e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const why = typeof code === "string" && code ? code : (e as Error)?.message ?? String(e);
  return `cannot connect to ${baseUrl} (${why})`;
}

/**
 * pair/start。claim と同じ一過性判定で最大 MAX_CONSECUTIVE_TRANSIENT 回まで撃ち直す —— 1 回目の
 * fetch が reject しただけで例外を上げると、`atn login` は NG 表示ではなく生の stack trace で
 * 落ちる(PBI-0046 レビュー AC-X2)。server 指定の interval はまだ無いので固定の指数 backoff
 */
async function startPairing(
  options: PairOptions,
  sleep: (ms: number) => Promise<void>,
): Promise<{ kind: "body"; body: any } | { kind: "failed"; detail: string }> {
  let transient = 0;
  for (;;) {
    let detail: string;
    try {
      const res = await apiCall(options.baseUrl, "/v1/pair/start", {
        body: { name: options.name, kind: options.kind },
      });
      if (res.status === 201 && res.body != null && typeof res.body === "object") {
        return { kind: "body", body: res.body };
      }
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        detail = `pair/start returned ${res.status}`;
      } else if (res.status === 201) {
        detail = "pair/start did not return JSON";
      } else {
        return {
          kind: "failed",
          detail: `pair/start returned ${res.status}: ${JSON.stringify(res.body)}`,
        };
      }
    } catch (e) {
      detail = unreachableDetail(options.baseUrl, e);
    }
    transient++;
    if (transient >= MAX_CONSECUTIVE_TRANSIENT) {
      return { kind: "failed", detail: `${detail} (${transient} times in a row)` };
    }
    await sleep(Math.min(START_BACKOFF_MS * 2 ** (transient - 1), MAX_BACKOFF_MS));
  }
}

async function pollClaim(baseUrl: string, deviceCode: string): Promise<Poll> {
  let res;
  try {
    res = await apiCall(baseUrl, "/v1/pair/claim", { body: { device_code: deviceCode } });
  } catch (e) {
    return { kind: "transient", detail: unreachableDetail(baseUrl, e) };
  }
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    return { kind: "transient", detail: `pair/claim returned ${res.status}` };
  }
  if (res.status !== 200) {
    return {
      kind: "fatal",
      detail: `pair/claim returned ${res.status}: ${JSON.stringify(res.body)}`,
    };
  }
  // 200 でも本文が JSON として読めなければ(proxy が差し込んだ HTML 等)約束外
  if (res.body == null || typeof res.body !== "object") {
    return { kind: "transient", detail: "pair/claim did not return JSON" };
  }
  return { kind: "body", body: res.body };
}

export async function pairRuntime(options: PairOptions): Promise<PairOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = await startPairing(options, sleep);
  if (started.kind === "failed") return { status: "failed", detail: started.detail };
  const start = { body: started.body };
  const prompt: PairPrompt = {
    user_code: start.body.user_code,
    verification_uri: start.body.verification_uri,
    expires_in: start.body.expires_in,
    interval: start.body.interval ?? 2,
  };
  options.onPrompt(prompt);

  const deadline = now() + prompt.expires_in * 1000;
  let polls = 0;
  let transient = 0;
  let lastTransient = "";

  for (;;) {
    // 1 回目は interval を待たずに撃つ(承認済みの状態から始まる再 install が即座に通る)
    polls++;
    const poll = await pollClaim(options.baseUrl, start.body.device_code);

    if (poll.kind === "fatal") return { status: "failed", detail: poll.detail };

    if (poll.kind === "transient") {
      transient++;
      lastTransient = poll.detail;
      if (transient >= MAX_CONSECUTIVE_TRANSIENT) {
        return {
          status: "failed",
          detail: `${poll.detail} (${transient} times in a row)`,
        };
      }
    } else {
      transient = 0;
      const status = poll.body.status;
      if (status === "denied") return { status: "denied" };
      if (status === "expired") return { status: "expired" };
      if (status === "approved") {
        const credential: RuntimeCredential = {
          runtime_id: poll.body.runtime_id,
          token: poll.body.token,
          base_url: options.baseUrl.replace(/\/$/, ""),
          name: options.name,
          paired_at: new Date(now()).toISOString(),
        };
        // 保存してから成功を返す(claim は 1 回きり。書く前に落ちると再 pair が必要になる)
        await saveCredential(options.kind, credential, options.env ?? process.env);
        return { status: "paired", credential, polls };
      }
      if (status !== "pending") {
        return {
          status: "failed",
          detail: `pair/claim returned an unknown status: ${JSON.stringify(status)}`,
        };
      }
    }

    if (now() >= deadline) {
      return transient > 0
        ? { status: "failed", detail: `${lastTransient} (did not recover within the approval window)` }
        : { status: "expired" };
    }
    // 一過性の失敗が続く間だけ間隔を伸ばす。正常な polling は interval を守る(§ server 指定)
    const backoff = Math.min(prompt.interval * 1000 * 2 ** transient, MAX_BACKOFF_MS);
    await sleep(transient > 0 ? backoff : prompt.interval * 1000);
  }
}
