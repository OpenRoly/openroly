// PBI-0406 有界レビュー(2026-09-09)攻撃 test。
//
// 破れ: buildCapsule の会話の壁(AC-4)は `input` の **top-level key** しか見ていなかった。
// 8 要素の 1 つ(例: current_state)の値として `{ conversation: [...] }` を丸ごとネストすると
// `'conversation' in input` が false になり、throw せずそのまま通過していた
// (PBI の設計意図「会話を入れる道を 1 つも作らない(AC-4 の壁が本体)」に反する — この壁が
// 本体である以上、top-level だけを見るのは片手落ち)。
//
// fix: packages/core/src/capsule.ts の hasKeyDeep が object/array を再帰的に潜って
// forbidden key を探すようにした。
//
// 未fixのまま残す残差(このtestではfailにしない): 会話そのものを "conversation" という
// key 名を使わずに current_state の値として詰める(下の「残差」test)は、name ベースの
// 壁である以上どうやっても防げない(PBI が指定した禁止語彙は 3 語のみで、内容ベースの
// 検知は AC-4 の範囲外)。レビューのコメントとして記録する。
import { describe, expect, test } from "bun:test";
import { buildCapsule, CapsuleConversationError } from "../src/capsule.ts";

const conversationLike = [
  { role: "user", content: "このタスクを進めて" },
  { role: "assistant", content: "了解しました、進めます" },
];

describe("PBI-0406 review 攻撃: AC-4 の壁のネスト回避", () => {
  test("攻撃1: 許可 field(current_state)の値に conversation を直接ネストしても throw する", () => {
    expect(() => buildCapsule({ goal: "x", current_state: { conversation: conversationLike } })).toThrow(
      CapsuleConversationError,
    );
  });

  test("攻撃2: messages / transcript も同じ経路(2 階層ネスト)で throw する", () => {
    expect(() =>
      buildCapsule({ relevant_memory: { nested: { messages: conversationLike } } }),
    ).toThrow(CapsuleConversationError);
    expect(() => buildCapsule({ git_state: { transcript: "full session log" } })).toThrow(
      CapsuleConversationError,
    );
  });

  test("攻撃3: array の要素として深くネストしても throw する", () => {
    expect(() =>
      buildCapsule({ decisions: ["ok", { note: "x", conversation: conversationLike }] }),
    ).toThrow(CapsuleConversationError);
  });

  test("攻撃4: 3 語すべてを別々の階層に散らして混ぜても、3 語全部を名乗って throw する", () => {
    try {
      buildCapsule({
        current_state: { conversation: [] },
        relevant_artifacts: [{ messages: [] }],
        git_state: { deep: { transcript: "" } },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CapsuleConversationError);
      expect((e as CapsuleConversationError).foundKeys).toEqual(["conversation", "messages", "transcript"]);
    }
  });

  test("負の対照: forbidden key と無関係な深いネストは throw せず通る(過剰検知していない)", () => {
    const { body, droppedKeys } = buildCapsule({
      goal: "x",
      current_state: { step: 1, notes: ["a", "b"], meta: { retries: 2 } },
    });
    expect(body.current_state).toEqual({ step: 1, notes: ["a", "b"], meta: { retries: 2 } });
    expect(droppedKeys).toEqual([]);
  });

  test("残差(既知の限界・fail にしない): key 名を使わず会話をそのまま値として詰めると通る", () => {
    // name ベースの壁の限界 — PBI-0406 の禁止語彙は conversation/messages/transcript の
    // 3 語のみ(AC-4)。内容が会話に見えるかどうかは判定しない。これは仕様どおりの残差であり、
    // このレビューでは「壊れている」とは扱わない(次に何か作る時のための記録)。
    const { body } = buildCapsule({ current_state: conversationLike });
    expect(body.current_state).toEqual(conversationLike);
  });
});
