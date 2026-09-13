// PBI-0393 / CAP-3: Work Ledger の書き込み権判定(REQ-86 / REQ-87 の土台)。
// 分岐の正本はこの 1 ファイルだけ — app.ts の write route はここを呼ぶだけで
// 独自の比較を書かない(2 箇所に置くと片方だけ直って窓が開く)。
//
// epoch: 「今どの Run が書いてよいか」の世代番号。freeze すると +1 され、
// 古い epoch を名乗る命令は以後すべて拒否される(遅れて届いた命令が生きている
// lease を壊さない)。heartbeat(死活)とは別物 — heartbeat では遅れた命令を
// 拒否できない(C4 #8)ので decideWrite は last_heartbeat_at を見ない。
//
// 値集合は**書き写さない**(PBI-0401)。`third_party/openclaw/` に置いた上流の実物から
// derive するので、上流が 1 値足したら手元も増え、値の数を固定した検査が赤くなる
// (手写しだった間は、上流がずれても永久に緑だった)。由来は THIRD_PARTY_NOTICES.md の OpenClaw 節。
import {
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
} from "@openclaw/workboard-contract";

/** status 10 値。OpenClaw workboard-contract の 9 値 + needs_user(0908)。
 * 値集合を発明しない(CAPABILITIES.md 横断ルール 5)。migration 047 の check と同じ並び */
