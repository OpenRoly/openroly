// PBI-0398 / CAP-3 B2: Context Resolver。**静的側(`packages/adapter/src/instructions.ts` の
// 管理ブロック)と動的側(`apps/server/src/dispatch.ts` の session instruction)の両方の前に立つ
// 1 関数**(direction §53-12 / §59.10 / §60.3)。図78 が正本。
//
// 不変条件は 2 つだけ:
//   1. **合計 ≤ 1,000 tokens**(REQ-83)。要素ごとの上限の和がそれで、超えた分は**切って
//      report に残す** —— 黙って落とさない(C11 #10・横断ルール 3)。
//   2. **静的側に work を入れない**(C11 #9)。identity / constraints / preferences / capabilities は
//      静的、current_work / pointers は動的。分離の正本は下の 2 つの配列で、
//      renderContext は渡された配列の要素しか書かない(呼び手が名前で足せない)。
//
// memory is addressable, not ambient(C11 #2): 常時 inject するのはこの ≤1,000 tokens だけで、
// 残りは pointers 経由で引く(引く側は CAP-7)。
//
// 上限の判定は **OpenClaw `src/agents/bootstrap-budget.ts`(MIT・240 行)を「file ごと」→
// 「要素ごと」に読み替えて port** した(`analyzeBootstrapBudget` /
// `buildBootstrapPromptWarningNotice` / `buildBootstrapTruncationReportMeta`)。
// 対応表: bootstrapMaxChars→elementMaxTokens・bootstrapTotalMaxChars→totalMaxTokens・
// USER.md の個別 cap→`CONTEXT_ELEMENT_BUDGETS` の要素別 cap・chars→tokens(概算)。
// 由来は THIRD_PARTY_NOTICES.md の OpenClaw 節。

/** 要素の並び。**total 予算はこの順に食う**(先に来る物が先に席を取る) */
export const CONTEXT_ELEMENTS = [
  "identity",
  "constraints",
  "preferences",
  "current_work",
  "capabilities",
  "pointers",
] as const;
export type ContextElement = (typeof CONTEXT_ELEMENTS)[number];

/** 要素ごとの上限(tokens)。**和 = 1,000 = REQ-83 の上限**(direction §60.3) */
export const CONTEXT_ELEMENT_BUDGETS: Record<ContextElement, number> = {
  identity: 100,
  constraints: 250,
  preferences: 250,
  current_work: 200,
  capabilities: 100,
  pointers: 100,
};

/** Context Package 全体の上限(tokens)。REQ-83。要素別の和と一致する事は test が固定する */
export const CONTEXT_TOTAL_BUDGET = 1000;

/** 「上限に近い」の閾値。OpenClaw の `DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO` と同じ値 */
export const CONTEXT_NEAR_LIMIT_RATIO = 0.85;

/** 静的側(管理ブロック projection)に載せてよい要素。**work はここに無い**(C11 #9) */
export const CONTEXT_STATIC_ELEMENTS = [
  "identity",
  "constraints",
  "preferences",
  "capabilities",
] as const satisfies readonly ContextElement[];

/** 動的側(session instruction)に載せる要素 */
export const CONTEXT_DYNAMIC_ELEMENTS = [
  "current_work",
  "pointers",
] as const satisfies readonly ContextElement[];

export type ContextTruncationCause = "per-element-limit" | "total-limit";

export interface ContextTruncationEntry {
  element: string;
  /** 切る前の token 概算 */
  original: number;
  /** 実際に載った token 概算 */
  kept: number;
  /** なぜ切れたか(cause の連結)。黙って落とさない為の 1 語 */
  reason: string;
}

export interface ResolvedContext {
  identity: string;
  constraints: string;
  preferences: string;
  current_work: string;
  capabilities: string;
  pointers: string;
  /** 載った 6 要素の token 概算の合計。**常に ≤ CONTEXT_TOTAL_BUDGET** */
  tokenEstimate: number;
  /** 切り詰めた要素だけが 1 行ずつ入る(切っていなければ空配列) */
  truncationReport: ContextTruncationEntry[];
  /**
   * **切る前の**材料が上限の 85% 以上あった要素(OpenClaw の nearLimit と同じ数え方)。
   * 溢れて切られた要素も入る —— 上流が「圧が掛かっている要素」を数える為の物で、
   * 「まだ切れていない物」の一覧ではない(有界レビュー 2026-09-09 で言い直した)。
   */
  nearLimit: string[];
}

