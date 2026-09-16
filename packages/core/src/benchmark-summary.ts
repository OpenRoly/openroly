// 本測定の集計(PBI-0568 / 0584 / 0603 / 0604 / 0605 / 0608・第 27 通 §9・図84 の節)。
// 判定した 1 run ずつ(continuity-metrics.ts)を升目の数字にする側 —— 台本の人の段・途切れ・
// 完了 1 件あたりの費用は全部ここ 1 か所で数える(表でも scenario でも割り算しない)。
//
// PBI-0614: この file は `JUDGE_FILES.matrix` / `.fidelity` に入り、**`.recovery` には入らない**。
// 費用や途切れの欄を足しても recovery の 30 run は測り直しにならない。

import {
  continuationSuccess,
  humanRecovered,
  ttua,
  zeroLoss,
  type ContinuityCase,
  type ContinuityRun,
} from "./continuity-metrics.ts";
import { distribution, type Dist } from "./stats.ts";

/** 公開する数字(通 §9)。0573 が README に出す */
export const BENCHMARK_METRICS = [
  "continuation_success",
  "time_to_useful_action",
  "human_recovery",
  "state_loss",
  "recovery_after_failed_handoff",
  "final_task_success",
  "cutoff_rate",
] as const;

export type BenchmarkMetric = (typeof BENCHMARK_METRICS)[number];
// ── 台本の人(PBI-0584 / 第 27 通 §9・図84 の節 0838)──
// lab の run に人は居ないので、上の humanRecovered は定義上 0 にしかならない。attended の run は target が止まった後に、
// 決まった台本の人が割り込む: 段 0 = 何もしない → 結果品質 ✗ なら段 1 = 中身の無い一押し → まだ ✗ なら段 2 = 説明し直し。
//
// | 段 | 意味 |
// |---|---|
// | 0 | 人は何も言わずに済んだ |
// | 1 | 一押し(Human nudge)で済んだ |
// | 2 | 説明し直しが要った(Human re-explanation)。段 2 の後も ✗ の run を含む |
// | null | 段の message を session に届けられなかった(attended_unreachable)。分母から外す —— 人の介入 0 と数えない |

export const HUMAN_STEPS = [0, 1, 2] as const;
export type HumanSteps = (typeof HUMAN_STEPS)[number];

/** 次に踏む段。finals = 段 0 から順の結果品質。最後が ✓ か、段 2 まで踏んだら null */
export function nextHumanStep(finals: readonly boolean[]): 1 | 2 | null {
  if (finals.length === 0 || finals.at(-1) || finals.length > 2) return null;
  return finals.length as 1 | 2;
}

/** 踏んだ段 = 台本の人(actor = user)の割り込みの数。PBI-0583 の自動の起こし直し(actor = system)は段に数えない */
export function humanStepsOf(interventions: readonly { actor: string }[]): HumanSteps {
  return Math.min(2, interventions.filter((i) => i.actor === "user").length) as HumanSteps;
}

/** 表の Human re-explanation の 1 run。attended(humanSteps が在る)は段 2 まで要ったか、無ければ 0464 の humanRecovered。null = 分母外 */
export function humanReexplained(run: ContinuityRun, caseSpec: ContinuityCase, humanSteps?: HumanSteps | null): boolean | null {
  if (humanSteps === undefined) return humanRecovered(run, caseSpec);
  return humanSteps === null ? null : humanSteps === 2;
}

export interface HumanLadderSummary {
  attended: number;
  unreachable: number;
  /** attended − unreachable */
  n: number;
  noHelp: number;
  nudge: number;
  reexplanation: number;
  /** 段 2 の後も結果品質 ✗(reexplanation の内数) */
  stillFailing: number;
}

/** finalTaskSuccess = 最後に踏んだ段の後の結果品質 */
export function summarizeHumanLadder(runs: readonly { humanSteps: HumanSteps | null; finalTaskSuccess: boolean | null }[]): HumanLadderSummary {
  const count = (pred: (r: (typeof runs)[number]) => boolean) => runs.filter(pred).length;
  const unreachable = count((r) => r.humanSteps === null);
  return {
    attended: runs.length,
    unreachable,
    n: runs.length - unreachable,
    noHelp: count((r) => r.humanSteps === 0),
    nudge: count((r) => r.humanSteps === 1),
    reexplanation: count((r) => r.humanSteps === 2),
    stillFailing: count((r) => r.humanSteps === 2 && r.finalTaskSuccess === false),
  };
}

