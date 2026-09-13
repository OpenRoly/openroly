// PBI-0433: Work Project context の壁(core・DB 無し)。key の文字種 / source path / 索引の形 / value の壁。
import { describe, expect, test } from "bun:test";
import { CapsuleCredentialRefError, hashCapsuleBody } from "../src/capsule.ts";
import {
  findReservedContextKeys,
  summarizeContextIndex,
  WORK_CONTEXT_WELL_KNOWN_KEYS,
  buildContextValue,
  ContextValueError,
  validateContextEntries,
  validateContextKey,
  WORK_CONTEXT_BATCH_MAX,
  WORK_CONTEXT_KEY_MAX,
  WORK_SOURCE_PATH_MAX,
} from "../src/work-context.ts";

const H = "a".repeat(64);

describe("validateContextKey — context key は短い label", () => {
  test("手描きの A〜G や decision / api.version / notes:auth は通る", () => {
    for (const k of ["A", "G", "decision", "api.version", "notes:auth", "area/sub-key_1"]) {
      expect(validateContextKey("context", k)).toEqual({ ok: true });
    }
  });

  test("空・空白・先頭記号・`..`・長すぎは invalid_key", () => {
    for (const k of ["", "a b", "-lead", ".dot", "a..b", "x".repeat(WORK_CONTEXT_KEY_MAX + 1), 42, null]) {
      expect(validateContextKey("context", k)).toEqual({ ok: false, reason: "invalid_key" });
    }
  });

  test("会話の名前の key は大文字小文字を問わず conversation_key", () => {
    for (const k of ["conversation", "Messages", "TRANSCRIPT"]) {
      expect(validateContextKey("context", k)).toEqual({ ok: false, reason: "conversation_key" });
    }
  });
});

describe("validateContextKey — source は repo の中の相対 path", () => {
  test("docs/plan.md / README.md / a,b.md は通る", () => {
    for (const p of ["docs/plan.md", "README.md", "notes/a,b.md"]) {
      expect(validateContextKey("source", p)).toEqual({ ok: true });
    }
  });

  test("../ / 絶対 / backslash / drive / 空 segment / . / NUL / 長すぎは invalid_source_path", () => {
    for (const p of ["../x.md", "a/../../x", "/etc/passwd", "a\\b.md", "C:/x.md", "a//b.md", "./a.md", `a/${String.fromCharCode(0)}.md`, "x".repeat(WORK_SOURCE_PATH_MAX + 1), ""]) {
      expect(validateContextKey("source", p)).toEqual({ ok: false, reason: "invalid_source_path" });
    }
  });
});

