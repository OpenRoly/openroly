// PBI-0408 / CAP-3 V3: 30 秒 tick + 重要 event で checkpoint を打つ「裏」。
//
// **打つのは runtime の気まぐれではない**(C4 #27)。MCP server は runtime(LLM の推論ループ)とは
// 別の OS process で、stdio が閉じるまで動き続ける —— rate limit で runtime 自身が答えなくなっても、
// この tick は git の外側の事実(objective state)を見るだけなので**runtime に何も尋ねない**。
// LLM summarization はしない(current_state 等の自己申告 field はここでは一切触らない)。
//
// 経路は 0406 の capsule 口をそのまま再利用する(`tools.work_capsule` → buildCapsule → server の
// dedupe/heartbeat)。この file は「いつ・何を」呼ぶかだけを持ち、壁(hasKeyDeep)や dedupe
// (content_hash)を作り直さない。
import { gcCheckpoints, readCasPayload } from "@openroly/adapter";
import { isTransferHolderId } from "@openroly/core";
import type { AccountTools } from "./tools.ts";
import { computeGitState } from "@openroly/core/node";
import { runAutoContext } from "./auto-context.ts";

/**
 * PBI-0596: **版は前の版を引き継がない**(`pushCapsule` → `buildCapsule` は渡された field だけで版を作る)。
 * 自動の書き手が `git_state` だけの版を積むと、その版が最新になり、受け取り側が読む**1 つの版**
 * (`openroly continue` の `caps.at(-1)` / `work_accept` の transfer の版)から goal / next_step が消える ——
 * Claude が死んだ後に OpenCode が受け取っても「何の仕事か」が無い。
 *
 * 当て方は rollback の「先に固める」(`apps/cli/src/openroly.ts` = 最新版の他の要素はそのまま・git_state
 * だけ今)に揃える。前の版がこの端末の CAS に無い(別端末が積んだ / GC 済み)時は今までどおり git_state だけ
 * ——**ここで throw しない**(tick は 30 秒ごとの機会を 1 回の読み損ねで失わない)。
 */
async function capsuleFieldsWithGitState(
  tools: AccountTools,
  workId: string,
  gitState: unknown,
): Promise<Record<string, unknown>> {
  const caps = (await tools.work_capsules(workId).catch(() => [])) as { body?: { payload_hash?: unknown } | null }[];
  const hash = caps.at(-1)?.body?.payload_hash;
  const previous = typeof hash === "string" ? await readCasPayload(hash).catch(() => null) : null;
  return { ...(previous ?? {}), git_state: gitState };
}

export type CheckpointTickResult =
  | { pushed: false; reason: "no_active_work" | "not_a_git_worktree" | "ambiguous_work" | "transfer_in_progress" }
  | { pushed: true; workId: string };

/**
 * 1 回分の tick(手動呼び出しにも interval にも使う純粋な単位)。**runtime へは何も聞かない** ——
 * 使うのは `work_current`(lease だけで選ぶ既存の口)と `computeGitState`(device 側の事実)だけ。
 * dedupe(AC-4: 中身が同じ版は積まない)は server 側(`createCapsule`)の役目 —— ここでは毎 tick
 * 無条件に `work_capsule` を呼ぶだけで、2 重に判定しない。
 *
 * **`work_current()` は cwd を見ない**(server.ts の work_current tool 定義どおり「lease だけで
 * 選ぶ」)。同一 account で複数の work が同時に live lease を持つ時(このプロジェクト自身が
 * 「並列は 2 本まで」で常時やっている状態)、`ambiguous:true` が返る —— その時に無視して打つと、
 * **この cwd(の worktree)の git_state を、無関係な別 work の capsule として書いてしまう**
 * (review 2026-09-09 で実測。取り違えた側の work には 1 件も積まれず、AC-3 の主張が崩れる)。
 * 迷ったら**打たない**(fail-safe。次の tick で ambiguity が解ければ自然に再開する)。
 */
export async function runCheckpointTick(tools: AccountTools, cwd: string): Promise<CheckpointTickResult> {
  const current = (await tools.work_current()) as {
    work_id: string;
    lease: { holder_run: string | null };
    ambiguous: boolean;
  } | null;
  if (!current || !current.lease.holder_run) return { pushed: false, reason: "no_active_work" };
  // PBI-0439: transfer の予約中は予約 holder の名で積まない(積むのは work_transfer の 1 回。VALIDATE はその版を名指す)
  if (isTransferHolderId(current.lease.holder_run)) return { pushed: false, reason: "transfer_in_progress" };
  if (current.ambiguous) return { pushed: false, reason: "ambiguous_work" };
  const gitState = computeGitState(cwd);
  if (!gitState) return { pushed: false, reason: "not_a_git_worktree" };
  await tools.work_capsule(current.work_id, {
    run_id: current.lease.holder_run,
    ...(await capsuleFieldsWithGitState(tools, current.work_id, gitState)),
  });
  return { pushed: true, workId: current.work_id };
}

