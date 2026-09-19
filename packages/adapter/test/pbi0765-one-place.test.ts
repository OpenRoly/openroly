import { describe, expect, test } from "bun:test";
import { buildBrief, explainApiError, formatBrief, unreadTotal } from "../src/index.ts";

// PBI-0765: 同じ事実を面ごとに計算しない。未読の合計と、server の拒否の訳は adapter の 1 関数。
// doctor の面は install.test.ts、MCP whoami の面は packages/mcp の test が同じ関数の値を見る

describe("PBI-0765 AC-1: 未読の合計は unreadTotal", () => {
  const brief = buildBrief({ agent_id: "agt_x", handle: "aya", display_name: "Aya", unread: 2 }, [
    { id: "m1", sender_display: "A", bucket: "inbox", read: false },
    { id: "m2", sender_display: "A", bucket: "inbox", read: false },
    { id: "m3", sender_display: "B", bucket: "requests", read: false },
  ]);
  test("inbox 2 + requests 1 = 3。status の 1 行目も同じ数字", () => {
    expect(unreadTotal(brief)).toBe(3);
    expect(formatBrief(brief).split("\n")[0]).toContain("Unread: 3");
  });
});

describe("PBI-0765 AC-2: server の拒否 → 人の言葉は explainApiError", () => {
  test("5xx は server 側と言い、credential のせいにしない（F59 / F60）", () => {
    const out = explainApiError(500, { error: "internal" });
    expect(out).toContain("server-side");
    expect(out).toContain("HTTP 500");
  });
  test("409 でも lease の code でなければ lease conflict と呼ばない（F69）", () => {
    expect(explainApiError(409, { error: { code: "explicit_user_intent_required" } })).not.toContain("lease conflict");
    expect(explainApiError(409, { error: { code: "explicit_user_intent_required" } })).toContain("openroly login");
    expect(explainApiError(409, { error: { code: "already_promoted" } })).toBe("already_promoted");
  });
  test("lease が本当に競合している 409 は lease conflict", () => {
    expect(explainApiError(409, { error: { code: "stale_epoch" } })).toBe("lease conflict: stale_epoch");
  });
  test("code が無ければ status だけ", () => {
    expect(explainApiError(418, null)).toBe("HTTP 418");
  });
});