export const WORK_STATUSES = [...WORKBOARD_STATUSES, "needs_user"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export interface WorkLease {
  epoch: number;
  holderRun: string | null;
  expiresAt: Date | null;
}

export type WriteDecision =
  | { ok: false; reason: "stale_epoch" | "not_holder" | "lease_expired" | "no_lease" }
  | { ok: true };

/**
 * 書いてよいか。判定順序:
 *  1. epoch 0 = 誰も持っていない(no_lease)
 *  2. 命令の epoch が今と違う = stale_epoch(← この PBI の核心。**未来の epoch も拒否**)
 *  3. holder が違う = not_holder
 *  4. 期限切れ = lease_expired(現在は null 固定 — 期限は V3 で決める)
 *
 * epoch の一致を**等価**で測るのが本体: `>=` にすると freeze 後の古い命令が
 * 「自分の epoch 以下」で通ってしまう(負の対照で赤を見る箇所)。
 */
export function decideWrite(
  lease: WorkLease,
  cmd: { runId: string; expectedWriteEpoch: number },
  now: Date,
): WriteDecision {
  if (lease.epoch === 0) return { ok: false, reason: "no_lease" };
  if (cmd.expectedWriteEpoch !== lease.epoch) return { ok: false, reason: "stale_epoch" };
  if (cmd.runId !== lease.holderRun) return { ok: false, reason: "not_holder" };
  if (lease.expiresAt != null && now > lease.expiresAt) return { ok: false, reason: "lease_expired" };
  return { ok: true };
}

// ---------- thread → work 昇格(PBI-0397 / CAP-3 B′・D2) ----------

/**
 * thread が work に昇格できるか。triage_label='action' 以外は昇格しない(fail-closed)。
 * 昇格済み(work_id が立っている)も昇格できない — 2 回目は呼び出し側が 409 already_promoted で
 * 同じ work を教える(冪等)。分岐の正本はこの 1 関数(route は reason を code に写すだけ)。
 */
export function canPromoteThread(t: {
  triageLabel: string;
  workId: string | null;
}): { ok: true } | { ok: false; reason: "already_promoted" | "not_action" } {
  if (t.workId != null) return { ok: false, reason: "already_promoted" };
  if (t.triageLabel !== "action") return { ok: false, reason: "not_action" };
  return { ok: true };
}

// ---------- work events / proofs(PBI-0395 / CAP-3) ----------

/** event kind 24 値。OpenClaw workboard-contract の値集合そのもの(direction §59.6 の表と同じ)。
 * 発明しない。migration 048 の check と同じ並び */
export const WORK_EVENT_KINDS = WORKBOARD_EVENT_KINDS;
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

/** この slice で route が受ける kind(allowed list)。残り 18 値は保存面だけを持つ ——
 * heartbeat / claimed 等の書き手(broker)は別 slice なので口を開けない */
export const WORK_EVENT_ROUTE_KINDS = [
  "comment_added", "proof_added", "artifact_added",
  "attempt_started", "attempt_updated", "diagnostic",
] as const;

export const WORK_PROOF_STATUSES = WORKBOARD_PROOF_STATUSES;
export type WorkProofStatus = (typeof WORK_PROOF_STATUSES)[number];

/** **上流に無い**。event を誰が書いたか(run / server / user)は我々の保存面の概念 */
export const WORK_EVENT_ACTORS = ["run", "server", "user"] as const;

/** attempt の status 5 値(workboard。attempt_updated の payload が持つ) */
export const WORK_ATTEMPT_STATUSES = WORKBOARD_ATTEMPT_STATUSES;

export type PayloadDecision = { ok: true } | { ok: false; reason: string };

/**
 * kind 別の payload 必須 field。fail-closed —— 必須 field が無い / 型が違う物を黙って許さない
 * (「書けた」のに中身の無い event が緑で残るのを防ぐ)。payload 自体は object だけが条件で、
 * 未知の key は弾かない(envelope は開けていく物なので、必須 field の検査だけを正本にする)。
 * 口を開けた 6 種だけが必須 field を持つ。残り 18 値は route が受けないのでここでは形だけ。
 */
export function validateEventPayload(kind: string, payload: unknown): PayloadDecision {
  const p = payload == null ? {} : payload;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, reason: "payload_not_object" };
  const o = p as Record<string, unknown>;
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  switch (kind) {
    case "comment_added": // 本文が無い comment は存在しない
      return nonEmpty(o.body) ? { ok: true } : { ok: false, reason: "body_required" };
    case "proof_added": // proof と同じ検証(status 4 値 + 数値の規則)を共用する
      return validateProofCounts(o as { status?: unknown; passed?: unknown; failed?: unknown });
    case "artifact_added":
      return nonEmpty(o.name) ? { ok: true } : { ok: false, reason: "name_required" };
    case "attempt_started":
      return nonEmpty(o.attemptId) ? { ok: true } : { ok: false, reason: "attemptId_required" };
    case "attempt_updated": // 更新が何を変えたか分からない event は要らない
      if (!nonEmpty(o.attemptId)) return { ok: false, reason: "attemptId_required" };
      return (WORK_ATTEMPT_STATUSES as readonly string[]).includes(o.status as never)
        ? { ok: true }
        : { ok: false, reason: "invalid_attempt_status" };
    case "diagnostic": // diagnostic kind 7 値(direction §59.6)を code に持つ
      return nonEmpty(o.code) ? { ok: true } : { ok: false, reason: "code_required" };
    default:
      return { ok: true };
  }
}

/**
 * proof の数値検証。status は 4 値。passed / failed は **0 以上の整数**でのみ許され、
 * skipped / unknown は数値を持たない(持っていたら拒否 —— 「skipped 32 個」は嘘になる)。
 * passed / failed status での数値は任意(「build passed」のように数えられない証拠もある)。
 */
export function validateProofCounts(
  input: { status?: unknown; passed?: unknown; failed?: unknown },
): PayloadDecision {
  if (typeof input.status !== "string" || !(WORK_PROOF_STATUSES as readonly string[]).includes(input.status)) {
    return { ok: false, reason: "invalid_status" };
  }
  const has = (v: unknown) => v !== undefined && v !== null;
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (input.status === "skipped" || input.status === "unknown") {
    return has(input.passed) || has(input.failed)
      ? { ok: false, reason: "counts_not_allowed" }
      : { ok: true };
  }
  if (has(input.passed) && !count(input.passed)) return { ok: false, reason: "invalid_passed" };
  if (has(input.failed) && !count(input.failed)) return { ok: false, reason: "invalid_failed" };
  return { ok: true };
}

