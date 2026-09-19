// PBI-0657 / CAP-3 V22: Run の判定(第 32 通 §43・§48・§54〜§56)。
// Work は engine を 1 つ持つのではなく **Run の列**を持つ。Run = runtime + provider + host + session の組
// (spec/06 §1)で、**write_scope が「その Run が何を壊せるか」**を言う。
//
// 保存面(migration 064)が Invariant #3(生きている primary は work ごと 1 本)を partial unique index で
// 潰すので、ここに同じ判定を **書かない** —— 2 枚になった瞬間、口が増えた時に片方だけ直る。
// ここに在るのは index が答えられない事だけ: 「この run は lease holder を名乗ってよいか」と
// 「この status 遷移は許されるか」。
//
// 値集合は上流(workboard-contract)に無い —— `third_party/openclaw/` の contract に `run` の語は 0 件。
// working / blocked / idle の意味論だけ Herdr から借りた(code は取っていない)。

/** run の状態 6 値。migration 064 の runs_status_check と同じ並び(value-sets-check.ts が同値を測る) */
export const RUN_STATUSES = ["starting", "working", "blocked", "idle", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 書き込み範囲 3 値。primary = work の write lease を持つ / isolated = 自分の枝だけ / readonly = 読むだけ(V8 の reviewer) */
export const RUN_WRITE_SCOPES = ["primary", "isolated", "readonly"] as const;
export type RunWriteScope = (typeof RUN_WRITE_SCOPES)[number];

/** 終端 2 値。**partial unique index が index から外す集合と同じ**(片方だけ増やすと invariant が緩む) */
export const RUN_TERMINAL_STATUSES = ["done", "failed"] as const satisfies readonly RunStatus[];

export const isRunOver = (status: string): boolean =>
  (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);

export type RunStatusDecision =
  | { ok: true }
  | { ok: false; reason: "unknown_status" | "run_over" };

/**
 * status 遷移。分岐はこの 1 関数だけ(route は reason を code に写す)。規則は 2 つ:
 *  1. 知らない値は通さない(fail-closed。DB の check より前に 422 で返す為)
 *  2. **終端は終端** —— done / failed から先へは動けない(自分自身へも)。
 *     終わった run が働き出すと「経過分」も履歴も嘘になり、index から外れた行が primary に戻る窓が開く
 * 生きている値どうしは自由に動ける(starting → blocked → working → idle …)。順序を決め打ちすると
 * runtime ごとに違う立ち上がり方を全部書く事になり、増えた runtime で必ず片方が腐る
 */
export function decideRunStatus(from: string, to: string): RunStatusDecision {
  if (!(RUN_STATUSES as readonly string[]).includes(to)) return { ok: false, reason: "unknown_status" };
  if (isRunOver(from)) return { ok: false, reason: "run_over" };
  return { ok: true };
}

/** work の形から、その lease を握る Run の write_scope を決める(正本: docs/direction/control-plane.md 改-7 ①)。
 *   primary  = 親 Work の lease holder(その project の作業ツリーを書く)
 *   isolated = 子 Work の lease(PBI-0434 / 0447 の task 用 folder。親の作業ツリーは書かない)
 *   readonly = V8 の reviewer(枝は見るだけ・元の Work には触れない)
 *
 * **新しい振る舞いを足さない** —— 今の実装が既にしている事(task は別 folder・reviewer は blind)を
 * run の行で言い直すだけ。だから既存の test は緑のまま(PBI-0657 AC-X1)
 */
export function writeScopeForWork(work: {
  parentWorkId: string | null;
  contextProfile: string | null;
}): RunWriteScope {
  if (work.contextProfile === "reviewer_blind") return "readonly";
  if (work.parentWorkId !== null) return "isolated";
  return "primary";
}

export type PrimaryDecision =
  | { ok: true }
  | { ok: false; reason: "not_primary_work" | "run_over" | "other_work" | "lease_held" };

/**
 * その Run が work の primary WRITE を名乗ってよいか(§44「lease holder = primary の run だけ」)。
 * 判定順序は狭い方から: 生死 → 相手の work → work の形 → lease の持ち主。
 *
 * **数は数えない** —— 「生きている primary は work ごと 1 本」は migration 064 の partial unique index
 * だけが守る(ここで先に数えると index を外しても緑になり、index が一度も測られなくなる)。
 * ここが答えるのは index が答えられない事だけ: 終わった run か・別の work の run か・
 * そもそも primary を持てない形の work か・lease を別の run が握っているか。
 *
 * `lease_held` は「**別の** run が握っている」だけを意味する(自分が holder なら ok = 再送は冪等)。
 */
export function canHoldPrimary(
  work: { id: string; parentWorkId: string | null; contextProfile: string | null; leaseHolderRun: string | null },
  run: { id: string; workId: string | null; status: string },
): PrimaryDecision {
  if (isRunOver(run.status)) return { ok: false, reason: "run_over" };
  if (run.workId !== work.id) return { ok: false, reason: "other_work" };
  if (writeScopeForWork(work) !== "primary") return { ok: false, reason: "not_primary_work" };
  if (work.leaseHolderRun !== null && work.leaseHolderRun !== run.id) return { ok: false, reason: "lease_held" };
  return { ok: true };
}