// ── 途切れ(PBI-0603 / CAP-3・第 27 通 §9)──
// 「次の AI が tool を呼んだ直後に黙って止まった run が何回に 1 回か」。印は run 行が既に持っている
// `sessionEnd`(target の最初の session の終わり方・PBI-0583)で、**最後が tool の part** = model の返事が
// 来ないまま session が終わった —— continue guard(apps/server/src/dispatch.ts)が起こし直しを決めるのと同じ印。
// scenario の script では数えない(run 行 → summarize → 表の 1 本道)。
//
// | 何 | 定義 |
// |---|---|
// | 分母 | sessionEnd を記録した run。記録の無い行(0583 より前)は**外す** —— 途切れなかったと数えない |
// | 途切れ | `sessionEnd.lastPart` が tool |
// | 起こし直し | `guardRewake` = 1。**途切れた率とは別の欄**(片方に混ぜない)。記録が 1 件も無ければ unmeasured |

export interface SessionEnd {
  exit: number | null;
  lastPart: string | null;
  error: string | null;
}

/** 最後が tool の part = model の返事が来ないまま終わった */
export const sessionCutOff = (end: SessionEnd) => end.lastPart === "tool";

export interface CutoffSummary {
  /** sessionEnd を記録した run(率の分母) */
  n: number;
  cut: number;
  /** guardRewake を記録した run。0 = 起こし直しは unmeasured */
  rewakeN: number;
  rewoken: number;
  /** 起こし直した run のうち結果品質 ✓(判定の在る run だけ) */
  rewokenFinished: number;
}

export function summarizeCutoff(
  runs: readonly { sessionEnd?: SessionEnd | null; guardRewake?: 0 | 1; finalTaskSuccess?: boolean | null }[],
): CutoffSummary {
  const ended = runs.flatMap((r) => (r.sessionEnd ? [r.sessionEnd] : []));
  const rewake = runs.filter((r) => r.guardRewake !== undefined);
  const rewoken = rewake.filter((r) => r.guardRewake === 1);
  return {
    n: ended.length,
    cut: ended.filter(sessionCutOff).length,
    rewakeN: rewake.length,
    rewoken: rewoken.length,
    rewokenFinished: rewoken.filter((r) => r.finalTaskSuccess === true).length,
  };
}

// ── 完了 1 件あたりの費用(PBI-0605 / CAP-3・第 27 通 §9)──
// 「この仕事を 1 本終えるのに、PAAP なら X・会話履歴なら Y」。値は run 行が既に持っている
// `tokens`(target session の assistant message の和)と `credits`(週の値の run 前後)から作る。
// **表の script でも scenario でも割り算をしない** —— 割るのはここ 1 か所。
//
// | 何 | 定義 |
// |---|---|
// | 分子 | 消費を記録した**測った run 全部**の和(未完了の run が使った分も含む) |
// | 分母 | そのうち**完了した run**。未完了を分母に入れると、途中で諦める方式ほど安く見える |
// | 未完了の消費 | `wasted`(別の欄。完了 1 件あたりに混ぜない) |
// | unmeasured | runtime が消費を返さない run。分子にも分母にも入れない(0 と数えない) |
// | credit | 週の値の差(after − before)。負(窓が戻った・同じ鍵を他が使った)は unmeasured |
//
// PBI-0608: 入力 token は**どこがボトルネックか**を言えるよう由来に割る(`InputOrigins`)。実測(2026-09-15 impact-long)
// では渡す物が A 約 900 token・C 約 78,800 token = 88 倍違うのに、測った入力は 46,016 vs 66,806 = 1.45 倍しか
// 違わなかった —— 渡す物を小さくしても `fixed`(system prompt と tool 定義)は減らないから。
// 割るのも足すのもここ 1 か所で、**scenario でも表でも割り算しない**(0603〜0605 と同じ道)。

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** PBI-0608: input の由来。記録していない run は undefined(内訳だけ unmeasured —— 費用の分母からは外さない) */
  inputBy?: InputOrigins | null;
}

/**
 * PBI-0608: 入力 token の由来。**和は必ず `TokenUsage.input` と一致する** —— 配るのは測った値そのもので、
 * 見積もり(chars/4)が決めるのは 1 つの返事の中の比だけ。取る所は `scripts/live-lab.ts` の `opencodeTokens` 1 か所。
 *
 * | 欄 | 何 |
 * |---|---|
 * | passed | 渡した物(user message + handoff を運ぶ tool の出力)。方式 A は `work_accept` の出力がここに来る |
 * | fixed | system prompt と tool 定義。**渡す物を小さくしても減らない**(この PBI が名指したい所) |
 * | read | 相手が自分で読んだ file / command の出力 |
 * | other | 相手自身の発言・reasoning が context に積まれた分 |
 * | unknown | 由来を当てる part が 1 つも無い返事。0 と数えず、他の欄にも混ぜない |
 */