// ---------- periodic checkpoint(PBI-0408 / CAP-3 V3・C4 #5 / #27) ----------
// **2 つの秒数は別物**(C4 #5)。0906 の 90 秒は「死んだ判定」(last_heartbeat_at がこれより
// 古い running を running_without_heartbeat と見る — 診断本体は別 slice)、0908 の 30 秒は
// 「checkpoint を打つ間隔」。どちらも独立したリテラルで、一方を変えても他方の値は動かない
// (どちらかを比 [heartbeat * n/3] のように導出すると、AC-7 が守ろうとした「別物」が崩れる)。

/** checkpoint tick の間隔(秒)。打つ主体は device 側(MCP server の常駐 tick / PBI-0408) */
export const CHECKPOINT_TICK_INTERVAL_SECS = 30;

/** running な work の `last_heartbeat_at` がこれより古ければ死活疑い(running_without_heartbeat)。
 * この PBI では定数だけ持つ — 診断(WORKBOARD_DIAGNOSTIC_KINDS)の実装は別 slice */
export const WORK_LIVENESS_TIMEOUT_SECS = 90;

// ---------- v0 Authority(PBI-0413 / CAP-3 V10・direction/v0.md §7) ----------
// 「Agent が勝手に Codex へ移しました」にしない。動詞ごとに 3 段のどれかが要る:
//   auto                    人に聞かない(既存の lease/write の門だけで足りる。この slice は触らない)
//   policy                  delegation_policies に許可行が要る(未設定なら拒否)
//   explicit_user_intent    使い捨ての intent token が要る(人の発話を LLM に判定させない — D5 と同じ理由)
// 新しい authority 機構は立てない —— epoch の門(decideWrite)が既に「誰が書いてよいか」を
// 持っているので、この 3 段はその**手前**に立つ 1 枚の関門として足す。

/** checkpoint / read_context は既存の lease/write 経路がそのまま auto(この slice は触らない)。
 * start_review / fork_work は PBI-0440 の fork / review(`POST /v1/works/:id/forks`)が policy 段として通る。
 * transfer_primary(claim で既存 holder を持ち替える)/ stop_primary(freeze)は
 * 今 実在する口(PBI-0393)なので、この slice でその 2 つだけ実際に配線する。 */
export const AUTHORITY_ACTIONS = [
  "checkpoint", "read_context", "start_review", "fork_work", "transfer_primary", "stop_primary",
] as const;
export type AuthorityAction = (typeof AUTHORITY_ACTIONS)[number];

export type AuthorityTier = "auto" | "policy" | "explicit_user_intent";

export const AUTHORITY_TIERS: Record<AuthorityAction, AuthorityTier> = {
  checkpoint: "auto",
  read_context: "auto",
  start_review: "policy",
  fork_work: "policy",
  transfer_primary: "explicit_user_intent",
  stop_primary: "explicit_user_intent",
};

/** 呼び手が提示した intent token を、DB から読んだ状態と付き合わせた結果(DB I/O はここでしない —
 * decideWrite が `WorkLease` を引数で受けるのと同じ形。呼び出し側が先に読んで渡す)。 */
export type IntentTokenState =
  | { status: "valid"; workId: string; action: AuthorityAction }
  | { status: "not_found" }
  | { status: "consumed" }
  | { status: "expired" }
  | { status: "mismatch" }; // work_id か action が要求と違う(別 work / 別動詞への使い回し)

export type AuthorityDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "policy_not_granted" | "explicit_user_intent_required" | "intent_already_consumed"
        | "intent_expired" | "intent_mismatch";
    };

/**
 * 動詞ごとの段を見て通す/拒む。**intent token の真贋判定はここではしない**
 * (呼び出し側が `resolveWorkIntent` で読んだ結果を渡すだけ — ここは分岐の正本)。
 */
