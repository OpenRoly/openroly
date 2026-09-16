// resume rate の集計(PBI-0464 / CAP-3 V19・docs/direction/ownership.md §11・§12)。
// 「Your work outlives the context」を DB の実運用で測る側。**判定そのもの(classifyResume)は
// `continuity-metrics.ts`**(bench と同じ物差しを使う)で、ここは work ごとに窓を切って数えるだけ。
// 経路は `scripts/metrics/resume-rate.ts`(DB を読んで `measureWork` を呼ぶ)。
//
// PBI-0614: この file は **JUDGE_FILES のどれにも入らない** —— ここを直しても bench の数字は動かない。
// (判定に効くのは classifyResume の側で、それは continuity-metrics.ts に在る)
//
// | 何 | 定義 |
// |---|---|
// | resume | ① `work_transfers.state = 'committed'` の COMMIT 時刻 ② `claimed` event のうち同じ work に**それより前の claimed が在る**物(= 前の holder が居た) |
// | 窓 | resume の時刻から次の resume まで(同じ work に resume が 2 回なら窓は重ならない) |

import { classifyResume, type ContinuityContextWrite, type ContinuityEvent, type ResumeClassification } from "./continuity-metrics.ts";
import { quantile } from "./stats.ts";

const byTime = (a: { at: Date }, b: { at: Date }) => a.at.getTime() - b.at.getTime();
export interface ContinuityTransfer {
  id: string;
  state: string;
  /** COMMIT した時刻(committed の行の updated_at) */
  updatedAt: Date;
}

export interface Resume {
  at: Date;
  via: "transfer" | "claim";
}
/** 式は stats.ts の 1 か所(PBI-0604)。偶数件で真ん中 2 つの平均 = 今までと同じ値 */
const median = (xs: number[]): number | null => quantile(xs, 0.5);

/**
 * 1 work の resume を時刻順に。transfer の COMMIT は同じ tx で `claimed`(payload.transfer_id 付き)も書くので、
 * transfer_id 付きの claimed は ① と同じ resume —— 2 回数えない。**初回の claim は resume ではない**(AC-3)。
 */
export function listResumes(input: { transfers: ContinuityTransfer[]; events: ContinuityEvent[] }): Resume[] {
  const out: Resume[] = input.transfers
    .filter((t) => t.state === "committed")
    .map((t) => ({ at: t.updatedAt, via: "transfer" }));
  const claims = input.events.filter((e) => e.kind === "claimed").sort(byTime);
  claims.forEach((c, i) => {
    if (i > 0 && !c.transferId) out.push({ at: c.at, via: "claim" });
  });
  return out.sort(byTime);
}
/** 1 work の全 resume を、次の resume までの窓で判定する(AC-X3: 2 回目の窓の event を 1 回目に数えない) */
export function measureWork(input: {
  transfers: ContinuityTransfer[];
  events: ContinuityEvent[];
  contextWrites: ContinuityContextWrite[];
}): { resume: Resume; result: ResumeClassification }[] {
  const resumes = listResumes(input);
  return resumes.map((resume, i) => ({
    resume,
    result: classifyResume({
      resumeAt: resume.at,
      events: input.events,
      contextWrites: input.contextWrites,
      nextResumeAt: resumes[i + 1]?.at ?? null,
    }),
  }));
}

export interface ResumeRateSummary {
  resumes: number;
  /** 有効な作業を始め、かつ説明し直しが無かった resume */
  noReexplanation: number;
  medianSecondsToUseful: number | null;
  withoutUsefulAction: number;
}

export function summarizeResumes(results: ResumeClassification[]): ResumeRateSummary {
  return {
    resumes: results.length,
    noReexplanation: results.filter((r) => r.firstUsefulAt !== null && !r.reexplained).length,
    medianSecondsToUseful: median(results.flatMap((r) => (r.secondsToUseful === null ? [] : [r.secondsToUseful]))),
    withoutUsefulAction: results.filter((r) => r.firstUsefulAt === null).length,
  };
}

/** stdout の 4 行。**0 件は 0% と書かない**(分母が無い物を率で言わない) */
export function formatResumeRate(s: ResumeRateSummary): string[] {
  const pct = s.resumes === 0 ? "n/a" : `${((100 * s.noReexplanation) / s.resumes).toFixed(1)}%`;
  const median = s.medianSecondsToUseful === null ? "n/a" : s.medianSecondsToUseful.toFixed(1);
  return [
    `resumes ${s.resumes}`,
    `no-reexplanation ${s.noReexplanation} (${pct})`,
    `median seconds to useful action ${median}`,
    `resumes without any useful action ${s.withoutUsefulAction}`,
  ];
}