export interface ContextInput {
  identity: string;
  constraints: string;
  preferences: string;
  currentWork: string;
  capabilities: string;
  pointers: string;
}

/** CJK(漢字・かな・全角記号・半角カナ)。英字の word 数では数えられない文字 */
const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/gu;

/**
 * 実 tokenizer が 1 token に飲む文字数の**上限側の目安**。これより密に割れる tokenizer は
 * まず無いので、「空白を除いた文字数 / これ」を概算の**床**に使う。
 */
const DENSE_CHARS_PER_TOKEN = 4;

/**
 * token の概算。**依存を足さない**(厳密 tokenizer は node_modules を増やす。CI に固定する検査は
 * この概算のまま — 測りたいのは「1,000 を超えない」であって tokenizer の正確さではない)。
 * 英字は空白区切り word × 1.3、CJK は 1 文字 1 token(OpenClaw は英字前提なので CJK 分を足した)。
 * **整数へ切り上げる**ので同じ入力に対して常に同じ値(冪等)。空文字 / 空白だけは 0。
 *
 * **概算は下から間違えてはいけない**。word 側だけだと、空白を 1 つも含まない材料
 * (URL・uuid・base64・改行の無い JSON・絵文字の列)は何万字あっても「1 語 = 2 tokens」になり、
 * 切られも報告もされないまま instruction に載る —— 「黙って落とさない」の裏返しで**黙って積む**。
 * 有界レビュー(2026-09-09)の実測: 10 万字 × 2 要素が `tokenEstimate = 6 / 1000`・
 * `truncationReport = []` で通り、実質 5 万 tokens(= 上限の 50 倍)が package に入った。
 * だから **「空白を除いた文字数 / DENSE_CHARS_PER_TOKEN」を床にする** —— 概算のままだが、
 * 必ず上限側へ倒れる。
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK);
  const cjkCount = cjk === null ? 0 : cjk.length;
  const words = text
    .replace(CJK, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  const byWord = Math.ceil(words * 1.3 + cjkCount);
  const dense = Math.ceil(text.replace(/\s+/gu, "").length / DENSE_CHARS_PER_TOKEN);
  return Math.max(byWord, dense);
}

/**
 * 上限 token に収まる**先頭からの**最長の prefix(OpenClaw と同じく「末尾から切る」——
 * 先頭に重要な文が来る前提)。`estimateTokens` が prefix 長に対して単調非減少なので
 * 二分探索で決める = **切った結果が必ず概算と整合する**(別々の数え方を持たない)。
 */