export function decideAuthority(
  action: AuthorityAction,
  workId: string,
  ctx: { policyGranted: boolean; intent: IntentTokenState | null },
): AuthorityDecision {
  const tier = AUTHORITY_TIERS[action];
  if (tier === "auto") return { ok: true };
  if (tier === "policy") {
    return ctx.policyGranted ? { ok: true } : { ok: false, reason: "policy_not_granted" };
  }
  // explicit_user_intent
  const intent = ctx.intent;
  if (intent == null || intent.status === "not_found") {
    return { ok: false, reason: "explicit_user_intent_required" };
  }
  if (intent.status === "consumed") return { ok: false, reason: "intent_already_consumed" };
  if (intent.status === "expired") return { ok: false, reason: "intent_expired" };
  if (intent.status === "mismatch") return { ok: false, reason: "intent_mismatch" };
  if (intent.workId !== workId || intent.action !== action) {
    return { ok: false, reason: "intent_mismatch" };
  }
  return { ok: true };
}

// ---------- Work Project の task(PBI-0434・owner の手描き 2 枚目) ----------

/**
 * task の親(Work Project)にできるか。親は **1 段だけ** —— task を親にする(孫)と拒否する。
 * 親は作成時にしか決まらないので、これで循環を形として作れなくなる。
 * `parent` は呼び出し側が **自分の account の中で** 読んだ行(他人の work・無い id は null で来る = 同じ理由で拒否)。
 */
export function decideParent(
  parent: { id: string; parentWorkId: string | null } | null,
): { ok: true } | { ok: false; reason: "invalid_parent" } {
  if (parent == null) return { ok: false, reason: "invalid_parent" };
  if (parent.parentWorkId != null) return { ok: false, reason: "invalid_parent" };
  return { ok: true };
}

// ---------- runtime transfer(PBI-0439 / CAP-3 V7・図84) ----------
// 握っている work を別 runtime へ移す 2 相。PREPARE で holder を予約 id に置き換え(null にしない =
// その間に第三の run が claim で奪えない)、target run の accept(COMMIT)で予約 id を target run に置き換える。
// 分岐の正本はこの 1 関数(store は行を読んで渡し、reason を写すだけ)。

/** state の語は docs/direction/continuity.md §155 / §167。migration 055 の check と同じ並び */
export const TRANSFER_STATES = ["frozen", "capsule_ready", "routed", "committed", "failed"] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

/** 進行中(holder が予約 id で塞がっている間)。migration 055 の部分 unique index と同じ集合 */
export const TRANSFER_IN_PROGRESS_STATES = ["frozen", "capsule_ready", "routed"] as const satisfies readonly TransferState[];

/** lane "work" の dedicated session を 1 account で同時に何本まで起こすか(PBI-0225 から吸収) */
export const WORK_LANE_MAX_SESSIONS = 3;

const TRANSFER_HOLDER_PREFIX = "transfer:";

/** 予約 holder の id。綴りはここ 1 箇所だけ(store / MCP は必ずこれを呼ぶ) */
export function transferHolderId(transferId: string): string {
  return `${TRANSFER_HOLDER_PREFIX}${transferId}`;
}

/** run id が予約 holder か(checkpoint tick が予約 holder の名で capsule を積まない為・target が名乗れない為) */
export function isTransferHolderId(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith(TRANSFER_HOLDER_PREFIX);
}

/**
 * op の意味(図84 の辺):
 *  - validate  frozen → capsule_ready(route 呼び出しの VALIDATE。予約 epoch の capsule を確かめた)
 *  - route     capsule_ready → routed(wake が ok)
 *  - commit    routed → committed(target run の accept。kind が to_runtime_kind と一致する時だけ)
 *  - expire    進行中 → failed(期限を過ぎた。routed なら commit_timeout・その前なら route_timeout)
 * validate と route を分けるのは、wake を待つ間に 2 本目の route が同じ transfer を 2 回起こさない為
 * (capsule_ready からは validate が通らない)。
 */
export type TransferOp = "validate" | "route" | "commit" | "expire";

export type TransferRejectReason =
  | "transfer_expired"
  | "transfer_already_committed"
  | "transfer_not_routable"
  | "transfer_not_routed"
  | "transfer_target_mismatch"
  | "transfer_not_expired";

/** 期限で failed になった理由(遅れて来た route / accept は transfer_expired に写す) */
export const TRANSFER_TIMEOUT_REASONS = ["commit_timeout", "route_timeout"] as const;

