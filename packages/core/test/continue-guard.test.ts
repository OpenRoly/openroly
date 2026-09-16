// PBI-0583 / CAP-3: continue guard の判定(sessionCut)。受け取った session が tool の直後に途切れた時だけ true。
import { describe, expect, test } from "bun:test";
import { SESSION_CUT_FALLBACK_MS, sessionCut, type SessionEndInput } from "../src/work.ts";

/** AC-1 の形: continue で受け取った R2 が lease を持ったまま、最後の part が read(tool)で exit 0 */
const cutEnd: SessionEndInput = {
  runId: "R2",
  holderRun: "R2",
  workStatus: "in_progress",
  proofPassed: false,
  lastPart: "tool",
  error: null,
  reason: null,
  durationMs: 5 * 60_000,
};

describe("sessionCut(PBI-0583)", () => {
  test("AC-1: lease を持ったまま最後が tool で終わった = 途切れ", () => {
    expect(sessionCut(cutEnd)).toBe(true);
  });

  test("AC-3: 最後が text で passed の proof を出した = 途切れではない / text だけでも途切れではない(③)", () => {
    expect(sessionCut({ ...cutEnd, lastPart: "text", proofPassed: true })).toBe(false);
    expect(sessionCut({ ...cutEnd, lastPart: "text" })).toBe(false);
    // ② だけでも落ちる: tool で終わっても passed の proof が在れば済んでいる
    expect(sessionCut({ ...cutEnd, proofPassed: true })).toBe(false);
    expect(sessionCut({ ...cutEnd, workStatus: "done" })).toBe(false);
  });

  test("AC-X1: 別の run が lease を持っている / accept する前に終わった = 途切れではない(①)", () => {
    expect(sessionCut({ ...cutEnd, holderRun: "R-human" })).toBe(false);
    expect(sessionCut({ ...cutEnd, holderRun: null })).toBe(false);
    expect(sessionCut({ ...cutEnd, runId: null, holderRun: null })).toBe(false);
  });

  test("③ error が在れば最後の part に依らず途切れ", () => {
    expect(sessionCut({ ...cutEnd, lastPart: "text", error: "Internal server error" })).toBe(true);
    expect(sessionCut({ ...cutEnd, lastPart: null, error: "429" })).toBe(true);
  });

  test("外から止めた session(人 / server の cancel・tool 上限の kill)は途切れではない", () => {
    expect(sessionCut({ ...cutEnd, reason: "cancelled" })).toBe(false);
    expect(sessionCut({ ...cutEnd, reason: "tool_cap" })).toBe(false);
  });

  test("終わり方が読めない session は proof 無しで 60 秒より早く終わった時だけ途切れ", () => {
    const unread = { ...cutEnd, lastPart: null };
    expect(sessionCut({ ...unread, durationMs: SESSION_CUT_FALLBACK_MS - 1 })).toBe(true);
    expect(sessionCut({ ...unread, durationMs: SESSION_CUT_FALLBACK_MS })).toBe(false);
  });
});