export interface InputOrigins {
  passed: number;
  fixed: number;
  read: number;
  other: number;
  unknown: number;
}

export interface CreditReading {
  before: { window: number; week: number };
  after: { window: number; week: number };
}

/** 数える 5 欄だけ。PBI-0608 の `inputBy` は数字ではないので、足し算・割り算の対象から**型で**外す */
type TokenCounts = Omit<TokenUsage, "inputBy">;

/** 5 つの欄を同じ式で。field 名を書き下すので `as` を通さない(欄が増えたら型で落ちる) */
const mapTokens = (f: (k: keyof TokenCounts) => number): TokenCounts => ({
  input: f("input"),
  output: f("output"),
  reasoning: f("reasoning"),
  cacheRead: f("cacheRead"),
  cacheWrite: f("cacheWrite"),
});
const sumTokens = (xs: readonly TokenUsage[]): TokenCounts => mapTokens((k) => xs.reduce((s, t) => s + t[k], 0));
const perEach = (t: TokenUsage, n: number): TokenCounts => mapTokens((k) => t[k] / n);

/** 内訳も同じ形で(欄が増えたら型で落ちる。`as` を通さない) */
const mapOrigins = (f: (k: keyof InputOrigins) => number): InputOrigins => ({
  passed: f("passed"),
  fixed: f("fixed"),
  read: f("read"),
  other: f("other"),
  unknown: f("unknown"),
});
const sumOrigins = (xs: readonly InputOrigins[]): InputOrigins => mapOrigins((k) => xs.reduce((s, o) => s + o[k], 0));

/** 週の値の差。負は unmeasured(同じ鍵を他が使うと混ざる・窓が戻る) */
export function creditsSpent(c: CreditReading): number | null {
  const d = c.after.week - c.before.week;
  return d < 0 ? null : d;
}

export interface CostSummary {
  /** 消費を記録した run が 1 件も無ければ null(unmeasured。0 と書かない) */
  tokens: {
    n: number;
    finished: number;
    total: TokenUsage;
    perFinished: TokenUsage | null;
    wasted: TokenUsage;
    /**
     * PBI-0608: 入力の内訳。**分母は tokens の n ではない** —— 消費は記録したが内訳を記録していない古い行が
     * 在るので、内訳を持つ run だけを数える。1 件も無ければ null = 内訳は unmeasured(0 と書かない)
     */
    inputBy: { n: number; finished: number; total: InputOrigins; perFinished: InputOrigins | null } | null;
  } | null;
  credits: { n: number; finished: number; total: number; perFinished: number | null; wasted: number } | null;
}

export function summarizeCost(
  runs: readonly { tokens?: TokenUsage | null; credits?: CreditReading | null; finalTaskSuccess?: boolean | null }[],
): CostSummary {
  const done = (r: { finalTaskSuccess?: boolean | null }) => r.finalTaskSuccess === true;
  const withTokens = runs.flatMap((r) => (r.tokens ? [{ v: r.tokens, done: done(r) }] : []));
  const withCredits = runs.flatMap((r) => {
    const spent = r.credits ? creditsSpent(r.credits) : null;
    return spent === null ? [] : [{ v: spent, done: done(r) }];
  });
  const tokensFinished = withTokens.filter((x) => x.done).length;
  const creditsFinished = withCredits.filter((x) => x.done).length;
  const tokenTotal = sumTokens(withTokens.map((x) => x.v));
  const creditTotal = withCredits.reduce((s, x) => s + x.v, 0);
  // PBI-0608: 内訳を記録した run だけが内訳の分母(消費は在るのに内訳が無い行を 0 と数えない)
  const withOrigins = withTokens.flatMap((x) => (x.v.inputBy ? [{ v: x.v.inputBy, done: x.done }] : []));
  const originsFinished = withOrigins.filter((x) => x.done).length;
  const originsTotal = sumOrigins(withOrigins.map((x) => x.v));
  return {
    tokens:
      withTokens.length === 0
        ? null
        : {
            n: withTokens.length,
            finished: tokensFinished,
            total: tokenTotal,
            perFinished: tokensFinished === 0 ? null : perEach(tokenTotal, tokensFinished),
            wasted: sumTokens(withTokens.filter((x) => !x.done).map((x) => x.v)),
            inputBy:
              withOrigins.length === 0
                ? null
                : {
                    n: withOrigins.length,
                    finished: originsFinished,
                    total: originsTotal,
                    perFinished: originsFinished === 0 ? null : mapOrigins((k) => originsTotal[k] / originsFinished),
                  },
          },
    credits:
      withCredits.length === 0
        ? null
        : {
            n: withCredits.length,
            finished: creditsFinished,
            total: creditTotal,
            perFinished: creditsFinished === 0 ? null : creditTotal / creditsFinished,
            wasted: withCredits.filter((x) => !x.done).reduce((s, x) => s + x.v, 0),
          },
  };
}
export interface BenchmarkSummary {
  runs: number;
  unmeasured: number;
  /** 率は 0〜1。測った run が 0 件なら null(分母が無い物を 0% と言わない) */
  metrics: Record<BenchmarkMetric, number | null>;
  /** PBI-0603: 途切れの内訳(率は metrics.cutoff_rate・起こし直しは別の欄) */
  cutoff: CutoffSummary;
  /** PBI-0604: 中央値だけでは隠れる裾。metrics の値は p50 と同じ物 */
  dist: { time_to_useful_action: Dist | null };
  /** PBI-0605: 完了 1 件あたりの費用(分子は未完了の消費も含む・分母は完了した run) */
  cost: CostSummary;
}