export type TransferStep =
  | { ok: true; next: TransferState; failReason?: (typeof TRANSFER_TIMEOUT_REASONS)[number] }
  | { ok: false; reason: TransferRejectReason };

export function decideTransferStep(
  transfer: { state: TransferState; reason: string | null; expiresAt: Date; toRuntimeKind: string },
  op: TransferOp,
  now: Date,
  actor: { runtimeKind: string | null } = { runtimeKind: null },
): TransferStep {
  const inProgress = (TRANSFER_IN_PROGRESS_STATES as readonly string[]).includes(transfer.state);
  const expired = inProgress && now.getTime() >= transfer.expiresAt.getTime();
  if (op === "expire") {
    return expired
      ? { ok: true, next: "failed", failReason: transfer.state === "routed" ? "commit_timeout" : "route_timeout" }
      : { ok: false, reason: "transfer_not_expired" };
  }
  if (transfer.state === "committed") return { ok: false, reason: "transfer_already_committed" };
  const timedOut =
    transfer.state === "failed" && (TRANSFER_TIMEOUT_REASONS as readonly (string | null)[]).includes(transfer.reason);
  if (expired || timedOut) return { ok: false, reason: "transfer_expired" };
  if (op === "validate") {
    return transfer.state === "frozen" ? { ok: true, next: "capsule_ready" } : { ok: false, reason: "transfer_not_routable" };
  }
  if (op === "route") {
    return transfer.state === "capsule_ready" ? { ok: true, next: "routed" } : { ok: false, reason: "transfer_not_routable" };
  }
  if (transfer.state !== "routed") return { ok: false, reason: "transfer_not_routed" };
  if (actor.runtimeKind !== transfer.toRuntimeKind) return { ok: false, reason: "transfer_target_mismatch" };
  return { ok: true, next: "committed" };
}

// ---------- fork / review(PBI-0440 / CAP-3 V8・図84) ----------
// 元の work を止めずに枝を 1 本立てる。fork と review は同じ 1 つの機構で、違いは Context Profile だけ
// (docs/direction/context.md §20〜§21「Not knowing can be useful」)。分岐の正本はこの節(store / route / MCP は呼ぶだけ)。

/**
 * profile ごとの「見せてよい物」(**allowlist**)。null = 絞らない。**書いていない物は見せない**(fail-closed) ——
 * capsule に field が増えても、context に key が増えても reviewer_blind には既定で出ない。
 * 見せないのは前の agent の意見と途中経過(decisions / current_state / next_step / failed_attempts /
 * verified_findings / open_questions / inbox/ …)、見せるのは目的と事実。owner が変えたければこの定数 1 行。
 * key の並びは migration 056 の check と同じ
 */
export const CONTEXT_PROFILES = {
  full: null,
  reviewer_blind: {
    capsuleFields: ["goal", "relevant_artifacts", "git_state", "capability_requirements"],
    contextKeys: ["goal", "auto/git", "auto/files_touched", "auto/tests"],
    sources: true,
  },
} as const;
export type ContextProfile = keyof typeof CONTEXT_PROFILES;

/** role → 門(AUTHORITY_TIERS の policy 段)と profile */
export const FORK_ROLES = {
  implementer: { action: "fork_work", profile: "full" },
  reviewer: { action: "start_review", profile: "reviewer_blind" },
} as const satisfies Record<string, { action: AuthorityAction; profile: ContextProfile }>;
export type ForkRole = keyof typeof FORK_ROLES;

export function forkRole(role: unknown): (typeof FORK_ROLES)[ForkRole] | null {
  return typeof role === "string" && Object.hasOwn(FORK_ROLES, role) ? FORK_ROLES[role as ForkRole] : null;
}

/** 枝を立ててよいか。`capsule` は呼び出し側が **fork 元の work の中で** 読んだ vN(無ければ null) */
export function decideFork(
  capsule: { version: number } | null,
  role: unknown,
): { ok: true; action: AuthorityAction; profile: ContextProfile } | { ok: false; reason: "invalid_role" | "no_capsule" } {
  const r = forkRole(role);
  if (!r) return { ok: false, reason: "invalid_role" };
  if (!capsule) return { ok: false, reason: "no_capsule" };
  return { ok: true, action: r.action, profile: r.profile };
}

