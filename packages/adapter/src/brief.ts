import { apiCall } from "./api.ts";

// Session start behavior(要件 §19)。session 開始時に Mailbox 本文を自動注入せず、
// 小さい metadata だけを見せる。ここに本文を足さないこと —— token 消費・KV 肥大・
// prompt injection surface を増やさないための境界。

export interface SessionBrief {
  agent_id: string;
  handle: string;
  display_name: string;
  runtime_id?: string;
  unread: number;
  /** 未読の送信元内訳(名前と件数のみ) */
  senders: { name: string; count: number }[];
  /** 未知 sender からの未読(requests bucket) */
  requests: number;
}

export async function fetchBrief(baseUrl: string, token: string): Promise<SessionBrief> {
  const who = await apiCall(baseUrl, "/v1/whoami", { token });
  if (who.status !== 200) {
    throw new Error(`whoami failed: ${who.status} ${JSON.stringify(who.body)}`);
  }
  const inbox = await apiCall<any[]>(baseUrl, "/v1/inbox/messages", { token });
  return buildBrief(who.body, Array.isArray(inbox.body) ? inbox.body : []);
}

/** metadata のみから brief を組む(本文 key は入力に無く、出力にも作らない) */
export function buildBrief(whoami: any, messages: any[]): SessionBrief {
  const unreadMessages = messages.filter((m) => m?.read !== true);
  const counts = new Map<string, number>();
  for (const m of unreadMessages) {
    if (m?.bucket !== "inbox") continue;
    const name = String(m?.sender_display ?? "unknown");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    agent_id: whoami.agent_id,
    handle: whoami.handle,
    display_name: whoami.display_name,
    ...(whoami.actor?.runtime_id ? { runtime_id: whoami.actor.runtime_id } : {}),
    unread: Number(whoami.unread ?? 0),
    senders: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    requests: unreadMessages.filter((m) => m?.bucket === "requests").length,
  };
}

/**
 * 未読の合計。**この式はここ 1 箇所**（PBI-0765）—— `status` / `doctor` / MCP `whoami` は全部これを呼ぶ。
 * whoami.unread は inbox bucket だけなので requests を足す。面ごとに足していた頃は同じ食い違いが
 * status（F43）→ MCP whoami（F54）→ doctor（F58）と 1 面ずつ 3 回出た
 */
export function unreadTotal(brief: Pick<SessionBrief, "unread" | "requests">): number {
  return brief.unread + brief.requests;
}

/**
 * 要件 §19 の表示形（**未読の数と内訳だけ**）。
 *
 * **handle はここで出さない**（2026-09-11・PBI-0424）。`openroly status` は identity を
 * 見出しにして `@handle` を 1 度だけ自分で出し、この本体を字下げして並べる ——
 * runtime ごとに `Attached as @handle` を繰り返すと、**runtime が主語**の面になる
 * （`docs/positioning.md` §8 ⑥「Your runtime is not your agent. と言いたい製品が
 * runtime を主語にして喋っている」）。
 *
 * unread は whoami(inbox bucket・全期間)、senders は inbox/messages(直近 N 件の window)
 * から来る —— 母集団が違うので内訳の合計が unread に届かないことがある。
 * 黙って差を落とすと「Unread: 25 なのに内訳が 1 行も無い」という読めない brief になるので、
 * 差分を必ず 1 行にして見せる。
 */
export function formatBrief(brief: SessionBrief): string {
  const total = unreadTotal(brief);
  // dogfood F71: 件数だけ出して読む口を出さない行は、毎回 help を往復させる。**0 件の時は足さない**
  // （読む物が無い時に口を勧めない）
  const lines = [`Unread: ${total}${total > 0 ? " — 'openroly inbox'" : ""}`];
  for (const s of brief.senders) lines.push(`- ${s.name} ×${s.count}`);
  const shown = brief.senders.reduce((n, s) => n + s.count, 0);
  if (brief.unread > shown) lines.push(`- and ${brief.unread - shown} more`);
  if (brief.requests > 0) lines.push(`- (requests: ${brief.requests})`);
  return lines.join("\n");
}

/**
 * statusline(Claude Code の 1 行)用の segment(PBI-0130)。**件数だけ**を出す ——
 * 本文はもちろん sender 名も handle も出さない。要件 §19 の境界を CLI 面にも同じ形で当てる
 * (statusline は常時見えている面 = 画面共有・録画に写り込む面でもある)。
 *
 * cache に入るのはこの戻り値そのもの。bash 側(statusline.sh)は cat するだけで、
 * 組み立ての実装を 2 つに割らない。
 */
export function formatStatusline(brief: SessionBrief): string {
  const dim = (s: string) => `\u001b[38;5;244m${s}\u001b[0m`;
  const requests = brief.requests > 0 ? `+${brief.requests}` : "";
  // 未読 0 は「繋がっていて空」を静かに示す(消すと接続の有無が分からなくなる)
  if (brief.unread <= 0) return dim(`📭${requests}`);
  return `\u001b[38;5;214m📬${brief.unread}\u001b[0m${requests ? dim(requests) : ""}`;
}
