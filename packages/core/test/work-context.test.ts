// PBI-0433: Work Project context の壁(core・DB 無し)。key の文字種 / source path / 索引の形 / value の壁。
import { describe, expect, test } from "bun:test";
import { CapsuleCredentialRefError, hashCapsuleBody } from "../src/capsule.ts";
import {
  decideContextWrite,
  findReservedContextKeys,
  summarizeContextIndex,
  countInbox,
  inboxDeliveredKeys,
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

describe("inbox の既読 — 数え方と、既読にしてよい key(PBI-0444)", () => {
  const ib = (key: string, read?: boolean) => ({ kind: "context", key, ...(read !== undefined ? { read } : {}) });

  test("countInbox: 未読は read === false の行だけ(read の無い project の inbox は未読に数えない)", () => {
    const rows = [ib("inbox/a/1", false), ib("inbox/a/2", true), ib("inbox/p/3"), ib("goal"), { kind: "source", key: "inbox/x.md" }];
    expect(countInbox(rows)).toEqual({ total: 3, unread: 1 });
    expect(countInbox([])).toEqual({ total: 0, unread: 0 });
  });

  test("summarizeContextIndex: 未読が在れば `(N unread)`・0 なら件数だけ", () => {
    expect(summarizeContextIndex([ib("inbox/a/1", false), ib("inbox/a/2", false), ib("inbox/a/3", true)])).toBe("inbox 3 (2 unread)");
    expect(summarizeContextIndex([ib("inbox/a/1", true), ib("inbox/a/2", true)])).toBe("inbox 2");
  });

  test("inboxDeliveredKeys: 値が agent に渡った未読の inbox/ だけ", () => {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["値が渡った未読", { ...ib("inbox/a/1", false), value: { text: "hi" } }, true],
      ["index_only(value を落とした行)", { ...ib("inbox/a/2", false), est_tokens: 5, preview: "hi" }, false],
      ["この端末に値が無い", { ...ib("inbox/a/3", false), value: null, missing_on_device: true }, false],
      ["既に既読", { ...ib("inbox/a/4", true), value: "hi" }, false],
      ["project の inbox(read 無し)", { ...ib("inbox/p/5"), value: "hi" }, false],
      ["inbox/ でない key", { ...ib("goal", false), value: "x" }, false],
      ["source", { kind: "source", key: "inbox/x.md", read: false, value: "x" }, false],
    ];
    for (const [name, entry, want] of cases) {
      expect({ name, delivered: inboxDeliveredKeys([entry as never]).length === 1 }).toEqual({ name, delivered: want });
    }
  });
});

describe("findReservedContextKeys — 機械の置き場は agent の手書きで書かない(PBI-0437)", () => {
  test("auto/ と inbox/ だけが予約。名前が似ているだけの key は通る", () => {
    expect(findReservedContextKeys(["auto/git", "inbox/x/1", "goal", "autos", "inbox", "my/auto/x"])).toEqual(["auto/git", "inbox/x/1"]);
  });
});


describe("decideContextWrite — project に出すのは publish だけ(PBI-0443)", () => {
  type WorkNode = { id: string; parentWorkId: string | null };
  const P: WorkNode = { id: "P", parentWorkId: null };
  const P2 = { id: "P2", parentWorkId: null };
  const T = { id: "T", parentWorkId: "P" };
  const T2 = { id: "T2", parentWorkId: "P" };
  const U = { id: "U", parentWorkId: "P2" };
  const ok = { ok: true } as const;
  const cases: [string, WorkNode, WorkNode[] | null, string[], ReturnType<typeof decideContextWrite>][] = [
    ["human は project に書ける", P, null, ["decisions"], ok],
    ["何も握っていない runtime は今まで通り", P, [], ["decisions"], ok],
    ["project の holder は書ける(AC-3)", P, [P], ["decisions"], ok],
    ["task と project を両方握っていれば書ける", P, [T, P], ["decisions"], ok],
    ["task の holder が自分の project へ = publish_required(AC-2)", P, [T], ["decisions"], { ok: false, reason: "publish_required" }],
    ["1 つでも inbox/ でない key が混ざれば publish_required", P, [T], ["inbox/T/1", "goal"], { ok: false, reason: "publish_required" }],
    ["全部 inbox/ なら message なので ok", P, [T], ["inbox/T/1"], ok],
    ["自分の task", T, [T], ["decisions"], ok],
    ["兄弟の task(work_message)", T2, [T], ["inbox/T/1"], ok],
    ["握っている project の task", T, [P], ["decisions"], ok],
    ["別 project の task の holder → project は not_found(AC-X1)", P, [U], ["decisions"], { ok: false, reason: "not_found" }],
    ["別 project の task の holder → その task も not_found(AC-X1)", T, [U], ["decisions"], { ok: false, reason: "not_found" }],
    ["task の holder → 単独の work も not_found", P2, [T], ["decisions"], { ok: false, reason: "not_found" }],
  ];
  for (const [name, target, held, keys, want] of cases) {
    test(name, () => expect(decideContextWrite(target, held, keys)).toEqual(want));
  }
});