/** task の合流(PBI-0447・図80c ⑥)で task の events に残す結果。busy / empty は何も起きていないので残さない */
export const TASK_MERGE_RESULTS = ["applied", "conflict"] as const;
/** 1 回の記録に載せる path の上限と 1 本の長さ(それ以上は記録から外す。合流そのものは全部見る) */
export const TASK_MERGE_PATHS_MAX = 1000;
export const TASK_MERGE_PATH_MAX_LENGTH = 4096;

export type MergeDecision =
  | { result: "applied"; paths: string[] }
  | { result: "conflict"; paths: string[] }
  | { result: "busy" }
  | { result: "empty" };

// `git apply --check` が path を名指す行(git 2.39 の文言・実測 2026-09-13)。`error: patch failed: <path>:<行>` は数えない(同じ path の 2 行目)
const APPLY_CONFLICT_LINE =
  /^error: (.+): (?:patch does not apply|already exists in working directory|does not exist in working directory|wrong type|has type \d+, expected \d+)$/gm;

/**
 * task の合流を決める。順は empty → busy → applied → conflict。`changed` = base → 今の folder で変わった path、
 * `checkError` = `git apply --check` が落ちた時の stderr(通れば null)。ぶつかった path は git の `error: <path>: <理由>` 行から拾い、
 * 1 つも拾えなければ変わった path 全部を返す(どれがぶつかったか言えない時に「ぶつかっていない」と読ませない)
 */
export function decideMerge(check: { changed: string[]; busy: boolean; checkError: string | null }): MergeDecision {
  if (check.changed.length === 0) return { result: "empty" };
  if (check.busy) return { result: "busy" };
  if (check.checkError == null) return { result: "applied", paths: check.changed };
  const hit = [...new Set([...check.checkError.matchAll(APPLY_CONFLICT_LINE)].map((m) => m[1] as string))].sort();
  return { result: "conflict", paths: hit.length > 0 ? hit : check.changed };
}

type ProfileRow = { kind: string; key: string };

/**
 * profile の門(1 関数)。context 索引の行 **か** capsule の本文を受け、見せてよい物だけを返す。
 * hidden は隠した物の名前だけ(値は返さない)。render(MCP work_accept)・server の context 索引・
 * work_context_search の 3 口が全部これを通る(口ごとに filter を書かない)。未知の profile は何も見せない
 */
export function applyContextProfile<T extends ProfileRow>(profile: string, input: readonly T[]): { kept: T[]; hidden: string[] };
export function applyContextProfile(profile: string, input: Record<string, unknown>): { kept: Record<string, unknown>; hidden: string[] };
export function applyContextProfile(
  profile: string,
  input: readonly ProfileRow[] | Record<string, unknown>,
): { kept: ProfileRow[] | Record<string, unknown>; hidden: string[] } {
  const known = Object.hasOwn(CONTEXT_PROFILES, profile);
  const allow = known ? CONTEXT_PROFILES[profile as ContextProfile] : undefined;
  const hidden = new Set<string>();
  if (Array.isArray(input)) {
    const rows = input as readonly ProfileRow[];
    if (allow === null) return { kept: [...rows], hidden: [] };
    const kept = rows.filter((e) => {
      const ok =
        allow !== undefined &&
        (e.kind === "source" ? allow.sources : e.kind === "context" && (allow.contextKeys as readonly string[]).includes(e.key));
      if (!ok) hidden.add(e.key);
      return ok;
    });
    return { kept, hidden: [...hidden].sort() };
  }
  const body = input as Record<string, unknown>;
  if (allow === null) return { kept: { ...body }, hidden: [] };
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (allow !== undefined && (allow.capsuleFields as readonly string[]).includes(k)) kept[k] = v;
    else hidden.add(k);
  }
  return { kept, hidden: [...hidden].sort() };
}
