import { describe, expect, test } from "bun:test";
// **上流の実物**(third_party/ = 改変せずに置いた写し)。手で写した期待値は持たない —— PBI-0401
import { analyzeBootstrapBudget } from "../../../third_party/openclaw/src/agents/bootstrap-budget.ts";
import {
  CONTEXT_DYNAMIC_ELEMENTS,
  CONTEXT_ELEMENTS,
  CONTEXT_ELEMENT_BUDGETS,
  CONTEXT_NEAR_LIMIT_RATIO,
  CONTEXT_STATIC_ELEMENTS,
  CONTEXT_TOTAL_BUDGET,
  analyzeContextBudget,
  buildContextTruncationMeta,
  buildContextTruncationNotice,
  estimateTokens,
  renderContext,
  resolve,
  truncateToTokens,
  type ContextBudgetAnalysis,
  type ContextInput,
} from "../src/context.ts";

// PBI-0398 / CAP-3 B2: Context Resolver。AC-1〜4・X1・X2・攻撃・port の等価。
//
// **負の対照(手動 1 回)**: `resolve` の `rawTokens <= limit ? text : truncateToTokens(...)` を
// `text` 固定(= 上限判定を殺す)に戻すと、`over_budget_truncates_with_report` と
// `huge_all_elements_still_bounded` が赤くなる。結果は PBI の G2 に 1 行。

/**
 * ちょうど `target` tokens の材料を作る。見分けの付く語を 10 個だけ先頭に置き、残りを
 * CJK 1 文字 = 1 token で埋める —— **原文の token 数を等値で書けるようにする**
 * (「だいたい 600」だと切った後の 250 も等値で測れない)。
 *
 * 語を 1 つずつ足しながら毎回全文を数え直す作り方は (a) O(n²) で 5,000 tokens の材料 6 本に
 * 12 秒掛かり、(b) `tag-123` が 1 語 7 文字 = 5.4 chars/token と**実文より薄い**ので、
 * `estimateTokens` の「空白を除いた文字数 / 4」の床に当たって target を跨いだ。
 */
const MATERIAL_HEAD_WORDS = 10;
function material(target: number, tag: string): string {
  const head = Array.from({ length: MATERIAL_HEAD_WORDS }, (_, i) => `${tag}-${i}`).join(" ");
  let pad = target - estimateTokens(head);
  expect(pad).toBeGreaterThan(0);
  let text = `${head} ${"あ".repeat(pad)}`;
  // word 側の 1.3 は浮動小数で端数が 1〜2 ずれる。CJK は 1 文字 = 1 token なので、
  // 差分だけ足し引きすれば数回で収束する(語を 1 つずつ試す O(n²) は要らない)
  for (let i = 0; i < 8 && estimateTokens(text) !== target; i += 1) {
    pad += target - estimateTokens(text);
    text = `${head} ${"あ".repeat(pad)}`;
  }
  expect(estimateTokens(text)).toBe(target);
  return text;
}

/** AC-1 の「各要素が上限内」の材料 */
function underBudget(): ContextInput {
  return {
    identity: material(80, "id"),
    constraints: material(200, "con"),
    preferences: material(200, "pref"),
    currentWork: material(150, "work"),
    capabilities: material(80, "cap"),
    pointers: material(90, "ptr"),
  };
}

describe("PBI-0398 estimateTokens / truncateToTokens", () => {
  test("同じ入力に対して常に同じ整数(冪等)・空は 0・日本語も数える", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n  ")).toBe(0);
    const en = "the quick brown fox jumps";
    expect(estimateTokens(en)).toBe(estimateTokens(en));
    expect(estimateTokens(en)).toBe(Math.ceil(5 * 1.3));
    // 未決の問い: 材料が日本語の時。CJK は 1 文字 1 token で数える(word 数では 1 語になる)
    expect(estimateTokens("契約は英語で結ぶ")).toBe(8);
    expect(estimateTokens("契約 and 英語")).toBe(4 + Math.ceil(1 * 1.3));
  });

  test("切るのは末尾から。返り値は必ず上限以内で、先頭は 1 文字も変わらない", () => {
    const text = material(600, "w");
    const cut = truncateToTokens(text, 250);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(250);
    expect(text.startsWith(cut)).toBe(true);
    expect(truncateToTokens(text, 0)).toBe("");
    expect(truncateToTokens("short", 999)).toBe("short");
  });
});

