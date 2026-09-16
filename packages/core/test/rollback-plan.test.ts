import { describe, expect, test } from "bun:test";
import { planRollback, type GitState } from "../src/git-checkpoint.ts";

// PBI-0550: rollback の判定(純関数)。git の操作と CLI の面は apps/cli/test/work-rollback.test.ts

const BASE = "a".repeat(40);
const OTHER = "b".repeat(40);
const state = (over: Partial<GitState> = {}): GitState => ({ baseCommit: BASE, dirty: 0, ...over });

describe("planRollback(PBI-0550)", () => {
  test("同じ base・固めきれない物が無い → ok(dirty でも ok)", () => {
    const current = state({ dirty: 2, trackedPatch: "c".repeat(40), untrackedFiles: [{ path: "u.txt", mode: "100644" }], hashes: ["d".repeat(40)], omitted: [] });
    expect(planRollback({ current, target: state(), clobbered: [] })).toEqual({ kind: "ok" });
  });

  test("git の外 / 版に git_state が無い / commit の無い repo → no_git_state", () => {
    expect(planRollback({ current: null, target: state(), clobbered: [] })).toEqual({ kind: "no_git_state" });
    expect(planRollback({ current: state(), target: null, clobbered: [] })).toEqual({ kind: "no_git_state" });
    // 両方 null の baseCommit は「一致」ではない —— read-tree で戻す起点の HEAD が無い
    expect(planRollback({ current: state({ baseCommit: null }), target: state({ baseCommit: null }), clobbered: [] })).toEqual({
      kind: "no_git_state",
    });
  });

  test("HEAD ≠ 版の baseCommit → base_mismatch(両方の sha を返す)", () => {
    expect(planRollback({ current: state({ baseCommit: OTHER }), target: state(), clobbered: [] })).toEqual({
      kind: "base_mismatch",
      head: OTHER,
      base: BASE,
    });
  });

  test("omitted と clobbered → would_lose(両方の path を名指し)", () => {
    const current = state({ dirty: 1, untrackedFiles: [], hashes: [], omitted: [{ path: "big.bin", reason: "too_large" }] });
    expect(planRollback({ current, target: state(), clobbered: [] })).toEqual({ kind: "would_lose", paths: ["big.bin"] });
    expect(planRollback({ current: state(), target: state(), clobbered: [".env"] })).toEqual({ kind: "would_lose", paths: [".env"] });
    expect(planRollback({ current, target: state(), clobbered: [".env"] })).toEqual({ kind: "would_lose", paths: ["big.bin", ".env"] });
  });

  test("base_mismatch は would_lose より先(どちらでも 1 file も触らないが、先に直すのは HEAD)", () => {
    const current = state({ baseCommit: OTHER, omitted: [{ path: "big.bin", reason: "too_many" }] });
    expect(planRollback({ current, target: state(), clobbered: [] }).kind).toBe("base_mismatch");
  });
});
