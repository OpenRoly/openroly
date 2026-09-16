// Recovery after failed handoff の判定(PBI-0571 / 第 27 通 §6・spec I-7・図84 の節)。
// **この file の中身が `JUDGE_FILES.recovery` の版**(PBI-0614) —— ここが変わった時だけ
// recovery の数字は測り直しになる。費用・途切れ・fidelity の集計(benchmark-summary.ts)を
// 直しても recovery は古くならない(2026-09-16: PBI-0608 の費用の内訳で recovery の行が
// 🚧 になったのが、同居していた事の実害)。

// 失敗を注入した handoff の後に、checkpoint が残り(I-7)、人の continue 1 回で仕事を取り戻せたか。
// normal は分母の対照(injected に入れない)。usage_limit は源が止まる注入なので handoff 自体は committed でよい。
//
// | 判定 | 定義 |
// |---|---|
// | injection_missed | 注入の口が撃てていない、または handoff を失敗させる 4 種で handoff が failed にならなかった(kill 前に committed 等)。分母外 |
// | lost: no_checkpoint | 注入した handoff が名指した checkpoint(capsule 版)が残っていない(I-7 違反) |
// | lost: claim_failed | committed の handoff が 1 本も無い(取り戻しの continue が仕事を渡せなかった) |
// | lost: recovery_failed | 仕事を受け取った target が continuationSuccess でない |
// | recovered | 上のどれでもない |

import { continuationSuccess, zeroLoss, type ContinuityCase, type ContinuityRun } from "./continuity-metrics.ts";

export const FAILURE_INJECTIONS = [
  "normal",
  "usage_limit",
  "process_kill",
  "network_cut",
  "target_start_fail",
  "handoff_timeout",
] as const;

export type FailureInjection = (typeof FAILURE_INJECTIONS)[number];

/** handoff 自体を失敗させる注入。handoff が failed にならなければ注入が効いていない */
export const HANDOFF_FAILURE_INJECTIONS = [
  "process_kill",
  "network_cut",
  "target_start_fail",
  "handoff_timeout",
] as const satisfies readonly FailureInjection[];

export const RECOVERY_LOSS_STAGES = ["no_checkpoint", "claim_failed", "recovery_failed"] as const;

export type RecoveryLossStage = (typeof RECOVERY_LOSS_STAGES)[number];

export interface RecoveryRun {
  injection: FailureInjection;
  /** 注入の口が撃てたか(kill する PID が在った・網を切れた・stall を書けた)。normal は true */
  fired: boolean;
  /** 注入した handoff の最終 state と reason。handoff が立たなかった時 null */
  handoff: { state: string; reason: string | null } | null;
  /** I-7: 注入した handoff が名指した checkpoint(capsule 版)が残っている */
  checkpointKept: boolean;
  /** committed の handoff で仕事を受け取った target の run。受け取った target が居なければ null */
  recovery: { run: ContinuityRun; caseSpec: ContinuityCase } | null;
  /** Z.AI 429 等。分母から外す */
  unmeasured: string | null;
}

export type RecoveryVerdict =
  | { kind: "unmeasured"; reason: string }
  | { kind: "injection_missed" }
  | { kind: "recovered" }
  | { kind: "lost"; stage: RecoveryLossStage };

export function judgeRecovery(r: RecoveryRun): RecoveryVerdict {
  if (r.unmeasured !== null) return { kind: "unmeasured", reason: r.unmeasured };
  if (r.handoff === null) return { kind: "unmeasured", reason: "handoff did not start" };
  if (r.recovery !== null && r.recovery.run.actions === null) return { kind: "unmeasured", reason: "no tool-call log" };
  const failsHandoff = (HANDOFF_FAILURE_INJECTIONS as readonly string[]).includes(r.injection);
  if (!r.fired || (failsHandoff && r.handoff.state !== "failed")) return { kind: "injection_missed" };
  if (!r.checkpointKept) return { kind: "lost", stage: "no_checkpoint" };
  if (r.recovery === null) return { kind: "lost", stage: "claim_failed" };
  // handoff が committed なだけでは取り戻しではない —— 受け取った target が正しい続きを始めた時だけ
  return continuationSuccess(r.recovery.run, r.recovery.caseSpec) ? { kind: "recovered" } : { kind: "lost", stage: "recovery_failed" };
}

