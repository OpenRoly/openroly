// PBI-0447 / 図80c ⑥: task の合流の判定 decideMerge。stderr は git 2.39.3 の `git apply --check` を一時 repo で打った実物(2026-09-13)。
// 端末の合流(folder・index.lock・apply)と route は packages/mcp/test/work-task-merge.test.ts
import { describe, expect, test } from "bun:test";
import { decideMerge } from "../src/work.ts";

const SAME_LINE = "error: patch failed: src/a.ts:1\nerror: src/a.ts: patch does not apply\n";
const EXISTS = "error: src/new.ts: already exists in working directory\n";

describe("decideMerge", () => {
  test("順は empty → busy → applied → conflict", () => {
    expect(decideMerge({ changed: [], busy: true, checkError: SAME_LINE })).toEqual({ result: "empty" });
    expect(decideMerge({ changed: ["src/a.ts"], busy: true, checkError: SAME_LINE })).toEqual({ result: "busy" });
    expect(decideMerge({ changed: ["src/a.ts", "src/new.ts"], busy: false, checkError: null })).toEqual({
      result: "applied",
      paths: ["src/a.ts", "src/new.ts"],
    });
  });

  test("conflict の path は git が名指した path だけ(patch failed の行は数えない・重複しない・並べる)", () => {
    expect(decideMerge({ changed: ["src/a.ts", "src/b.ts", "src/new.ts"], busy: false, checkError: EXISTS + SAME_LINE })).toEqual({
      result: "conflict",
      paths: ["src/a.ts", "src/new.ts"],
    });
  });

  test("名指しが拾えない stderr でも applied にせず、変わった path 全部を conflict で返す", () => {
    for (const checkError of ["", "fatal: unrecognized input\n"]) {
      expect(decideMerge({ changed: ["src/a.ts", "src/b.ts"], busy: false, checkError })).toEqual({
        result: "conflict",
        paths: ["src/a.ts", "src/b.ts"],
      });
    }
  });
});