/**
 * AC-5: 重要 event(tests.completed = proof)は 30 秒 tick を待たず、その場で fresh な git_state を
 * 即 checkpoint する。**best-effort**(付随効果) — 失敗しても proof 自体の成否には影響しない。
 * MCP の `work_proof` tool wrapper(server.ts)から呼ぶ。`tools.work_proof` 本体には置かない ——
 * `packages/mcp/test/work.test.ts` の AC-4 が `work_events` の増分を厳密に +1 で固定しており、
 * proof の中で capsule まで積むと +2 になって壊れる(副作用は MCP tool の口の層だけに置く)
 */
export async function pushCheckpointAfterProof(
  tools: AccountTools,
  workId: string,
  runId: string,
  cwd: string,
): Promise<void> {
  try {
    const gitState = computeGitState(cwd);
    if (gitState) {
      await tools.work_capsule(workId, { run_id: runId, ...(await capsuleFieldsWithGitState(tools, workId, gitState)) });
    }
  } catch {
    /* checkpoint は proof の成否を左右しない */
  }
}

export interface CheckpointTicker {
  stop: () => void;
}

/**
 * 30 秒ごとに `runCheckpointTick` を回す(PBI-0408 の既定間隔は `@openroly/core` の
 * `CHECKPOINT_TICK_INTERVAL_SECS`。呼び手は ms を明示しない限りそれを使う)。
 *
 * **前の tick が終わる前に次を起こさない**(`inFlight`)。エラーは `onError` に渡すだけで
 * loop は止めない(1 回の network 障害で以後 30 秒ごとの機会を全部失わない為)。
 * `stop()` は次の tick を止めるだけで、進行中の tick を中断しない
 * (AC-6: 呼び手は「runtime が死んだ」と分かった時点でこれを呼ぶ想定 —— 死んだ後に
 * **新しい** request は 1 つも起きなくなる、が保証の中身)。
 */
/** GC(AC-8)を挟む間隔。tick ごとに端末の CAS dir をスキャンする必要は無い(容量/期限の
 * 判定は分単位でずれても実害が無い) —— 既定 30 秒 tick なら 120 回ごと = 約 1 時間ごと */
const GC_EVERY_N_TICKS = 120;

export function startCheckpointTicker(
  tools: AccountTools,
  opts: {
    cwd: string;
    intervalMs: number;
    onError?: (e: unknown) => void;
    /** test 用の差し替え口(既定 GC_EVERY_N_TICKS)。本番は呼び手が指定しない */
    gcEveryNTicks?: number;
    /**
     * PBI-0436: agent の外の書き手(git と transcript の事実を Work Project context に置く)。
     * 既定 = 本物の env と home。test は transcript の置き場を差し替える。false で止める
     */
    autoContext?: false | { env?: Record<string, string | undefined>; home?: string; now?: number };
  },
): CheckpointTicker {
  let stopped = false;
  let inFlight = false;
  let tickCount = 0;
  const gcEvery = opts.gcEveryNTicks ?? GC_EVERY_N_TICKS;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // PBI-0446: put で上げ損ねた context の値を再送する。lease の有無に依らず毎 tick —— 失敗は印が残って次の tick へ
      // (account 鍵がまだ無い account では毎回落ちるので onError に流さない。残りは `openroly doctor` が数える)
      await tools.context_sync().catch(() => {});
      const result = await runCheckpointTick(tools, opts.cwd);
      tickCount += 1;
      // PBI-0436: capsule を打てた(= lease があり ambiguous でなく git worktree)時だけ、同じ work の
      // Work Project context に事実を置く。runtime が 429 で黙っていてもこの process は動いている。
      // 失敗しても capsule の結果と次の tick を巻き込まない
      if (result.pushed && opts.autoContext !== false) {
        await runAutoContext(tools, result.workId, opts.cwd, opts.autoContext ?? {}).catch((e) => opts.onError?.(e));
      }
      // AC-8: 古い/容量超過の payload を掃除する。push した時だけ(新しく増えた時だけ)チェックする
      if (result.pushed && tickCount % gcEvery === 0) {
        await gcCheckpoints().catch((e) => opts.onError?.(e));
      }
    } catch (e) {
      opts.onError?.(e);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  // Node/Bun のプロセスをこの timer だけで生かし続けない(stdio が閉じれば自然に exit してよい)
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
