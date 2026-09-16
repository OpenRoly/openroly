// 続き(continuity)の判定そのもの(PBI-0464 / 0568 / CAP-3・第 27 通 docs/direction/benchmark.md §2・§7・§9・図84 の節)。
// **1 run / 1 resume を ✓ か ✗ に決める所だけ**を持つ —— 集計(benchmark-summary.ts)・recovery
// (recovery-metrics.ts)・DB の resume rate(resume-metrics.ts)は別の file に在る。
//
// PBI-0614: この分け方が `JUDGE_FILES` の単位そのもの。**file の中身 hash = 判定の振る舞いの版**なので、
// 判定に効かないコードをここに同居させない(同居させると、無関係な追加で測った数字が「古い」になる)。
// LLM を審判にしない —— target runtime の tool-call 列と、case ごとの有効集合で決定的に決める。
// **runtime 種別は引数に無い**(AC-X1)。
//
// | 指標 | 定義 |
// |---|---|
// | 説明し直し(resume) | resume から有効な作業まで(無ければ窓の終わりまで)に actor = **user** の `comment_added` / `specified`、または user の `goal` / `next_step` / `decisions` put が 1 件でも在る |
// | 有効 action | `say` 以外(read / exec / edit / tool)で target が case の usefulTargets に在る最初の 1 つ。発言だけは続きではない |
// | TTUA | 有効 action の時刻 − t0(handoff 開始)。無ければ null |
// | human recovery | 0464 の classifyResume と同じ判定(t0 から有効 action までに user の goal / next_step / decisions 編集か message) |
// | continuation success | 有効 action が在る かつ human recovery でない |
// | state loss | 8 カテゴリのうち source に値が在る field が target の見た物に無い。zero loss は加えて元 checkpoint が残る(I-7) |
// | unmeasured | tool-call log が取れない run。集計の分母から外す(0 秒・失敗・loss に数えない) |
//
// 説明し直しの proxy は**低く出る側**に倒す(user の「ありがとう」も説明し直しに数える)。高く見せる方向の調整はしない。
// context の書き込みは `work_context` の行ではなく **`edited` event の `payload.context`**(putWorkContext が同じ tx で
// 書き手の actor 付きで書く)から作る —— 行は key ごとに最新 1 行で updated_at が後の上書きで動くので、user の put も
// 前の resume の auto/* も消える(review の実測 = apps/server/test/resume-rate-attack.test.ts)。

import type { WorkEventKind } from "./work.ts";

export interface ContinuityEvent {
  kind: string;
  actor: string;
  at: Date;
  /** `claimed` の payload.transfer_id(transfer の COMMIT が同じ tx で書く)。それ以外は null */
  transferId?: string | null;
}

export interface ContinuityContextWrite {
  kind: string;
  key: string;
  actor: string;
  at: Date;
}
export interface ResumeClassification {
  reexplained: boolean;
  firstUsefulAt: Date | null;
  secondsToUseful: number | null;
}

export const USEFUL_RUN_EVENT_KINDS = [
  "attempt_started",
  "attempt_updated",
  "artifact_added",
  "proof_added",
  "execution_updated",
] as const satisfies readonly WorkEventKind[];

export const REEXPLAIN_USER_EVENT_KINDS = ["comment_added", "specified"] as const satisfies readonly WorkEventKind[];

export const REEXPLAIN_CONTEXT_KEYS = ["goal", "next_step", "decisions"] as const;

const includes = (list: readonly string[], v: string) => list.includes(v);
const byTime = (a: { at: Date }, b: { at: Date }) => a.at.getTime() - b.at.getTime();
/** resume 1 件の判定。窓 = [resumeAt, nextResumeAt)(next が無ければ終わり無し) */
export function classifyResume(input: {
  resumeAt: Date;
  events: ContinuityEvent[];
  contextWrites: ContinuityContextWrite[];
  nextResumeAt?: Date | null;
}): ResumeClassification {
  const start = input.resumeAt.getTime();
  const end = input.nextResumeAt ? input.nextResumeAt.getTime() : Number.POSITIVE_INFINITY;
  const inWindow = (at: Date) => at.getTime() >= start && at.getTime() < end;

  const useful = [
    ...input.events.filter((e) => e.actor === "run" && includes(USEFUL_RUN_EVENT_KINDS, e.kind)).map((e) => e.at),
    ...input.contextWrites
      .filter((w) => w.kind === "context" && w.key.startsWith("auto/") && (w.actor === "run" || w.actor === "server"))
      .map((w) => w.at),
  ]
    .filter(inWindow)
    .sort((a, b) => a.getTime() - b.getTime());
  const firstUsefulAt = useful[0] ?? null;

  // 説明し直しは「有効な作業より前」だけ。作業が始まった後の user の comment は説明し直しではない
  const until = firstUsefulAt ? firstUsefulAt.getTime() : end;
  const beforeUseful = (at: Date) => at.getTime() >= start && at.getTime() < until;
  const reexplained =
    input.events.some((e) => e.actor === "user" && includes(REEXPLAIN_USER_EVENT_KINDS, e.kind) && beforeUseful(e.at)) ||
    input.contextWrites.some(
      (w) => w.actor === "user" && w.kind === "context" && includes(REEXPLAIN_CONTEXT_KEYS, w.key) && beforeUseful(w.at),
    );

  return {
    reexplained,
    firstUsefulAt,
    secondsToUseful: firstUsefulAt ? (firstUsefulAt.getTime() - start) / 1000 : null,
  };
}
export type ContinuityActionKind = "read" | "exec" | "edit" | "say" | "tool";