export function truncateToTokens(text: string, limitTokens: number): string {
  if (limitTokens <= 0) return "";
  if (estimateTokens(text) <= limitTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= limitTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd();
}

export interface ContextBudgetStat {
  name: string;
  rawTokens: number;
  keptTokens: number;
  /** 材料が無い要素(OpenClaw の `missing` file)。合計にも報告にも数えない */
  missing?: boolean;
}

export interface ContextBudgetElement extends ContextBudgetStat {
  effectiveLimit: number;
  nearLimit: boolean;
  truncated: boolean;
  causes: ContextTruncationCause[];
}

export interface ContextBudgetAnalysis {
  elements: ContextBudgetElement[];
  truncated: ContextBudgetElement[];
  nearLimitElements: ContextBudgetElement[];
  totalNearLimit: boolean;
  hasTruncation: boolean;
  totals: {
    rawTokens: number;
    keptTokens: number;
    truncatedTokens: number;
    elementMaxTokens: number;
    totalMaxTokens: number;
    nearLimitRatio: number;
  };
}

/**
 * OpenClaw `normalizePositiveLimit` の port(不正な上限は 1 に倒す = 全部切る側へ)。
 *
 * **1 箇所だけ上流と違える**(有界レビュー 2026-09-09 で上流 240 行と 1 行ずつ突き合わせた結果)。
 * 上流は `<= 0` だけを 1 に倒し、その後 `Math.floor` を掛けるので **0 < value < 1 が 0 になる**。
 * 上限 0 は「全部切る」ではなく「全要素が空文字になり、しかも `nearLimit` が
 * `raw >= ceil(0 * 0.85) = 0` で**常に true**」という、黙って全部消える壊れ方をする。
 * 上流は chars(数万)の設定値なので端数が来ないが、手元は tokens で同じ保証が無い。
 * 意図(「不正なら安全側の 1 へ」)は上流のコメントどおりなので、**意図の方に合わせる** ——
 * `Math.max(1, ...)` を掛ける。整数の上限(100 / 250 / 1000)では上流と 1 tokens も違わない。
 */
function normalizePositiveLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * OpenClaw `effectiveBootstrapFileLimit`(USER.md の個別 cap)の port = 要素別 cap。
 *
 * **名前は大小を潰してから引く。** 上流は `name.toLowerCase() === "user.md"` と綴っていて、
 * port した時にその 1 点だけ落としていた(有界レビュー 2026-09-09 = 3 択の ① 上流が正しい)。
 * `resolve` は `CONTEXT_ELEMENTS` の綴りしか渡さないが、この関数は export された
 * `analyzeContextBudget` の中に在るので、呼び手が `"Identity"` と綴った瞬間に
 * cap が外れて 100 → 1,000 tokens になる **fail-open** だった。
 */
function effectiveElementLimit(name: string, elementMaxTokens: number): number {
  const own = (CONTEXT_ELEMENT_BUDGETS as Record<string, number | undefined>)[name.toLowerCase()];
  return own === undefined ? elementMaxTokens : Math.min(elementMaxTokens, own);
}

/**
 * OpenClaw `analyzeBootstrapBudget` の port。**切る仕事はしない —— 分類だけ**
 * (上流も injection 側が切って、この関数は理由を付ける係)。
 * cause は 2 つ: `per-element-limit`(その要素自身が上限超え)と
 * `total-limit`(前の要素が食った後の残りが足りなかった)。
 */
export function analyzeContextBudget(params: {
  elements: ContextBudgetStat[];
  elementMaxTokens: number;
  totalMaxTokens: number;
  nearLimitRatio?: number;
}): ContextBudgetAnalysis {
  const elementMaxTokens = normalizePositiveLimit(params.elementMaxTokens);
  const totalMaxTokens = normalizePositiveLimit(params.totalMaxTokens);
  const nearLimitRatio =
    typeof params.nearLimitRatio === "number" &&
    Number.isFinite(params.nearLimitRatio) &&
    params.nearLimitRatio > 0 &&
    params.nearLimitRatio < 1
      ? params.nearLimitRatio
      : CONTEXT_NEAR_LIMIT_RATIO;

  let rawTokens = 0;
  let keptTokens = 0;
  let remainingTotal = totalMaxTokens;
  const elements = params.elements.map((el): ContextBudgetElement => {
    const effectiveLimit = effectiveElementLimit(el.name, elementMaxTokens);
    const availableTotal = remainingTotal;
    remainingTotal = Math.max(0, remainingTotal - el.keptTokens);
    if (el.missing === true) {
      return { ...el, effectiveLimit, nearLimit: false, truncated: false, causes: [] };
    }
    rawTokens += el.rawTokens;
    keptTokens += el.keptTokens;
    const truncated = el.keptTokens < el.rawTokens;
    const causes: ContextTruncationCause[] = [];
    if (truncated) {
      if (el.rawTokens > effectiveLimit) causes.push("per-element-limit");
      if (availableTotal < effectiveLimit && el.rawTokens > availableTotal) causes.push("total-limit");
    }
    return {
      ...el,
      effectiveLimit,
      nearLimit: el.rawTokens >= Math.ceil(effectiveLimit * nearLimitRatio),
      truncated,
      causes,
    };
  });

  const truncated = elements.filter((el) => el.truncated);
  return {
    elements,
    truncated,
    nearLimitElements: elements.filter((el) => el.nearLimit),
    totalNearLimit: keptTokens >= Math.ceil(totalMaxTokens * nearLimitRatio),
    hasTruncation: truncated.length > 0,
    totals: {
      rawTokens,
      keptTokens,
      truncatedTokens: Math.max(0, rawTokens - keptTokens),
      elementMaxTokens,
      totalMaxTokens,
      nearLimitRatio,
    },
  };
}

/**
 * **静的側・動的側の両方の前に立つ 1 関数**(C11 #23)。純関数 —— 材料の収集は呼び手(server)が
 * 持ち、ここは**引数だけ**を見る(AC-X1: 他の account の材料は引数に入らない限り出ない)。
 *
 * 各要素を要素別上限(かつ残りの合計上限)に収まるまで**末尾から切り詰め**、切った事実を
 * `truncationReport` に残す。空の材料はエラーではなく省略する(AC-X2)。
 */
export function resolve(input: ContextInput): ResolvedContext {
  const raw: Record<ContextElement, string> = {
    identity: input.identity ?? "",
    constraints: input.constraints ?? "",
    preferences: input.preferences ?? "",
    current_work: input.currentWork ?? "",
    capabilities: input.capabilities ?? "",
    pointers: input.pointers ?? "",
  };

  const kept = {} as Record<ContextElement, string>;
  const stats: ContextBudgetStat[] = [];
  let remainingTotal = CONTEXT_TOTAL_BUDGET;
  for (const name of CONTEXT_ELEMENTS) {
    const text = raw[name];
    const rawTokens = estimateTokens(text);
    // **要素別上限と「残りの合計」の小さい方**で切る。要素別の和 = 合計なので通常は前者が効くが、
    // 上の表を後から広げても合計 ≤ 1,000 は破れない(上限を 2 箇所で守る)
    const limit = Math.min(CONTEXT_ELEMENT_BUDGETS[name], remainingTotal);
    const value = rawTokens <= limit ? text : truncateToTokens(text, limit);
    const keptTokens = estimateTokens(value);
    remainingTotal = Math.max(0, remainingTotal - keptTokens);
    kept[name] = value;
    stats.push({ name, rawTokens, keptTokens, missing: text.trim() === "" });
  }

  const analysis = analyzeContextBudget({
    elements: stats,
    elementMaxTokens: CONTEXT_TOTAL_BUDGET, // 要素別 cap が常に効くので、一般 cap は合計と同値
    totalMaxTokens: CONTEXT_TOTAL_BUDGET,
  });

  return {
    ...kept,
    tokenEstimate: analysis.totals.keptTokens,
    truncationReport: analysis.truncated.map((el) => ({
      element: el.name,
      original: el.rawTokens,
      kept: el.keptTokens,
      reason: el.causes.length > 0 ? el.causes.join("+") : "per-element-limit",
    })),
    nearLimit: analysis.nearLimitElements.map((el) => el.name),
  };
}

/** 表示の幅(`current_work:` が一番長い語 + 1)。direction §60.3 の見た目 */
const LABEL_WIDTH = 14;

/**
 * Context Package の本文。**渡された要素しか書かない** —— 静的側は
 * `CONTEXT_STATIC_ELEMENTS` を渡すので、work は名前ごと入って来られない(C11 #9)。
 * 空の要素は行ごと省く(AC-X2)。複数行の材料は 2 行目以降を字下げして 1 要素に畳む。
 */
export function renderContext(ctx: ResolvedContext, elements: readonly ContextElement[]): string {
  const lines: string[] = [];
  for (const name of elements) {
    const value = ctx[name];
    if (value.trim() === "") continue;
    const body = value.split("\n").join(`\n${" ".repeat(LABEL_WIDTH)}`);
    lines.push(`${`${name}:`.padEnd(LABEL_WIDTH)}${body}`);
  }
  return lines.join("\n");
}

/**
 * OpenClaw `buildBootstrapPromptWarningNotice` の port。切った時だけ 1 つの注意書きを返す ——
 * **agent に「これは部分だ」と伝える**のが目的(黙って部分的な context を渡さない)。
 */
export function buildContextTruncationNotice(report: ContextTruncationEntry[]): string | undefined {
  if (report.length === 0) return undefined;
  return [
    "[Context truncation warning]",
    `Some context elements were truncated before injection: ${report.map((r) => r.element).join(", ")}.`,
    "Treat this context package as partial and fetch the details you need with the pointers above.",
  ].join("\n");
}

/**
 * OpenClaw `buildBootstrapTruncationReportMeta` の port。receipt(activity detail)に載せる
 * 1 object —— 「何要素切れたか」「次に溢れるのはどれか」が運用中に数えられる。
 */
export function buildContextTruncationMeta(ctx: ResolvedContext): {
  truncatedElements: number;
  nearLimitElements: number;
  totalNearLimit: boolean;
  tokenEstimate: number;
  elements: ContextTruncationEntry[];
} {
  return {
    truncatedElements: ctx.truncationReport.length,
    nearLimitElements: ctx.nearLimit.length,
    totalNearLimit: ctx.tokenEstimate >= Math.ceil(CONTEXT_TOTAL_BUDGET * CONTEXT_NEAR_LIMIT_RATIO),
    tokenEstimate: ctx.tokenEstimate,
    elements: ctx.truncationReport,
  };
}