describe("PBI-0398 resolve", () => {
  test("要素別の上限の和が REQ-83 の 1,000 と一致する", () => {
    const sum = CONTEXT_ELEMENTS.reduce((n, k) => n + CONTEXT_ELEMENT_BUDGETS[k], 0);
    expect(sum).toBe(CONTEXT_TOTAL_BUDGET);
    expect(CONTEXT_NEAR_LIMIT_RATIO).toBe(0.85);
  });

  // AC-1
  test("under_budget_keeps_all: 上限内なら 6 要素とも完全に保持し report は空", () => {
    const input = underBudget();
    const ctx = resolve(input);
    expect(ctx.identity).toBe(input.identity);
    expect(ctx.constraints).toBe(input.constraints);
    expect(ctx.preferences).toBe(input.preferences);
    expect(ctx.current_work).toBe(input.currentWork);
    expect(ctx.capabilities).toBe(input.capabilities);
    expect(ctx.pointers).toBe(input.pointers);
    expect(ctx.truncationReport).toEqual([]);
    expect(ctx.tokenEstimate).toBe(80 + 200 + 200 + 150 + 80 + 90);
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(CONTEXT_TOTAL_BUDGET);
    expect(buildContextTruncationNotice(ctx.truncationReport)).toBeUndefined();
  });

  // AC-2
  test("over_budget_truncates_with_report: 溢れた要素だけが 250 に切られ 1 行残る", () => {
    const input = { ...underBudget(), constraints: material(600, "con") };
    const ctx = resolve(input);
    expect(ctx.truncationReport).toEqual([
      { element: "constraints", original: 600, kept: 250, reason: "per-element-limit" },
    ]);
    expect(estimateTokens(ctx.constraints)).toBe(250);
    expect(input.constraints.startsWith(ctx.constraints)).toBe(true);
    // **他の要素は切れない**
    expect(ctx.identity).toBe(input.identity);
    expect(ctx.preferences).toBe(input.preferences);
    expect(ctx.current_work).toBe(input.currentWork);
    expect(ctx.capabilities).toBe(input.capabilities);
    expect(ctx.pointers).toBe(input.pointers);
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(CONTEXT_TOTAL_BUDGET);
    // 黙って落とさない: 注意書きと receipt 用 meta の両方に出る
    expect(buildContextTruncationNotice(ctx.truncationReport)).toContain("constraints");
    expect(buildContextTruncationMeta(ctx).truncatedElements).toBe(1);
  });

  // AC-X1
  test("no_cross_account_leak: resolver は引数しか見ない(B の文は A の package に出ない)", () => {
    const a = underBudget();
    const b: ContextInput = {
      identity: "@bravo · acc_bravo · BRAVO-SECRET-IDENTITY",
      constraints: "BRAVO-SECRET-CONSTRAINT",
      preferences: "BRAVO-SECRET-PREFERENCE",
      currentWork: "BRAVO-SECRET-WORK",
      capabilities: "BRAVO-SECRET-CAPABILITY",
      pointers: "BRAVO-SECRET-POINTER",
    };
    resolve(b); // B を先に通しても resolver は状態を持たない(純関数)
    const ctx = resolve(a);
    const whole = [
      renderContext(ctx, CONTEXT_STATIC_ELEMENTS),
      renderContext(ctx, CONTEXT_DYNAMIC_ELEMENTS),
      JSON.stringify(ctx),
    ].join("\n");
    expect(whole).not.toContain("BRAVO-SECRET");
  });

  // AC-X2
  test("empty_element_is_omitted: 空材料は落ちずに省略され、合計に計上されない", () => {
    const input = { ...underBudget(), currentWork: "" };
    const ctx = resolve(input);
    expect(ctx.current_work).toBe("");
    expect(ctx.tokenEstimate).toBe(80 + 200 + 200 + 80 + 90); // work の 150 が入らない
    expect(ctx.truncationReport).toEqual([]);
    expect(renderContext(ctx, CONTEXT_DYNAMIC_ELEMENTS)).not.toContain("current_work:");
    // 空白だけ・全部空でも落ちない
    expect(() =>
      resolve({ identity: "  ", constraints: "", preferences: "", currentWork: "\n", capabilities: "", pointers: "" }),
    ).not.toThrow();
    expect(
      resolve({ identity: "", constraints: "", preferences: "", currentWork: "", capabilities: "", pointers: "" })
        .tokenEstimate,
    ).toBe(0);
  });

  // 攻撃
  test("huge_all_elements_still_bounded: 6 要素すべて 5,000 tokens でも合計は 1,000 以内", () => {
    const huge = (tag: string): string => `${material(5000, tag)} ${tag}-TAILMARKER`;
    const input: ContextInput = {
      identity: huge("id"),
      constraints: huge("con"),
      preferences: huge("pref"),
      currentWork: huge("work"),
      capabilities: huge("cap"),
      pointers: huge("ptr"),
    };
    const ctx = resolve(input);
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(CONTEXT_TOTAL_BUDGET);
    expect(ctx.truncationReport).toHaveLength(6);
    for (const name of CONTEXT_ELEMENTS) {
      expect(estimateTokens(ctx[name])).toBeLessThanOrEqual(CONTEXT_ELEMENT_BUDGETS[name]);
    }
    // 溢れた文字列がどこにも出ない(package 本文にも JSON にも)
    const whole = [
      renderContext(ctx, CONTEXT_STATIC_ELEMENTS),
      renderContext(ctx, CONTEXT_DYNAMIC_ELEMENTS),
      JSON.stringify(ctx),
    ].join("\n");
    expect(whole).not.toContain("TAILMARKER");
  });

  // AC-4 の core 側(server 側の経路は apps/server/test/context.test.ts)
  test("static_dynamic_separation: 静的側に work は名前ごと入って来られない", () => {
    const ctx = resolve({ ...underBudget(), currentWork: "__WORK__ #281 auth refactor · proof 31/34" });
    const staticSide = renderContext(ctx, CONTEXT_STATIC_ELEMENTS);
    const dynamicSide = renderContext(ctx, CONTEXT_DYNAMIC_ELEMENTS);
    expect(staticSide).not.toContain("__WORK__");
    expect(staticSide).not.toContain("current_work:");
    expect(staticSide).not.toContain("pointers:");
    expect(staticSide).toContain("identity:");
    expect(staticSide).toContain("capabilities:");
    expect(dynamicSide).toContain("__WORK__");
    expect(dynamicSide).toContain("pointers:");
    // 分離の正本は 2 つの配列で、合わせて 6 要素・重なりは無い
    expect([...CONTEXT_STATIC_ELEMENTS, ...CONTEXT_DYNAMIC_ELEMENTS].sort()).toEqual(
      [...CONTEXT_ELEMENTS].sort(),
    );
  });
});