/** 1 run 分の入れ物。run 行(MatrixRow)が持つ物のうち、判定に要る物だけ */
export interface BenchmarkInput {
  run: ContinuityRun;
  caseSpec: ContinuityCase;
  finalTaskSuccess?: boolean | null;
  humanSteps?: HumanSteps | null;
  /** PBI-0583 が記録した session の終わり方。記録していない行 = undefined(途切れの分母から外れる) */
  sessionEnd?: SessionEnd | null;
  /** PBI-0583 の continue guard が起こし直した回数。記録していない行 = undefined */
  guardRewake?: 0 | 1;
  /** PBI-0605: target session の token。runtime が返さない run は null(費用の分母外) */
  tokens?: TokenUsage | null;
  /** PBI-0605: run の前後の credit(週)。口の無い runtime は null */
  credits?: CreditReading | null;
}

/**
 * `humanSteps`(PBI-0584)を持つ run は human_recovery を台本の段で数え、null(届けられなかった)は human_recovery の分母から外す。
 * **recovery_after_failed_handoff はここでは常に null** —— 失敗注入の bench(0571)は別の JSON で、表(PBI-0613)が
 * その JSON から直に読み、古さも別に判定する。ここから summarizeRecovery を呼ぶと**判定集合が繋がり**、
 * 費用の欄を足しただけで recovery の 30 run が測り直しになる(PBI-0614)
 */
export function summarizeBenchmark(runs: BenchmarkInput[]): BenchmarkSummary {
  const measured = runs.filter((r) => r.run.actions !== null);
  const rate = (pred: (r: (typeof runs)[number]) => boolean) =>
    measured.length === 0 ? null : measured.filter(pred).length / measured.length;
  const human = measured.flatMap((r) => {
    const v = humanReexplained(r.run, r.caseSpec, r.humanSteps);
    return v === null ? [] : [v];
  });
  // 結果品質の判定(0572 の judgeQuality)が付いた run だけが分母。1 件も無ければ null = 測っていない
  const judged = measured.flatMap((r) => (typeof r.finalTaskSuccess === "boolean" ? [r.finalTaskSuccess] : []));
  const cutoff = summarizeCutoff(measured);
  // 中央値 1 つでは「10 回に 1 回 2 分待たされた」が隠れる(PBI-0604)。時間が取れなかった run は分母外(0 秒と数えない)
  const dist = {
    time_to_useful_action: distribution(
      measured.flatMap((r) => {
        const s = ttua(r.run, r.caseSpec);
        return s === null ? [] : [s];
      }),
    ),
  };
  return {
    runs: runs.length,
    unmeasured: runs.length - measured.length,
    cutoff,
    dist,
    cost: summarizeCost(measured),
    metrics: {
      continuation_success: rate((r) => continuationSuccess(r.run, r.caseSpec)),
      time_to_useful_action: dist.time_to_useful_action?.p50 ?? null,
      human_recovery: human.length === 0 ? null : human.filter(Boolean).length / human.length,
      state_loss: rate((r) => !zeroLoss(r.run)),
      recovery_after_failed_handoff: null,
      final_task_success: judged.length === 0 ? null : judged.filter(Boolean).length / judged.length,
      cutoff_rate: cutoff.n === 0 ? null : cutoff.cut / cutoff.n,
    },
  };
}

