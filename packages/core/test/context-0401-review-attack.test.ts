// PBI-0401 有界レビュー(2026-09-09)の攻撃。
//
// go は差を 8 ケースで並べて 2 件を「② 手元が良い」と分類し、判定をレビューへ回した。
// ここは **その判定を上流の実物で裏取りする**ための攻撃で、go の 8 ケースが踏んでいない所だけ撃つ:
//
//   X1. ② その 2 の**裏側** —— go は「missing なのに truncated:true」しか測っていない。
//       同じ性質(呼び手の嘘)は**逆向き**(切られているのに truncated:false)にも在り、そちらの方が
//       危ない(切ったのに「切っていない」と報告される)。上流は両方向とも呼び手を信じる
//   X2. ③ と書いてあるだけで**一度も測っていない**読み替え(`user.md` cap → 要素別 cap)を実射する
//   X3. その読み替えを port した時に落ちていた ①(上流は名前の大小を潰してから cap を引く)
//   X4. 上流を呼んでいる口が stub に化けていない —— 呼べない関数は**黙って別の答えを返さず throw** する
//
// 上流の実物 = `third_party/openclaw/`(改変なし・blob sha は 旧 diagrams-check 4-1 が固定)。
import { describe, expect, test } from "bun:test";
import { analyzeBootstrapBudget } from "../../../third_party/openclaw/src/agents/bootstrap-budget.ts";
import { normalizeOptionalString } from "../../../third_party/openclaw/packages/normalization-core/src/string-coerce.ts";
import {
  analyzeContextBudget,
  CONTEXT_ELEMENT_BUDGETS,
  CONTEXT_TOTAL_BUDGET,
} from "../src/context.ts";

describe("PBI-0401 review: ② の判定を上流の実物で裏取りする", () => {
  // X1. 「切られているのに呼び手が truncated:false と言う」——上流はその嘘を信じ、
  //     切った事実が hasTruncation からも truncatedFiles からも消える。
  //     手元は `kept < raw` から導くので、呼び手は**どちらの向きにも**嘘を吐けない。
  test("X1: 呼び手が「切っていない」と嘘をつくと上流は黙って飲む(手元は導くので飲まない)", () => {
    const up = analyzeBootstrapBudget({
      files: [
        { name: "a.md", path: "a.md", missing: false, rawChars: 100, injectedChars: 10, truncated: false },
      ],
      bootstrapMaxChars: 50,
      bootstrapTotalMaxChars: 50,
    });
    // 上流: 90 字が消えているのに「切っていない」。cause も付かない
    expect(up.hasTruncation).toBe(false);
    expect(up.truncatedFiles).toEqual([]);
    expect(up.files[0]!.causes).toEqual([]);
    expect(up.totals.truncatedChars).toBe(90); // 総和だけは合わないまま残る = 自己矛盾

    const ours = analyzeContextBudget({
      elements: [{ name: "a.md", rawTokens: 100, keptTokens: 10 }],
      elementMaxTokens: 50,
      totalMaxTokens: 50,
    });
    expect(ours.hasTruncation).toBe(true);
    expect(ours.truncated.map((e) => e.name)).toEqual(["a.md"]);
    expect(ours.elements[0]!.causes).toEqual(["per-element-limit"]);
  });

  // X2. ③ 読み替え(`user.md` の 4,000 字 cap → 要素別 cap)は表に文だけ在って測っていなかった。
  //     上流は "user.md" だけを min(max, 4000) に落とし、手元は表に在る 6 要素を落とす ——
  //     **同じ入力に対して両者は違う値を返す**。それが読み替えの本体で、差が出るのが正しい
  test("X2: 読み替えは実際に差を作る(上流は user.md だけ・手元は要素の表)", () => {
    const args = { bootstrapMaxChars: 10_000, bootstrapTotalMaxChars: 10_000 };
    const upUser = analyzeBootstrapBudget({
      files: [{ name: "user.md", path: "user.md", missing: false, rawChars: 1, injectedChars: 1, truncated: false }],
      ...args,
    });
    expect(upUser.files[0]!.effectiveFileLimit).toBe(4_000); // 上流の個別 cap

    const upIdentity = analyzeBootstrapBudget({
      files: [{ name: "identity", path: "identity", missing: false, rawChars: 1, injectedChars: 1, truncated: false }],
      ...args,
    });
    expect(upIdentity.files[0]!.effectiveFileLimit).toBe(10_000); // 上流に identity の cap は無い

    const ours = analyzeContextBudget({
      elements: [
        { name: "user.md", rawTokens: 1, keptTokens: 1 },
        { name: "identity", rawTokens: 1, keptTokens: 1 },
      ],
      elementMaxTokens: 10_000,
      totalMaxTokens: 10_000,
    });
    expect(ours.elements[0]!.effectiveLimit).toBe(10_000); // 手元に user.md という要素は無い
    expect(ours.elements[1]!.effectiveLimit).toBe(CONTEXT_ELEMENT_BUDGETS.identity); // 100
  });

  // X3. ① 上流が正しい —— 上流は `name.toLowerCase() === "user.md"` と大小を潰してから cap を引く。
  //     port はそこを落としていて、`"Identity"` と綴るだけで cap が外れる fail-open だった。
  //     **負の対照**: `effectiveElementLimit` の `.toLowerCase()` を外すと、この test が赤くなる
  test("X3: 名前の大小で要素別 cap が外れない(上流の toLowerCase を port し直した)", () => {
    const upper = analyzeContextBudget({
      elements: [{ name: "IDENTITY", rawTokens: 500, keptTokens: 500 }],
      elementMaxTokens: CONTEXT_TOTAL_BUDGET,
      totalMaxTokens: CONTEXT_TOTAL_BUDGET,
    });
    expect(upper.elements[0]!.effectiveLimit).toBe(CONTEXT_ELEMENT_BUDGETS.identity); // 1000 ではなく 100
    expect(upper.elements[0]!.nearLimit).toBe(true); // 500 >= ceil(100 * 0.85)

    // 上流も同じ性質を持っている(大小を変えても cap は外れない)
    const up = analyzeBootstrapBudget({
      files: [{ name: "USER.MD", path: "USER.MD", missing: false, rawChars: 1, injectedChars: 1, truncated: false }],
      bootstrapMaxChars: 10_000,
      bootstrapTotalMaxChars: 10_000,
    });
    expect(up.files[0]!.effectiveFileLimit).toBe(4_000);
  });

  // X4. 写していない上流の関数は **no-op で埋めていない**。no-op にすると、いつか誰かが呼んだ時に
  //     上流と違う答えが静かに返る(= 借りていないのに借りたふりになる)。
  //     `analyzeBootstrapBudget` はこの経路を 1 度も通らないので、等価検査は throw に当たらない
  test("X4: 写していない上流の関数は黙って別の答えを返さず throw する", () => {
    expect(() => normalizeOptionalString("x")).toThrow(/写していない/);
  });
});
