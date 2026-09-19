// PBI-0406 / CAP-3 V2: buildCapsule の判定(会話の壁 = AC-4・正規化 hash = AC-5)。
// PBI-0414 / CAP-3 V4.5: Secret Reference(credential_ref)の検証と Manifest の組み立て/検証。
// lease / version 採番 / 冪等は server 側(apps/server/test/capsule.test.ts)が持つ —— ここは
// 純関数のみ(DB を触らない)。
import { describe, expect, test } from "bun:test";
import {
  buildCapsule,
  buildManifest,
  CapsuleConversationError,
  CapsuleCredentialRefError,
  CAPSULE_FIELDS,
  formatContinueCheckpoint,
  hashCapsuleBody,
  isValidCasHash,
  validateCredentialRefs,
  validateManifest,
} from "../src/capsule.ts";

describe("buildCapsule(PBI-0406)", () => {
  test("AC-4a: conversation / messages / transcript は throw して capsule_rejects_conversation を返す", () => {
    for (const key of ["conversation", "messages", "transcript"]) {
      expect(() => buildCapsule({ goal: "ship V2", [key]: ["hi"] })).toThrow(CapsuleConversationError);
      try {
        buildCapsule({ [key]: ["hi"] });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CapsuleConversationError);
        expect((e as CapsuleConversationError).code).toBe("capsule_rejects_conversation");
        expect((e as CapsuleConversationError).foundKeys).toEqual([key]);
      }
    }
  });

  test("AC-4b: 3 つ同時に混ぜても 1 回の throw で全部名乗る(黙って 1 つだけ拾わない)", () => {
    try {
      buildCapsule({ conversation: [], messages: [], transcript: "" });
      expect.unreachable();
    } catch (e) {
      expect((e as CapsuleConversationError).foundKeys).toEqual(["conversation", "messages", "transcript"]);
    }
  });

  test("AC-4c: CAPSULE_FIELDS 以外の未知 key は黙って落とすのではなく droppedKeys で返す", () => {
    const { body, droppedKeys } = buildCapsule({
      goal: "ship V2",
      current_state: "in progress",
      totally_unknown: 1,
      another_unknown: 2,
    });
    expect(body).toEqual({ goal: "ship V2", current_state: "in progress" });
    expect(droppedKeys.sort()).toEqual(["another_unknown", "totally_unknown"]);
  });

  test("9 要素の名前は仕様どおり(CAPSULE_FIELDS)", () => {
    expect(CAPSULE_FIELDS).toEqual([
      "goal", "current_state", "decisions", "unresolved_questions", "failed_attempts",
      "relevant_artifacts", "relevant_memory", "git_state", "capability_requirements",
    ]);
  });

  test("AC-5: key の順序だけ入れ替えた 2 body は hash が一致する(正規化)", () => {
    const a = buildCapsule({ goal: "g", current_state: "s", decisions: ["d1", "d2"] });
    const b = buildCapsule({ decisions: ["d1", "d2"], current_state: "s", goal: "g" });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash は中身が違えば変わる(1 文字違いでも別 hash — 負の対照)", () => {
    const a = hashCapsuleBody({ goal: "ship V2" });
    const b = hashCapsuleBody({ goal: "ship v2" });
    expect(a).not.toBe(b);
  });

  test("ネストした object / array の key 順序も正規化される", () => {
    const a = buildCapsule({ git_state: { branch: "main", sha: "abc" } });
    const b = buildCapsule({ git_state: { sha: "abc", branch: "main" } });
    expect(a.hash).toBe(b.hash);
  });

  test("空の input は空 body(droppedKeys も空)を返す(throw しない)", () => {
    const { body, droppedKeys, hash } = buildCapsule({});
    expect(body).toEqual({});
    expect(droppedKeys).toEqual([]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// PBI-0414 AC-5: 秘密は credential_ref(env:NAME)でしか渡せない。
// 攻撃3(G1 本文): env:PATH / env:(空) / file:///etc/passwd / env:A,B(多重)
describe("validateCredentialRefs / buildCapsule との統合(PBI-0414 AC-5)", () => {
  test("credential_ref を使わない capsule はそのまま通る(既定は許可)", () => {
    expect(() => buildCapsule({ goal: "ship V2" })).not.toThrow();
  });

  test("env:NAME は妥当な階層(ネストの中)でも通る", () => {
    const { body } = buildCapsule({ git_state: { secret: { credential_ref: "env:API_KEY" } } });
    expect(body).toEqual({ git_state: { secret: { credential_ref: "env:API_KEY" } } });
  });

  test("env:PATH は妥当(名前を意味でブロックリストしない — 形式だけ見る)", () => {
    expect(() => buildCapsule({ goal: { credential_ref: "env:PATH" } })).not.toThrow();
  });

  test("env:A,B(複数名・reconcile.ts と同じ構文)は妥当", () => {
    expect(() => buildCapsule({ goal: { credential_ref: "env:A,B" } })).not.toThrow();
  });

  test("攻撃3: env:(空) / file://.../ 生の値は CapsuleCredentialRefError で拒否", () => {
    for (const bad of ["env:", "file:///etc/passwd", "sk-abc123xyz", "connection:github"]) {
      expect(() => buildCapsule({ goal: { credential_ref: bad } })).toThrow(CapsuleCredentialRefError);
    }
  });

  test("負の対照: credential_ref というキー名でなければ検証しない(過剰検知していない)", () => {
    // 同じ値でも key 名が違えば、ただの文字列として通る(credential_ref だけが特別扱い)
    expect(() => buildCapsule({ goal: "file:///etc/passwd" })).not.toThrow();
  });
});

describe("Manifest(PBI-0414): buildManifest / validateManifest", () => {
  test("buildManifest: body 内の credential_ref の env 名だけを refs に集める(値は入れない・重複無し・昇順)", () => {
    const { body } = buildCapsule({
      goal: { credential_ref: "env:B_KEY" },
      decisions: [{ credential_ref: "env:A_KEY,B_KEY" }], // B_KEY は重複するが 1 回だけ
    });
    const manifest = buildManifest(body, { hash: "h".repeat(64), size: 10, mode: "0600" });
    expect(manifest).toEqual({ payload_hash: "h".repeat(64), size: 10, mode: "0600", refs: ["A_KEY", "B_KEY"] });
  });

  test("buildManifest: credential_ref が無ければ refs は空配列", () => {
    const { body } = buildCapsule({ goal: "ship V2" });
    const manifest = buildManifest(body, { hash: "a".repeat(64), size: 5, mode: "0600" });
    expect(manifest.refs).toEqual([]);
  });

  test("validateManifest: 正しい形は通る", () => {
    const r = validateManifest({ payload_hash: "a".repeat(64), size: 10, mode: "0600", refs: ["API_KEY"] });
    expect(r).toEqual({ ok: true, manifest: { payload_hash: "a".repeat(64), size: 10, mode: "0600", refs: ["API_KEY"] } });
  });

  test("validateManifest: payload_hash が sha256 hex でなければ拒否(攻撃②: path traversal の入口を閉じる)", () => {
    for (const bad of ["../../../etc/passwd", "a".repeat(63), "A".repeat(64), "", 123]) {
      expect(validateManifest({ payload_hash: bad, size: 1, mode: "0600", refs: [] })).toEqual({
        ok: false, reason: "invalid_payload_hash",
      });
    }
  });

  test("validateManifest: size が負・小数・文字列は拒否", () => {
    for (const bad of [-1, 1.5, "10", null]) {
      expect(validateManifest({ payload_hash: "a".repeat(64), size: bad, mode: "0600", refs: [] })).toEqual({
        ok: false, reason: "invalid_size",
      });
    }
  });

  test("validateManifest: mode の形が違えば拒否", () => {
    for (const bad of ["rwx", "600", "08888", ""]) {
      expect(validateManifest({ payload_hash: "a".repeat(64), size: 1, mode: bad, refs: [] })).toEqual({
        ok: false, reason: "invalid_mode",
      });
    }
  });

  test("validateManifest: refs が配列でない/要素が env 名の形でなければ拒否", () => {
    for (const bad of ["not-an-array", [123], ["has space"], ["env:PATH"]]) {
      expect(validateManifest({ payload_hash: "a".repeat(64), size: 1, mode: "0600", refs: bad })).toEqual({
        ok: false, reason: "invalid_refs",
      });
    }
  });

  test("validateManifest: 全体が object でなければ拒否", () => {
    for (const bad of [null, "string", 42, ["array"]]) {
      expect(validateManifest(bad)).toEqual({ ok: false, reason: "invalid_manifest" });
    }
  });
});

describe("isValidCasHash(攻撃②の核心)", () => {
  test("64 文字の小文字 hex だけを許す", () => {
    expect(isValidCasHash("f".repeat(64))).toBe(true);
    expect(isValidCasHash("../../../etc/passwd")).toBe(false);
    expect(isValidCasHash("/absolute/path")).toBe(false);
  });
});

describe("formatContinueCheckpoint(PBI-0684)", () => {
  test("current_state があればそれを出す。空 capsule でも title まで落ちて必ず checkpoint: で始まる", () => {
    expect(formatContinueCheckpoint({ payload: { current_state: "wrote the test" }, title: "t" }))
      .toBe("checkpoint: wrote the test");
    expect(formatContinueCheckpoint({ payload: { body: { goal: "ship" } }, title: "t" }))
      .toBe("checkpoint: ship");
    expect(formatContinueCheckpoint({ payload: { decisions: ["picked grok"] }, title: "t" }))
      .toBe("checkpoint: picked grok");
    expect(formatContinueCheckpoint({ payload: {}, handoffNote: "limit hit", title: "t" }))
      .toBe("checkpoint: limit hit");
    expect(formatContinueCheckpoint({ payload: null, title: "operator chain" }))
      .toBe("checkpoint: operator chain");
  });

  test("負の対照: current_state を読まないと空 capsule は title に落ちる", () => {
    const payload = { current_state: "real progress", goal: "ship" };
    expect(formatContinueCheckpoint({ payload, title: "t" })).not.toBe("checkpoint: t");
    expect(formatContinueCheckpoint({ payload: {}, title: "t" })).toBe("checkpoint: t");
  });
});