describe("PBI-0398 analyzeContextBudget(OpenClaw bootstrap-budget.ts の port)", () => {
  test("total-limit の cause は「前の要素が食い切った後」にだけ付く", () => {
    const a = analyzeContextBudget({
      elements: [
        { name: "a.md", rawTokens: 20000, keptTokens: 20000 },
        { name: "b.md", rawTokens: 20000, keptTokens: 20000 },
        { name: "c.md", rawTokens: 20000, keptTokens: 20000 },
        { name: "d.md", rawTokens: 10000, keptTokens: 0 },
      ],
      elementMaxTokens: 20000,
      totalMaxTokens: 60000,
    });
    expect(a.elements[3]!.causes).toEqual(["total-limit"]);
    expect(a.elements[0]!.causes).toEqual([]);
  });

  test("壊れた上限(0 / NaN / 範囲外の ratio)は安全側へ倒す", () => {
    const a = analyzeContextBudget({
      elements: [{ name: "x.md", rawTokens: 10, keptTokens: 5 }],
      elementMaxTokens: 0,
      totalMaxTokens: Number.NaN,
      nearLimitRatio: 5,
    });
    expect(a.totals.elementMaxTokens).toBe(1);
    expect(a.totals.totalMaxTokens).toBe(1);
    expect(a.totals.nearLimitRatio).toBe(CONTEXT_NEAR_LIMIT_RATIO);
    expect(a.elements[0]!.causes).toEqual(["per-element-limit"]);
  });

  test("missing の要素は合計にも報告にも数えない", () => {
    const a = analyzeContextBudget({
      elements: [
        { name: "identity", rawTokens: 0, keptTokens: 0, missing: true },
        { name: "constraints", rawTokens: 50, keptTokens: 50 },
      ],
      elementMaxTokens: CONTEXT_TOTAL_BUDGET,
      totalMaxTokens: CONTEXT_TOTAL_BUDGET,
    });
    expect(a.totals.rawTokens).toBe(50);
    expect(a.nearLimitElements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PBI-0401: 借りた物を**実際に呼んで**比べる。
//
// ここには**手で写した期待値が 1 つも無い** —— 期待値は
// `third_party/openclaw/src/agents/bootstrap-budget.ts`(上流の写し・改変なし)が返す物そのもの。
// 手写しだった間は「上流がずれても永久に緑」で、それが PBI-0401 が塞いだ穴。
//
// **一致は合格条件ではない。** 我々は上流を「file ごと」→「要素ごと」に読み替えて port したので、
// 差は出る。合格条件は **差が名指しで表に出ていて、各行に 3 択の分類が付いている**こと:
//   ① 上流が正しい → 手元を直す ／ ② 手元が良い → 直さない ／ ③ 読み替えが理由 → 残す
// 表に無い差が出たら赤くなる(= 次にずれた時に気づける)。
// ---------------------------------------------------------------------------

type Upstream = ReturnType<typeof analyzeBootstrapBudget>;

/** 上流の返り値を手元の語彙へ**名前だけ**移す(値は 1 つも作らない・作った瞬間に嘘になる) */
function asOurs(up: Upstream) {
  const el = (f: Upstream["files"][number]) => ({
    name: f.name,
    rawTokens: f.rawChars,
    keptTokens: f.injectedChars,
    missing: f.missing,
    effectiveLimit: f.effectiveFileLimit,
    nearLimit: f.nearLimit,
    truncated: f.truncated,
    causes: f.causes.map((c) => (c === "per-file-limit" ? "per-element-limit" : c)),
  });
  return {
    elements: up.files.map(el),
    truncated: up.truncatedFiles.map(el),
    nearLimitElements: up.nearLimitFiles.map(el),
    totalNearLimit: up.totalNearLimit,
    hasTruncation: up.hasTruncation,
    totals: {
      rawTokens: up.totals.rawChars,
      keptTokens: up.totals.injectedChars,
      truncatedTokens: up.totals.truncatedChars,
      elementMaxTokens: up.totals.bootstrapMaxChars,
      totalMaxTokens: up.totals.bootstrapTotalMaxChars,
      nearLimitRatio: up.totals.nearLimitRatio,
    },
  };
}

/** 違う場所を **field の名前で**返す(「違う」だけだと 3 択に分類できない) */
function diffPaths(a: unknown, b: unknown, at = ""): string[] {
  if (Object.is(a, b)) return [];
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return [at === "" ? "." : at];
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  return [...keys].flatMap((k) => diffPaths(ao[k], bo[k], at === "" ? k : `${at}.${k}`));
}

type Stat = { name: string; raw: number; kept: number; missing?: boolean; truncated?: boolean };
type Case = { name: string; elements: Stat[]; elementMax: number; totalMax: number };

/** 同じ論理入力を両方へ。上流の `truncated` は上流自身の producer
 * (`buildBootstrapInjectionStats`: `!missing && injected < raw`)と同じ式で作る ——
 * そこを手で決めると「入力が違うのに一致した」になる */
function runBoth(c: Case): { up: ReturnType<typeof asOurs>; ours: ContextBudgetAnalysis } {
  return {
    up: asOurs(
      analyzeBootstrapBudget({
        files: c.elements.map((e) => ({
          name: e.name,
          path: e.name,
          missing: e.missing === true,
          rawChars: e.raw,
          injectedChars: e.kept,
          truncated: e.truncated ?? (e.missing !== true && e.kept < e.raw),
        })),
        bootstrapMaxChars: c.elementMax,
        bootstrapTotalMaxChars: c.totalMax,
      }),
    ),
    ours: analyzeContextBudget({
      elements: c.elements.map((e) => ({
        name: e.name,
        rawTokens: e.raw,
        keptTokens: e.kept,
        missing: e.missing === true,
      })),
      elementMaxTokens: c.elementMax,
      totalMaxTokens: c.totalMax,
    }),
  };
}

const CASES: Case[] = [
  // AC-3 の名指しの入力(operator が上流で実測した物と同じ)
  {
    name: "ac3-2files",
    elements: [
      { name: "a.md", raw: 25000, kept: 20000 },
      { name: "b.md", raw: 50000, kept: 40000 },
    ],
    elementMax: 20000,
    totalMax: 60000,
  },
  // AC-4 の境界 5 つ
  { name: "at-limit", elements: [{ name: "x.md", raw: 100, kept: 100 }], elementMax: 100, totalMax: 100 },
  { name: "over-by-one", elements: [{ name: "x.md", raw: 101, kept: 100 }], elementMax: 100, totalMax: 100 },
  { name: "zero-limit", elements: [{ name: "x.md", raw: 10, kept: 5 }], elementMax: 0, totalMax: 0 },
  { name: "empty-elements", elements: [], elementMax: 100, totalMax: 100 },
  { name: "negative-limit", elements: [{ name: "x.md", raw: 10, kept: 5 }], elementMax: -5, totalMax: -1 },
  // 既知のずれ 2 つ(下の 3 択の表に理由が在る)
  { name: "fractional-limit", elements: [{ name: "x.md", raw: 10, kept: 5 }], elementMax: 0.5, totalMax: 0.5 },
  {
    name: "missing-but-flagged-truncated",
    elements: [{ name: "m.md", raw: 10, kept: 0, missing: true, truncated: true }],
    elementMax: 100,
    totalMax: 100,
  },
];

/**
 * 差の一覧。**この表が正本** —— 新しい差が出たら行が変わって赤くなる。
 * 3 択（2026-09-09 の go では分類と推しまで。判定は有界レビュー）:
 *
 * | case | 差 | 分類 | 理由 |
 * |---|---|---|---|
 * | `fractional-limit` | 上限とそこから引く `effectiveLimit`(上流 0 / 手元 1) | ② 手元が良い | 上流は `Math.floor` だけなので `0<v<1` が **0** に落ち、全要素が空文字 + `nearLimit` が `raw >= ceil(0*0.85)=0` で**常に true** になる。上流は chars(数万)なので端数が来ないが、手元は tokens で同じ保証が無い。**戻さない**(PBI-0398 有界レビューで確定済み) |
 * | `missing-but-flagged-truncated` | `elements.0.truncated` / `truncated` / `hasTruncation` | ② 手元が良い | 上流は呼び手が渡した `truncated` をそのまま信じるので、**missing なのに切られた事になる**。手元は `kept < raw` から**自分で導く**ので呼び手が嘘を吐けない(fail-closed)。なおこの入力は上流の producer(`buildBootstrapInjectionStats`)は作らない |
 *
 * 語彙の違い（`chars`→`tokens` / `files`→`elements` / `per-file-limit`→`per-element-limit` /
 * `effectiveFileLimit`→`effectiveLimit` / `path` を持たない）は **③ 読み替えが理由**で、
 * `asOurs` が名前を移すところに畳んである(値は移していない)。
 * `effectiveBootstrapFileLimit` の `user.md` 4,000 字 cap → 要素別 cap
 * (`CONTEXT_ELEMENT_BUDGETS`)も ③。上の case は上流の cap 名(`user.md`)にも
 * 手元の要素名にも当たらない名前を使っているので、この差はここでは出ない。
 */
const EXPECTED_DIFFS: Record<string, string[]> = {
  "ac3-2files": [],
  "at-limit": [],
  "over-by-one": [],
  "zero-limit": [],
  "empty-elements": [],
  "negative-limit": [],
  // 上限が 0 に落ちるので、上限そのもの(2)と、そこから引く要素別 cap(3 箇所に同じ要素が出る)
  "fractional-limit": [
    "totals.elementMaxTokens",
    "totals.totalMaxTokens",
    "elements.0.effectiveLimit",
    "truncated.0.effectiveLimit",
    "nearLimitElements.0.effectiveLimit",
  ],
  // 手元の `truncated` 配列は**空**なので、上流の 1 件目そのものが差になる(`truncated.0`)
  "missing-but-flagged-truncated": ["elements.0.truncated", "truncated.0", "hasTruncation"],
};

describe("PBI-0401 上流 analyzeBootstrapBudget を実際に呼んで比べる", () => {
  // 下の表は `CASES` を両側に使うので、**case を消しても緑のまま覆いが減る**
  // (有界レビュー 2026-09-09 の攻撃 M5: 境界 5 件を消して規則も test も緑だった)。
  // AC-4 が数えている 8 ケースをここで名指しで固定する
  test("8 ケースが表から消えていない(消すと AC-3 / AC-4 が測られなくなる)", () => {
    expect(CASES.map((c) => c.name)).toEqual([
      "ac3-2files",
      "at-limit",
      "over-by-one",
      "zero-limit",
      "empty-elements",
      "negative-limit",
      "fractional-limit",
      "missing-but-flagged-truncated",
    ]);
  });

  // AC-3 / AC-4: 8 ケースの結果が並んで出る表。差は名指しで、上の 3 択に載っている物だけ
  test("差の表: 予期した差以外は 1 つも無い(新しい差が出たら赤)", () => {
    const table = CASES.map((c) => {
      const { up, ours } = runBoth(c);
      const d = diffPaths(up, ours).sort();
      return `${c.name}: ${d.length === 0 ? "一致" : d.join(",")}`;
    });
    console.log(`\n[PBI-0401] 上流 vs 手元\n${table.map((r) => `  ${r}`).join("\n")}\n`);
    expect(table).toEqual(
      CASES.map((c) => {
        const d = [...(EXPECTED_DIFFS[c.name] ?? [])].sort();
        return `${c.name}: ${d.length === 0 ? "一致" : d.join(",")}`;
      }),
    );
  });

  // AC-3 の名指しの入力は「一致」でなければならない(読み替えが破綻していない証拠)
  test("ac3-2files: 上流の返り値と手元の返り値が全 field 一致する", () => {
    const c = CASES.find((x) => x.name === "ac3-2files")!;
    const { up, ours } = runBoth(c);
    expect(ours).toEqual(up);
    // 上流が出した値そのもの(手で写していない)を、入力から言える算術で 3 点だけ押さえる
    expect(up.totals.truncatedTokens).toBe(75000 - 60000);
    expect(up.elements[0]!.nearLimit).toBe(true); // 25000 >= ceil(20000 * 0.85) = 17000
    expect(up.truncated.map((e) => e.name)).toEqual(["a.md", "b.md"]);
  });

  // ② と判定した 2 件は「上流に寄せない」が固定されている ——
  // 誰かが上流に合わせ直したらここが赤くなる
  test("normalizePositiveLimit: 0<v<1 は上流 0 / 手元 1。手元が良いので戻さない", () => {
    const { up, ours } = runBoth(CASES.find((x) => x.name === "fractional-limit")!);
    expect(up.totals.elementMaxTokens).toBe(0); // 上流: Math.floor(0.5)
    expect(up.totals.totalMaxTokens).toBe(0);
    expect(ours.totals.elementMaxTokens).toBe(1); // 手元: Math.max(1, Math.floor(0.5))
    expect(ours.totals.totalMaxTokens).toBe(1);
  });

  test("missing は切られない: 上流は呼び手の truncated を信じるが手元は自分で導く", () => {
    const { up, ours } = runBoth(CASES.find((x) => x.name === "missing-but-flagged-truncated")!);
    expect(up.hasTruncation).toBe(true); // 上流: 呼び手の嘘がそのまま通る
    expect(ours.hasTruncation).toBe(false); // 手元: kept < raw から導くので missing は切られない
    expect(ours.truncated).toEqual([]);
  });

  // 借りた実物が本当に上流の物か(header 3 行を除いた本文の byte)は 旧 diagrams-check が守る。
  // ここは「実物を呼んでいる」= stub に差し替わっていない事だけを見る
  test("呼んでいるのは写した実物(stub 化されていない)", () => {
    expect(analyzeBootstrapBudget.name).toBe("analyzeBootstrapBudget");
    const { up } = runBoth(CASES.find((x) => x.name === "ac3-2files")!);
    expect(up.totals.nearLimitRatio).toBe(CONTEXT_NEAR_LIMIT_RATIO); // 上流の 0.85 と同値
  });
});
