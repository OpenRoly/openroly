// PBI-0447 / 図80c ⑥: task の合流の判定 decideMerge。stderr は git 2.39.3 の `git apply --check` を一時 repo で打った実物(2026-09-13)。
// 端末の合流(folder・index.lock・apply)と route は packages/mcp/test/work-task-merge.test.ts
import { describe, expect, test } from "bun:test";
import { briefPaths, decideMerge, decideMergePaths, decideTaskMerge, taskReviewCell, taskReviewVerdict } from "../src/work.ts";

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

// PBI-0648 / 図80c ⑦: 証拠(passed の proof)と裁定(accept)が無ければ親へ合流しない
describe("decideTaskMerge", () => {
  const P = (...s: string[]) => s.map((status) => ({ status }));
  const V = (verdict: unknown) => ({ verdict, at: "2026-09-16T00:00:00.000Z" });
  const cases: [string, ReturnType<typeof P>, unknown, ReturnType<typeof decideTaskMerge>][] = [
    ["proof 0 件", [], V("accept"), { ok: false, reason: "no_proof" }],
    ["最後が failed", P("passed", "failed"), V("accept"), { ok: false, reason: "no_proof" }],
    ["最後が skipped", P("passed", "skipped"), V("accept"), { ok: false, reason: "no_proof" }],
    ["最後が unknown", P("unknown"), V("accept"), { ok: false, reason: "no_proof" }],
    ["直して passed を積み直せば通る", P("failed", "passed"), V("accept"), { ok: true }],
    ["裁定が無い", P("passed"), null, { ok: false, reason: "not_reviewed" }],
    ["裁定の本文が空", P("passed"), {}, { ok: false, reason: "not_reviewed" }],
    ["裁定が知らない値", P("passed"), V("approved"), { ok: false, reason: "not_reviewed" }],
    ["裁定が文字列そのもの(本文の形が違う)", P("passed"), "accept", { ok: false, reason: "not_reviewed" }],
    ["差し戻し", P("passed"), V("changes_requested"), { ok: false, reason: "changes_requested" }],
    ["却下", P("passed"), V("reject"), { ok: false, reason: "rejected" }],
    ["両方揃って初めて通る", P("passed"), V("accept"), { ok: true }],
  ];
  for (const [name, proofs, verdict, want] of cases) {
    test(name, () => expect(decideTaskMerge(proofs, verdict)).toEqual(want));
  }
  // 証拠が先に見られる —— 裁定だけ在っても通らない事を「順」でも 1 回押さえる
  test("proof が無ければ裁定を見る前に no_proof", () => {
    expect(decideTaskMerge([], V("changes_requested"))).toEqual({ ok: false, reason: "no_proof" });
  });
});

describe("taskReviewCell / taskReviewVerdict(面に出す 1 マス)", () => {
  test("未裁定は - ・1 周目は数を出さない・2 周目から数が付く", () => {
    expect(taskReviewCell(null, 0)).toBe("-");
    expect(taskReviewCell("accept", 1)).toBe("accept");
    expect(taskReviewCell("changes_requested", 2)).toBe("changes_requested (2)");
  });
  test("本文から読めない物は null(配列・null・verdict 以外の型)", () => {
    for (const body of [null, undefined, [{ verdict: "accept" }], { verdict: 1 }, { verdict: "accept " }]) {
      expect(taskReviewVerdict(body)).toBeNull();
    }
    expect(taskReviewVerdict({ verdict: "accept" })).toBe("accept");
  });
});

// PBI-0649 / 図80c ⑧: 持ち場の外の path が 1 本でも在れば合流しない。当たり方の規則は前方一致 1 つだけ
describe("decideMergePaths — 持ち場の門(AC-5)", () => {
  const cases: [string, string[], string[], ReturnType<typeof decideMergePaths>][] = [
    ["forbidden が空なら全部通る(brief を渡さない = 今まで通り)", ["migrations/053.sql", "a.ts"], [], { ok: true }],
    ["dir の前置きは中の file に当たる", ["migrations/053_x.sql", "a.ts"], ["migrations/"], { ok: false, hit: ["migrations/053_x.sql"] }],
    ["前置きの外は当たらない", ["web/a.ts"], ["migrations/"], { ok: true }],
    // 前方一致なので「兄弟の名前」にも当たる。門は広く断る側に倒れているのが正しい向き
    ["末尾が / でない前置きは似た名前にも当たる", ["server/src/authz.ts"], ["server/src/auth"], { ok: false, hit: ["server/src/authz.ts"] }],
    [
      "当たった path だけを重複なく並べて返す",
      ["b.ts", "migrations/2.sql", "migrations/1.sql", "migrations/1.sql"],
      ["migrations/", "docs/"],
      { ok: false, hit: ["migrations/1.sql", "migrations/2.sql"] },
    ],
    // glob は 1 つも当たらない —— だから briefPaths が書く時に落とす(下の test)。ここで「当たらない」事自体を 1 回見る
    ["glob は展開しない(`*.sql` は何にも当たらない)", ["migrations/1.sql"], ["*.sql"], { ok: true }],
    // module review 2026-09-16: 区別しない fs では `Migrations/` が `migrations/` の中に落ちる(実測で門を素通りした)
    ["大文字小文字は区別しない(`Migrations/` は `migrations/` の門に当たる)", ["Migrations/070.sql", "web/a.ts"], ["migrations/"], { ok: false, hit: ["Migrations/070.sql"] }],
    ["前置き側が大文字でも同じ", ["migrations/070.sql"], ["Migrations/"], { ok: false, hit: ["migrations/070.sql"] }],
  ];
  for (const [name, changed, forbidden, want] of cases) {
    test(name, () => expect(decideMergePaths(changed, forbidden)).toEqual(want));
  }
});

describe("briefPaths — 持ち場の本文を読む(読めない物は null = 呼び手は断る)", () => {
  test("repo 相対 path の列だけを通す", () => {
    expect(briefPaths([])).toEqual([]);
    expect(briefPaths(["migrations/", "server/src/auth"])).toEqual(["migrations/", "server/src/auth"]);
  });
  test("glob・絶対 path・..・空文字・配列でない物は null(黙って「全部許す」にしない)", () => {
    for (const bad of [
      ["*.sql"], ["docs/?.md"], ["a[0].ts"], ["/etc/passwd"], ["../outside"], ["a/../b"], [""], ["ok.ts", "*.sql"],
      "migrations/", { paths: ["migrations/"] }, null, undefined, [1], ["a\\b"],
    ]) {
      expect({ bad, paths: briefPaths(bad) }).toEqual({ bad, paths: null });
    }
  });
});