describe("validateContextEntries — server が受ける索引の形", () => {
  const e = (over: Record<string, unknown> = {}) => ({ kind: "context", key: "A", value_hash: H, size: 3, ...over });

  test("正しい索引はそのまま返る(expected_version も運ぶ)", () => {
    expect(validateContextEntries([e(), e({ key: "B", expected_version: 0 }), e({ kind: "source", key: "docs/plan.md" })])).toEqual({
      ok: true,
      entries: [
        { kind: "context", key: "A", value_hash: H, size: 3 },
        { kind: "context", key: "B", value_hash: H, size: 3, expected_version: 0 },
        { kind: "source", key: "docs/plan.md", value_hash: H, size: 3 },
      ],
    });
  });

  test("AC-X2: `value` を運ぶ entry は invalid_field(黙って落とさない)", () => {
    expect(validateContextEntries([e({ value: "SECRET" })])).toEqual({ ok: false, reason: "invalid_field" });
  });

  test("空 / 配列でない / 上限超え", () => {
    expect(validateContextEntries([])).toEqual({ ok: false, reason: "invalid_entries" });
    expect(validateContextEntries({ A: 1 })).toEqual({ ok: false, reason: "invalid_entries" });
    const many = Array.from({ length: WORK_CONTEXT_BATCH_MAX + 1 }, (_, i) => e({ key: `k${i}` }));
    expect(validateContextEntries(many)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  test("kind / hash / size / expected_version / 重複 key を名指しで落とす", () => {
    expect(validateContextEntries([e({ kind: "memory" })])).toEqual({ ok: false, reason: "invalid_kind" });
    expect(validateContextEntries([e({ value_hash: "../../etc" })])).toEqual({ ok: false, reason: "invalid_value_hash", key: "A" });
    expect(validateContextEntries([e({ size: -1 })])).toEqual({ ok: false, reason: "invalid_size", key: "A" });
    expect(validateContextEntries([e({ expected_version: 1.5 })])).toEqual({ ok: false, reason: "invalid_expected_version", key: "A" });
    expect(validateContextEntries([e(), e()])).toEqual({ ok: false, reason: "duplicate_key", key: "A" });
    // 同じ名前でも kind が違えば別の key
    expect(validateContextEntries([e({ key: "plan.md" }), e({ kind: "source", key: "plan.md" })]).ok).toBe(true);
  });

  test("AC-X3: key の壁は索引の検証にも効く", () => {
    expect(validateContextEntries([e({ key: "transcript" })])).toEqual({ ok: false, reason: "conversation_key", key: "transcript" });
    expect(validateContextEntries([e({ kind: "source", key: "../x.md" })])).toEqual({ ok: false, reason: "invalid_source_path", key: "../x.md" });
  });
});

describe("buildContextValue — 端末で CAS に書く前の壁", () => {
  test("hash は Capsule と同じ正規化 hash で、object の key 順に依らない", () => {
    const a = buildContextValue("A", { x: 1, y: [1, 2] });
    const b = buildContextValue("A", { y: [1, 2], x: 1 });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(hashCapsuleBody({ key: "A", value: { x: 1, y: [1, 2] } }));
    // key が違えば同じ value でも別の payload(別の key の索引が同じ payload を指せない)
    expect(buildContextValue("B", { x: 1, y: [1, 2] }).hash).not.toBe(a.hash);
  });

  test("value の中に会話の key をネストすると拒否", () => {
    expect(() => buildContextValue("A", { notes: [{ messages: ["hi"] }] })).toThrow(ContextValueError);
  });

  test("credential_ref が env:NAME の形でなければ拒否 / 正しい形は通る", () => {
    expect(() => buildContextValue("A", { token: { credential_ref: "sk-live-raw" } })).toThrow(CapsuleCredentialRefError);
    expect(buildContextValue("A", { token: { credential_ref: "env:GITHUB_TOKEN" } }).payload.key).toBe("A");
  });

  test("key の壁と undefined の value", () => {
    expect(() => buildContextValue("conversation", "x")).toThrow(ContextValueError);
    expect(() => buildContextValue("A", undefined)).toThrow(ContextValueError);
  });
});

describe("summarizeContextIndex — 値を読まずに「何の key が在るか」を 1 行(PBI-0437)", () => {
  const c = (key: string) => ({ kind: "context", key });
  const src = (key: string) => ({ kind: "source", key });

  test("AC-1: 決まった key は決まった順・auto は名前だけ・自由 key と source と inbox は件数", () => {
    const rows = [
      c("notes"), c("next_step"), c("auto/tests"), c("goal"), c("api.shape"), c("auto/git"),
      c("inbox/wrk_a/1-x"), c("inbox/wrk_b/2-y"), src("docs/plan.md"),
    ];
    expect(summarizeContextIndex(rows)).toBe("context: goal, next_step · auto: git, tests · +2 keys · 1 source · inbox 2");
  });

  test("決まった key の順は定数の並びそのもの(goal → next_step → decisions → …)", () => {
    const rows = [...WORK_CONTEXT_WELL_KNOWN_KEYS].reverse().map(c);
    expect(summarizeContextIndex(rows)).toBe(`context: ${WORK_CONTEXT_WELL_KNOWN_KEYS.join(", ")}`);
  });

  test("task の索引で同じ key が 2 行(task と project)来ても 1 つに数える / 空なら (empty)", () => {
    expect(summarizeContextIndex([c("goal"), c("goal"), c("x"), c("x"), src("a.md"), src("a.md")])).toBe("context: goal · +1 key · 1 source");
    expect(summarizeContextIndex([])).toBe("context: (empty)");
  });
});

describe("findReservedContextKeys — 機械の置き場は agent の手書きで書かない(PBI-0437)", () => {
  test("auto/ と inbox/ だけが予約。名前が似ているだけの key は通る", () => {
    expect(findReservedContextKeys(["auto/git", "inbox/x/1", "goal", "autos", "inbox", "my/auto/x"])).toEqual(["auto/git", "inbox/x/1"]);
  });
});

