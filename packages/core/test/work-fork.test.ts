// PBI-0440 / CAP-3 V8: fork / review の判定(decideFork)と profile の門(applyContextProfile)。
// route・DB は apps/server/test/work-fork.test.ts、端末側(fork folder・render・search)は packages/mcp/test/work-fork.test.ts。
import { describe, expect, test } from "bun:test";
import {
  applyContextProfile,
  CAPSULE_FIELDS,
  CONTEXT_PROFILES,
  decideFork,
  FORK_ROLES,
  WORK_CONTEXT_WELL_KNOWN_KEYS,
} from "../src/index.ts";

describe("decideFork(PBI-0440)", () => {
  test("role が門と profile を決める(implementer = fork_work / full・reviewer = start_review / reviewer_blind)", () => {
    expect(decideFork({ version: 3 }, "implementer")).toEqual({ ok: true, action: "fork_work", profile: "full" });
    expect(decideFork({ version: 3 }, "reviewer")).toEqual({ ok: true, action: "start_review", profile: "reviewer_blind" });
    expect(Object.keys(FORK_ROLES).sort()).toEqual(["implementer", "reviewer"]);
  });

  test("capsule が無ければ no_capsule・role が不正なら capsule の有無より先に invalid_role", () => {
    expect(decideFork(null, "reviewer")).toEqual({ ok: false, reason: "no_capsule" });
    for (const role of ["", "Reviewer", "owner", "toString", "__proto__", "constructor", null, 1, undefined]) {
      expect(decideFork({ version: 1 }, role)).toEqual({ ok: false, reason: "invalid_role" });
      expect(decideFork(null, role)).toEqual({ ok: false, reason: "invalid_role" });
    }
  });
});

describe("applyContextProfile(PBI-0440)", () => {
  const body = Object.fromEntries(CAPSULE_FIELDS.map((f) => [f, `value of ${f}`]));
  const row = (kind: string, key: string) => ({ kind, key, value_hash: "h", size: 1 });

  test("full は capsule も索引も素通し(hidden は空)", () => {
    expect(applyContextProfile("full", body)).toEqual({ kept: body, hidden: [] });
    const rows = [row("context", "decisions"), row("source", "a.ts"), row("context", "inbox/x/1")];
    expect(applyContextProfile("full", rows)).toEqual({ kept: rows, hidden: [] });
  });

  test("reviewer_blind の capsule: CAPSULE_FIELDS のうち allowlist の 4 つだけ・残りは名前だけ hidden(値はどこにも出ない)", () => {
    const r = applyContextProfile("reviewer_blind", body);
    expect(Object.keys(r.kept).sort()).toEqual(["capability_requirements", "git_state", "goal", "relevant_artifacts"]);
    // failed_attempts(PBI-0552 で 9 要素目)は allowlist に足していないので fail-closed で hidden 側に落ちる
    expect(r.hidden).toEqual(["current_state", "decisions", "failed_attempts", "relevant_memory", "unresolved_questions"]);
    const text = JSON.stringify(r);
    for (const f of r.hidden) expect(text).not.toContain(`value of ${f}`);
  });

  test("reviewer_blind の索引: well-known 6 key・auto/・inbox/・自由な key・source の全組み合わせ", () => {
    const keys = [...WORK_CONTEXT_WELL_KNOWN_KEYS, "auto/git", "auto/files_touched", "auto/tests", "auto/transcript", "inbox/wrk_a/1", "my_note"];
    const rows = [...keys.map((k) => row("context", k)), row("source", "src/a.ts")];
    const r = applyContextProfile("reviewer_blind", rows);
    expect(r.kept.map((e) => `${e.kind}:${e.key}`)).toEqual([
      "context:goal",
      "context:auto/git",
      "context:auto/files_touched",
      "context:auto/tests",
      "source:src/a.ts",
    ]);
    expect(r.hidden).toEqual(
      ["auto/transcript", "decisions", "failed_attempts", "inbox/wrk_a/1", "my_note", "next_step", "open_questions", "verified_findings"],
    );
  });

  test("allowlist なので、新しい field / key は既定で見せない(fail-closed)", () => {
    expect(applyContextProfile("reviewer_blind", { goal: "g", brand_new_field: "opinion" })).toEqual({
      kept: { goal: "g" },
      hidden: ["brand_new_field"],
    });
    expect(applyContextProfile("reviewer_blind", [row("context", "brand_new_key"), row("unknown_kind", "goal")]).kept).toEqual([]);
  });

  test("未知の profile は何も見せない(DB の check を抜けた値が来ても開かない)", () => {
    expect(applyContextProfile("__proto__", body).kept).toEqual({});
    expect(applyContextProfile("toString", [row("context", "goal"), row("source", "a.ts")]).kept).toEqual([]);
    expect(Object.keys(CONTEXT_PROFILES).sort()).toEqual(["full", "reviewer_blind"]);
  });
});