export interface ContinuityAction {
  at: Date;
  kind: ContinuityActionKind;
  /** file の path・実行した command・issue。say は発言 */
  target?: string;
}

export interface ContinuityUserEvent {
  at: Date;
  kind: "edit" | "message";
  /** edit の context key */
  key?: string;
}

export interface ContinuityRun {
  /** handoff 開始 */
  t0: Date;
  /** target runtime の tool-call 列。log が取れなければ null = unmeasured */
  actions: ContinuityAction[] | null;
  /** 元 checkpoint(spec §4.4 の field 名そのまま) */
  sourceCheckpoint: { work_id: string; content_hash: string; body: Record<string, unknown> };
  /** target が受け取った field 名(brief の section = body field 名 + work_id / content_hash) */
  targetView: string[];
  /** handoff 後の人の編集・message */
  userEvents: ContinuityUserEvent[];
  checkpointStillPresent: boolean;
}

export interface ContinuityCase {
  /** 正しい file・必要な test・goal の issue */
  usefulTargets: readonly string[];
}

/** 通 §7 の 8 カテゴリ → spec の field 名(work_id / content_hash は checkpoint の上の段・他は body) */
export const STATE_LOSS_FIELDS = {
  work: "work_id",
  checkpoint: "content_hash",
  git_changes: "git_state",
  decisions: "decisions",
  failed_attempts: "failed_attempts",
  artifacts: "relevant_artifacts",
  open_questions: "unresolved_questions",
  capability_requirements: "capability_requirements",
} as const;

export type StateLossCategory = keyof typeof STATE_LOSS_FIELDS;

export function firstUsefulAction(run: ContinuityRun, caseSpec: ContinuityCase): ContinuityAction | null {
  const useful = (run.actions ?? []).filter(
    (a) =>
      a.kind !== "say" &&
      a.target !== undefined &&
      caseSpec.usefulTargets.includes(a.target) &&
      a.at.getTime() >= run.t0.getTime(),
  );
  return useful.sort(byTime)[0] ?? null;
}

export function ttua(run: ContinuityRun, caseSpec: ContinuityCase): number | null {
  const a = firstUsefulAction(run, caseSpec);
  return a ? (a.at.getTime() - run.t0.getTime()) / 1000 : null;
}

/** 0464 の判定をそのまま使う(同じ run で resume-rate と食い違わない)。有効 action を run の進捗として渡す */
export function humanRecovered(run: ContinuityRun, caseSpec: ContinuityCase): boolean {
  const useful = firstUsefulAction(run, caseSpec);
  return classifyResume({
    resumeAt: run.t0,
    events: [
      ...(useful ? [{ kind: "attempt_started", actor: "run", at: useful.at }] : []),
      ...run.userEvents.filter((e) => e.kind === "message").map((e) => ({ kind: "comment_added", actor: "user", at: e.at })),
    ],
    contextWrites: run.userEvents.flatMap((e) =>
      e.kind === "edit" && e.key ? [{ kind: "context", key: e.key, actor: "user", at: e.at }] : [],
    ),
  }).reexplained;
}

export function continuationSuccess(run: ContinuityRun, caseSpec: ContinuityCase): boolean {
  return firstUsefulAction(run, caseSpec) !== null && !humanRecovered(run, caseSpec);
}
const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "" && !(typeof v === "object" && Object.keys(v).length === 0);

/** source に無かった物は落としようが無いので lost に数えない。順は STATE_LOSS_FIELDS の順 */
export function stateLoss(run: Pick<ContinuityRun, "sourceCheckpoint" | "targetView">): StateLossCategory[] {
  const cp = run.sourceCheckpoint;
  return (Object.keys(STATE_LOSS_FIELDS) as StateLossCategory[]).filter((cat) => {
    const field = STATE_LOSS_FIELDS[cat];
    const value = field === "work_id" || field === "content_hash" ? cp[field] : cp.body[field];
    return hasValue(value) && !run.targetView.includes(field);
  });
}

export function zeroLoss(run: ContinuityRun): boolean {
  return stateLoss(run).length === 0 && run.checkpointStillPresent;
}

