import { describe, expect, test } from "bun:test";
import { stallOf, type StallEventInput } from "../src/work.ts";

// PBI-0557: usage-limit resume の判定の正本(stallOf)。event 列(古い順)の末尾だけを見る ——
// diagnostic の後に event が 1 つでも積まれていたら再開済み。AC-1 の冪等(二度積まない)と
// 同じ条件を、書き込む側(CLI)がこの関数で判断できる。

const T0 = new Date("2026-09-14T09:00:00Z");
const T1 = new Date("2026-09-14T09:01:00Z");

const e = (kind: string, payload: Record<string, unknown> | null, createdAt: Date): StallEventInput => ({
  kind,
  payload,
  createdAt,
});

const stalled = (at: Date, over: Record<string, unknown> = {}) =>
  e("diagnostic", { code: "orphaned_session", reason: "usage_limit", runtime: "claude", ...over }, at);

describe("stallOf(PBI-0557)", () => {
  test("末尾が usage_limit の diagnostic: まだ止まっている", () => {
    expect(stallOf([e("claimed", null, T0), stalled(T1)])).toEqual({
      reason: "usage_limit",
      at: T1,
      runtime: "claude",
      resetsAt: null,
    });
  });

  test("resets_at が ISO 文字列で載っていれば Date で返す", () => {
    const resets = "2026-09-14T10:00:00Z";
    expect(stallOf([stalled(T1, { resets_at: resets })])?.resetsAt).toEqual(new Date(resets));
  });

  test("diagnostic の後に event が 1 つでも積まれていたら再開済み(null)", () => {
    expect(stallOf([stalled(T0), e("proof_added", { status: "passed" }, T1)])).toBeNull();
  });

  test("diagnostic が途中に在るだけ(末尾ではない)のは過去の止まり: null", () => {
    expect(stallOf([stalled(T0), e("comment_added", { body: "resumed" }, T1)])).toBeNull();
  });

  test("reason が違う diagnostic は usage_limit の止まりではない: null", () => {
    expect(stallOf([e("diagnostic", { code: "orphaned_session", reason: "other" }, T0)])).toBeNull();
  });

  test("code だけの diagnostic(workboard 由来・reason 無し)も null", () => {
    expect(stallOf([e("diagnostic", { code: "running_without_heartbeat" }, T0)])).toBeNull();
  });

  test("event が空 / 末尾が diagnostic 以外: null", () => {
    expect(stallOf([])).toBeNull();
    expect(stallOf([e("claimed", null, T0)])).toBeNull();
  });

  test("runtime が載っていなければ null(runtime 判別が要る呼び手の為の型)", () => {
    expect(stallOf([stalled(T0, { runtime: undefined })])?.runtime).toBeNull();
  });
});