export interface RecoveryRow {
  runs: number;
  unmeasured: number;
  missed: number;
  /** 注入した handoff の最終 state ごとの件数(failed は `failed:<reason>`) */
  states: Record<string, number>;
  checkpointKept: number;
  recovered: number;
  zeroLoss: number;
  lost: Record<RecoveryLossStage, number>;
}

export interface RecoverySummary {
  rows: Record<FailureInjection, RecoveryRow>;
  /** normal を除き、unmeasured / injection_missed を外した run */
  injected: number;
  recoverable: number;
  lost: number;
  /** 0〜1。injected が 0 なら null(分母が無い物を 0% と言わない) */
  rate: number | null;
}

export function summarizeRecovery(runs: RecoveryRun[]): RecoverySummary {
  const rows = Object.fromEntries(
    FAILURE_INJECTIONS.map((i) => [
      i,
      { runs: 0, unmeasured: 0, missed: 0, states: {}, checkpointKept: 0, recovered: 0, zeroLoss: 0, lost: { no_checkpoint: 0, claim_failed: 0, recovery_failed: 0 } },
    ]),
  ) as Record<FailureInjection, RecoveryRow>;
  let injected = 0;
  let recoverable = 0;
  for (const r of runs) {
    const row = rows[r.injection];
    row.runs++;
    if (r.handoff) {
      const key = r.handoff.state === "failed" && r.handoff.reason ? `failed:${r.handoff.reason}` : r.handoff.state;
      row.states[key] = (row.states[key] ?? 0) + 1;
    }
    const v = judgeRecovery(r);
    if (v.kind === "unmeasured") row.unmeasured++;
    if (v.kind === "injection_missed") row.missed++;
    if (v.kind !== "recovered" && v.kind !== "lost") continue;
    if (r.checkpointKept) row.checkpointKept++;
    if (r.recovery && zeroLoss(r.recovery.run)) row.zeroLoss++;
    if (v.kind === "recovered") row.recovered++;
    else row.lost[v.stage]++;
    if (r.injection !== "normal") {
      injected++;
      if (v.kind === "recovered") recoverable++;
    }
  }
  return { rows, injected, recoverable, lost: injected - recoverable, rate: injected === 0 ? null : recoverable / injected };
}

/** 種ごとに 1 行 + 集計 4 行(PBI-0571 AC-1)。n = unmeasured / injection_missed を外した件数 */
export function formatRecovery(s: RecoverySummary): string[] {
  const rows = FAILURE_INJECTIONS.map((i) => {
    const r = s.rows[i];
    const n = r.runs - r.unmeasured - r.missed;
    const states = Object.keys(r.states).sort().map((k) => `${k} ${r.states[k]}`).join(", ") || "-";
    const lost = RECOVERY_LOSS_STAGES.filter((st) => r.lost[st] > 0).map((st) => `${st} ${r.lost[st]}`).join(", ");
    return [
      `${i}: runs ${r.runs}`,
      `states [${states}]`,
      `I-7 ${r.checkpointKept}/${n}`,
      `recovered ${r.recovered}/${n}`,
      `zero-loss ${r.zeroLoss}/${n}`,
      ...(lost ? [`lost (${lost})`] : []),
      ...(r.missed ? [`injection_missed ${r.missed}`] : []),
      ...(r.unmeasured ? [`unmeasured ${r.unmeasured}`] : []),
    ].join(" · ");
  });
  return [
    ...rows,
    `handoff failure injected: ${s.injected}`,
    `work recoverable: ${s.recoverable}`,
    `work lost: ${s.lost}`,
    `Recovery success: ${s.rate === null ? "n/a" : `${(100 * s.rate).toFixed(1)}%`}`,
  ];
}
