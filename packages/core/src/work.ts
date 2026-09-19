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

/** 今しゃべっている MCP session の lease run id（PBI-0703 / dogfood F50）。kind は dest。CLI は pid を知らないので pid を埋め込まない。 */
export function mcpSessionRunId(kind: string | null | undefined): string {
  const k = (kind ?? "").trim() || "runtime";
  return `mcp-${k}`;
}

export function isMcpSessionRun(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith("mcp-");
}

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

// ---------- root work を誰が作れるか(PBI-0623 / CAP-3・図75 (f)) ----------

/**
 * **人の手(human hand)として数える runtime の kind。** broker = `openroly login` で人が承認した
 * 端末そのもの。1 語しか無いのに定数の集合にしてあるのは、2 語目を足す日にここだけを見れば済むから。
 */
export const HUMAN_HAND_RUNTIME_KINDS = ["broker"] as const;

/**
 * 人の手として数えるか。web/`pas_` の human と、`openroly login` が pair した broker だけ。
 * create(PBI-0623)と transfer/continue(PBI-0679)が同じ関数を見る —— 片側だけ broker を人にすると
 * 「仕事は作れるが渡せない」になる。
 */
export function isHumanHandActor(
  actorKind: "human" | "runtime",
  runtimeKind: string | null | undefined,
): boolean {
  if (actorKind === "human") return true;
  return runtimeKind != null && (HUMAN_HAND_RUNTIME_KINDS as readonly string[]).includes(runtimeKind);
}

/**
 * catalog の id と `runtimes add` の `local-<id>` を、pairing 済みの方へ畳む。
 * 要求した kind が pair 済みならそれを返す。無ければ接頭辞の有無だけを見る（推測の別名表は持たない）。
 */
export function resolvePairedRuntimeKind(requested: string, paired: Iterable<string>): string {
  const set = new Set(paired);
  if (set.has(requested)) return requested;
  if (requested.startsWith("local-")) {
    const base = requested.slice("local-".length);
    if (base !== "" && set.has(base)) return base;
  } else if (set.has(`local-${requested}`)) {
    return `local-${requested}`;
  }
  return requested;
}

/** catalog の headless id、またはその `local-` 付き（broker が adopt した local catalog） */
export function isWakeableKind(kind: string, headlessIds: readonly string[]): boolean {
  if (headlessIds.includes(kind)) return true;
  return kind.startsWith("local-") && headlessIds.includes(kind.slice("local-".length));
}

/**
 * 親を持たない(root)work を作ってよいか。
 *
 * **runtime は自分の担当を無から作れない。** PBI-0397 が `canPromoteThread` で守っている不変条件
 * (「昇格できるのは通知由来の owner thread だけ」= self を昇格させない)は、thread からの道だけを
 * 塞いでも足りない —— create の口が開いていれば、runtime は work を作って自分へ handoff するだけで
 * 同じ事ができ、`handled` の調停(誰がこの仕事の係か)が意味を失う。
 *
 * 分岐は 3 つだけ:
 *  - **`hasParent` は素通り** —— task は親が既に人の手から生まれているので、出所は人まで辿れる
 *    (`work_task_create` の道。ここを閉じると runtime が仕事を分割できなくなる)
 *  - **`human`** —— web / `pas_` session。呼び出しそのものが人の認証で来ている事が「人がやった」証明
 *    (`decideAuthority` の human 素通りと同じ理由 —— 意図を LLM に判定させない)
 *  - **`broker`** —— 人が `openroly login` した端末。PBI-0023 F1 が引いた線と同じ:
 *    broker credential は `approvePairing`(human 専用)でしか出ず、`autoRegisterRuntimes` が
 *    配る kind は detector 由来なので broker にはならない。AI runtime はこれを名乗れない
 */
export function decideWorkCreator(input: {
  actorKind: "human" | "runtime";
  runtimeKind: string | null;
  hasParent: boolean;
}): { ok: true } | { ok: false; reason: "human_only" } {
  if (input.hasParent) return { ok: true };
  if (isHumanHandActor(input.actorKind, input.runtimeKind)) return { ok: true };
  return { ok: false, reason: "human_only" };
}

// ---------- Project.owner(PBI-0467 / CAP-3 V18・第 25 通 §2〜§4・§18・§19) ----------

/** owner の kind の値集合。今は account の 1 つだけ(最小の所有主体)。
 * 2 つ目を足す日はここに 1 語足すだけ(migration も backfill も要らない形 — DB は形 `<kind>:<id>` だけ check する) */
export const WORK_OWNER_KINDS = ["account"] as const;
export type WorkOwnerKind = (typeof WORK_OWNER_KINDS)[number];

/** owner の綴りを組む唯一の場所("<kind>:<id>") */
export function workOwnerId(kind: WorkOwnerKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * work を作る時の owner を決める。root(親を持たない)work は作成した account が owner。
 * task(親を持つ)は **親の owner をそのまま継承する** —— owner は作成時にしか決まらず、
 * 書き換える口も無い(親の規約と同じ・migration 054)。渡された parent の owner が
 * 作成した account の owner と違えば拒否する(今の経路では parent は必ず同じ account から読むので
 * 到達しないが、owner が作成時にしか決まらない不変条件を core の 1 関数で守る)。
 */
export function decideWorkOwner(input: {
  accountId: string;
  parent?: { owner: string } | null;
}): { ok: true; owner: string } | { ok: false; reason: "owner_mismatch" } {
  const accountOwner = workOwnerId("account", input.accountId);
  if (input.parent == null) return { ok: true, owner: accountOwner };
  if (input.parent.owner !== accountOwner) return { ok: false, reason: "owner_mismatch" };
  return { ok: true, owner: input.parent.owner };
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

// ---------- one-step continue(PBI-0547 / CAP-3 V7) ----------
// 「Claude が止まったら openroly continue の一言」の選択の正本。works は全件(server の listWorks)を
// 渡し、この純関数が 1 本に絞る。箱は 3 つ(3 つ目 = 失敗した handoff が解放した work・PBI-0578)—— live lease の最新、無ければ lapsed(session 死亡で
// lease 期限切れ)で done でない最新。どちらの箱にも複数残れば ambiguous(黙って選ばない = V10 の
// 「候補まで」)。done は続ける対象外なので両方の箱から外す。

/** pickContinueWork へ渡す 1 行(listWorks の直列化から CLI が組む) */
export interface ContinueWorkInput {
  id: string;
  title: string;
  status: string;
  holderRun: string | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
  /** stallOf の結果(PBI-0557)。live が複数の時に 1 本へ絞る根拠に使う。未指定 = 止まっていない */
  stalled?: Stall | null;
  /** 失敗した handoff が解放した lease(PBI-0578・一覧の released_by_failed_handoff)。未指定 = 解放されていない */
  failedHandoff?: boolean;
  /** 今 lease を持っている runtime の kind（`--to` で「そこに居ない仕事」を選ぶ。未指定 = 不明） */
  runtimeKind?: string | null;
  /** 係（standing owner）。`work current` と同じ照合に使う。未指定 = 係なし */
  handledRuntimeId?: string | null;
  /** `work current` の standing 順（lease_acquired_at）。未指定 = updatedAt */
  leaseAcquiredAt?: Date | null;
}

/** 選んだ 1 本(lapsed = 切れた lease からの continue)か、候補が無いか、絞り切れないか */
export type ContinuePick =
  | { kind: "none" }
  | { kind: "work"; work: ContinueWorkInput; lapsed: boolean }
  | { kind: "ambiguous"; works: ContinueWorkInput[]; lapsed: boolean };

export function pickContinueWork(
  works: ContinueWorkInput[],
  now: Date,
  opts?: { toKind?: string; self?: { runtimeId?: string | null; kind?: string | null } },
): ContinuePick {
  // lease_expires_at が null の holder は「切れない lease」(store の live 判定と同じ規則)
  const live = works.filter(
    (w) => w.holderRun != null && w.status !== "done" && (w.leaseExpiresAt == null || w.leaseExpiresAt > now),
  );
  const lapsed = works.filter(
    (w) => w.holderRun != null && w.status !== "done" && w.leaseExpiresAt != null && w.leaseExpiresAt <= now,
  );
  // PBI-0578: 3 つ目の箱 = 失敗した handoff が holder を外した work(spec §6: failed の後は誰も lease を持たない)。
  // freeze で止めた work は入れない(failedHandoff を立てるのは server の解放の判定だけ)
  const released = works.filter((w) => w.holderRun == null && w.status !== "done" && w.failedHandoff === true);
  // 「最新」= updated_at の降順(ambiguous の一覧も同じ順で出す)
  const newest = (xs: ContinueWorkInput[]) => [...xs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const newestStanding = (xs: ContinueWorkInput[]) =>
    [...xs].sort((a, b) => (b.leaseAcquiredAt?.getTime() ?? b.updatedAt.getTime()) - (a.leaseAcquiredAt?.getTime() ?? a.updatedAt.getTime()));
  const onTarget = (w: ContinueWorkInput): boolean => {
    const to = opts?.toKind;
    const kind = w.runtimeKind;
    if (to == null || kind == null || kind === "") return false;
    return kind === to || resolvePairedRuntimeKind(kind, [to]) === to || resolvePairedRuntimeKind(to, [kind]) === kind;
  };
  // PBI-0701 / dogfood 使い心地: work current と同じ係の newest。`--to` で居ない箱があるときは 0686 の switch が先。
  const preferStanding = (pool: ContinueWorkInput[], lapsedFlag: boolean): ContinuePick | null => {
    const self = opts?.self;
    if (self == null) return null;
    const mine = pool.filter((w) => {
      const h = w.handledRuntimeId;
      if (h == null || h === "") return false;
      if (self.runtimeId != null && self.runtimeId !== "" && h === self.runtimeId) return true;
      if (self.kind == null || self.kind === "") return false;
      return h === self.kind || resolvePairedRuntimeKind(h, [self.kind]) === self.kind;
    });
    if (mine.length === 0) return null;
    return { kind: "work", work: newestStanding(mine)[0]!, lapsed: lapsedFlag };
  };
  const pickFromBox = (box: ContinueWorkInput[], lapsedFlag: boolean): ContinuePick => {
    if (box.length === 0) return { kind: "none" };
    if (box.length === 1) return { kind: "work", work: box[0]!, lapsed: lapsedFlag };
    if (!lapsedFlag) {
      // PBI-0557: live が複数でも、usage limit で止まっている物が 1 本だけならそれを選ぶ
      const stalled = box.filter((w) => w.stalled != null);
      if (stalled.length === 1) return { kind: "work", work: stalled[0]!, lapsed: false };
    }
    // F53: `--to` が自分なら live 複数でも係の newest（probe が一言を壊さない）
    const selfIsTo =
      opts?.toKind != null &&
      opts.self?.kind != null &&
      (opts.self.kind === opts.toKind || resolvePairedRuntimeKind(opts.self.kind, [opts.toKind]) === opts.toKind);
    if (selfIsTo || lapsedFlag) {
      const standing = preferStanding(box, lapsedFlag);
      if (standing) return standing;
    }
    if (opts?.toKind) {
      const switchable = box.filter((w) => w.runtimeKind != null && w.runtimeKind !== "" && !onTarget(w));
      if (switchable.length === 1) return { kind: "work", work: switchable[0]!, lapsed: lapsedFlag };
      if (switchable.length > 1) {
        if (!lapsedFlag) {
          const stalledPool = switchable.filter((w) => w.stalled != null);
          if (stalledPool.length === 1) return { kind: "work", work: stalledPool[0]!, lapsed: false };
          // PBI-0684: live は居ない箱の最新を一言で移す
          return { kind: "work", work: newest(switchable)[0]!, lapsed: false };
        }
        // PBI-0686 / dogfood F25: lapsed は黙って最新を取らず、checkpoint で選ばせる
        return { kind: "ambiguous", works: newest(switchable), lapsed: true };
      }
      if (box.every(onTarget)) {
        if (!lapsedFlag) return { kind: "work", work: newest(box)[0]!, lapsed: false };
        return preferStanding(box, true) ?? { kind: "ambiguous", works: newest(box), lapsed: true };
      }
    }
    if (lapsedFlag) {
      const standing = preferStanding(box, true);
      if (standing) return standing;
    }
    return { kind: "ambiguous", works: newest(box), lapsed: lapsedFlag };
  };
  const fromLive = pickFromBox(live, false);
  if (fromLive.kind !== "none") return fromLive;
  const fromLapsed = pickFromBox(lapsed, true);
  if (fromLapsed.kind !== "none") return fromLapsed;
  return pickFromBox(released, true);
}

/** list に出した短縮 id を continue が受けられるようにする(PBI-0686 / dogfood F27)。末尾の省略記号は捨てる */
export function matchWorkId(
  ids: readonly string[],
  named: string,
): { kind: "one"; id: string } | { kind: "none" } | { kind: "many"; ids: string[] } {
  const cleaned = named.replace(/…+$/u, "");
  if (cleaned === "") return { kind: "none" };
  const exact = ids.filter((id) => id === cleaned);
  if (exact.length === 1) return { kind: "one", id: exact[0]! };
  const prefixed = ids.filter((id) => id.startsWith(cleaned));
  if (prefixed.length === 1) return { kind: "one", id: prefixed[0]! };
  if (prefixed.length === 0) return { kind: "none" };
  return { kind: "many", ids: prefixed };
}

/** 画面の list が unique になるまで id を出す(PBI-0686)。既定 12 字は PBI-0645 の shortId と同じ */
export function uniqueWorkIdPrefix(ids: readonly string[], id: string, minChars = 12): string {
  if (ids.filter((x) => x === id).length !== 1) return id;
  let n = Math.min(Math.max(1, minChars), id.length);
  while (n < id.length && ids.filter((x) => x.startsWith(id.slice(0, n))).length > 1) n += 1;
  return id.slice(0, n);
}

// ---------- continue guard(PBI-0583 / CAP-3・図84 の continue guard の節) ----------
// continue / transfer で受け取った session が tool を呼んだ直後に途切れた(model の返事が無い)時だけ、server が
// 同じ runtime を同じ work で 1 回起こし直す。ここは判定だけ —— 終わり方(last_part / error)は broker が session の
// stdout から読んで session_result に載せる(本文は運ばない)。

/** session の最後の part の種類(broker の session_end_of)。読めない runtime は null */
export const SESSION_LAST_PARTS = ["text", "tool"] as const;
export type SessionLastPart = (typeof SESSION_LAST_PARTS)[number];

/** guard が work の orchestration event に積む stage。exhausted / failed は `released_epoch` を持つ = continue で拾える解放 */
export const CONTINUE_GUARD_STAGES = ["continue_guard_rewake", "continue_guard_exhausted", "continue_guard_failed"] as const;
export type ContinueGuardStage = (typeof CONTINUE_GUARD_STAGES)[number];

/** 終わり方が読めない session の ③ の代わり: proof 無しでこれより早く終わった */
export const SESSION_CUT_FALLBACK_MS = 60_000;

export interface SessionEndInput {
  /** その session が lease を取った run(accept する前に終わった = null) */
  runId: string | null;
  holderRun: string | null;
  workStatus: string;
  /** その run が status passed の proof を出した */
  proofPassed: boolean;
  lastPart: SessionLastPart | null;
  error: string | null;
  /** broker の終了理由(cancelled = 人 / server の stop・tool_cap = 上限の kill)。自然終了は null */
  reason: string | null;
  durationMs: number;
}

/**
 * 途切れ = ① lease をまだその run が持っている ② work が done でなく、その run の passed の proof が無い
 * ③ 最後の part が tool(tool の結果の後に model の返事が無い)か error が在る。外から止めた session は途切れではない
 */
export function sessionCut(end: SessionEndInput): boolean {
  if (end.reason === "cancelled" || end.reason === "tool_cap") return false;
  if (end.runId == null || end.holderRun !== end.runId) return false;
  if (end.workStatus === "done" || end.proofPassed) return false;
  if (end.error != null) return true;
  if (end.lastPart != null) return end.lastPart === "tool";
  return end.durationMs < SESSION_CUT_FALLBACK_MS;
}

// ---------- usage-limit resume(PBI-0557 / CAP-3 V7 の続き) ----------
// 「Claude が usage limit で止まった」事を work に残し、次に開いた AI が候補を出す。保存面は
// 既存の diagnostic event 1 行(workboard の値集合を発明しない —— reason / runtime / resets_at を
// payload に足すだけ)。ここにあるのは判定だけ: event 列から「まだ止まっているか」を読む純関数。

/** 止まった理由の値集合。今は 1 つ(API の rate limit)。2 つ目を足す日はここに 1 語足す */
export const STALL_REASONS = ["usage_limit"] as const;
export type StallReason = (typeof STALL_REASONS)[number];

/** stallOf へ渡す 1 行(listWorkEvents の直列化から CLI / MCP が組む) */
export interface StallEventInput {
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

/** 止まっている事実(stallOf の戻り値。continue_candidate と continue の成功行がこの値を載せる) */
export interface Stall {
  reason: StallReason;
  at: Date;
  runtime: string | null;
  resetsAt: Date | null;
}

/**
 * event 列(古い順)の末尾が usage_limit の diagnostic なら、その work は**まだ**止まっている。
 * 「run の進捗」を kind ごとに判定しない —— diagnostic の後に event が 1 つでも積まれていたら
 * 何かが動いたので再開済み(null)。これが AC-1 の冪等と同じ条件: work stalled を 2 回叩いても
 * 末尾が同じ diagnostic のままなら二度目は積まない、と CLI 側で判断できる
 */
export function stallOf(events: readonly StallEventInput[]): Stall | null {
  const last = events.at(-1);
  if (last == null || last.kind !== "diagnostic") return null;
  const p = last.payload ?? {};
  if (p.reason !== "usage_limit") return null;
  const resets = typeof p.resets_at === "string" && !Number.isNaN(Date.parse(p.resets_at))
    ? new Date(p.resets_at)
    : null;
  return {
    reason: "usage_limit",
    at: last.createdAt,
    runtime: typeof p.runtime === "string" ? p.runtime : null,
    resetsAt: resets,
  };
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

/** task の合流(PBI-0447・図80c ⑥)で task の events に残す結果。busy / empty は何も起きていないので残さない。
 * `outside_scope` = 持ち場の外の path が在った(PBI-0649・記録すると task が `needs_user` になる) */
export const TASK_MERGE_RESULTS = ["applied", "conflict", "outside_scope"] as const;
/** 1 回の記録に載せる path の上限と 1 本の長さ(それ以上は記録から外す。合流そのものは全部見る) */
export const TASK_MERGE_PATHS_MAX = 1000;
export const TASK_MERGE_PATH_MAX_LENGTH = 4096;

export type MergeDecision =
  | { result: "applied"; paths: string[] }
  | { result: "conflict"; paths: string[] }
  | { result: "outside_scope"; paths: string[] }
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

/**
 * task の裁定 3 値(PBI-0648・図80c ⑦)。**status 値は足さない** —— 上流 workboard-contract から derive する
 * 10 値はそのままで、裁定は task の context `review/verdict` の本文に置く(版が差し戻しの周になる)
 */
export const TASK_REVIEW_VERDICTS = ["accept", "changes_requested", "reject"] as const;
export type TaskReviewVerdict = (typeof TASK_REVIEW_VERDICTS)[number];

/** 裁定の本文(端末の CAS に載る)から 3 値を読む。読めない物は null = 未裁定(「読めないから通す」に倒さない) */
export function taskReviewVerdict(body: unknown): TaskReviewVerdict | null {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  const v = (body as Record<string, unknown>).verdict;
  return (TASK_REVIEW_VERDICTS as readonly unknown[]).includes(v) ? (v as TaskReviewVerdict) : null;
}

export type TaskMergeGate =
  | { ok: true }
  | { ok: false; reason: "no_proof" | "not_reviewed" | "changes_requested" | "rejected" };

/**
 * 渡した仕事を親へ合流してよいか(PBI-0648)。**分岐の正本はここ 1 つ** —— MCP も CLI も呼ぶだけで
 * 独自の比較を書かない。cwd に 1 byte も触る前に通す門なので、迷った側は必ず「断る」に倒す:
 *  - `proofs` = その task の proof(古い順)。**最後の 1 本が `passed`** でなければ `no_proof`
 *    (「1 本でも passed が在る」だと、通した後に壊して failed を積んだ task が合流できてしまう)
 *  - `verdict` = `review/verdict` の本文(この端末で開けなければ呼び手が null を渡す = 未裁定)
 * ponytail: 裁定が「今の proof を見た物か」は版で測らない(PBI-0648 スコープ外の version cursor)。
 * 先に accept を貰ってから書き足す道は残る —— 塞ぐなら裁定に proof の版を載せる
 */
export function decideTaskMerge(proofs: readonly { status: string }[], verdict: unknown): TaskMergeGate {
  if (proofs.at(-1)?.status !== "passed") return { ok: false, reason: "no_proof" };
  const v = taskReviewVerdict(verdict);
  if (v === null) return { ok: false, reason: "not_reviewed" };
  if (v === "changes_requested") return { ok: false, reason: "changes_requested" };
  if (v === "reject") return { ok: false, reason: "rejected" };
  return { ok: true };
}

// ---------- 持ち場(PBI-0649・図80c ⑧) ----------

/** path の前方一致だけ。glob と読み違えられる文字はここで断る(下の briefPaths が先に落とす) */
const GLOBBY = /[*?[\]]/;

/**
 * 持ち場(`brief/allowed` / `brief/forbidden`)の本文から path の前置きを読む。
 * **規則は 1 つだけ —— repo 相対 path の前方一致**(`migrations/` `server/src/auth`)。
 * `*` や `?` を含む物は受けない: `*.sql` を glob のつもりで書いた人に「1 つも当たらない門」を
 * 黙って渡すと、守っていないのに緑になる(式 pin と同じ嘘)。要ると分かったら 1 規則足す。
 * 読めない物(配列でない・空文字・絶対 path・`..`・glob)は **null = 呼び手は fail-closed に倒す**
 * (`brief_unreadable`)。「読めないから全部許す」に倒さない(AC-X2)
 */
export function briefPaths(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0 || v.startsWith("/") || v.includes("\\")) return null;
    if (GLOBBY.test(v) || v.split("/").some((seg) => seg === "." || seg === "..")) return null;
    out.push(v);
  }
  return out;
}

/**
 * 合流してよい path だけか(PBI-0649・AC-5)。**判定の正本はここ 1 つ** —— MCP も CLI も `mergeTaskFolder` を
 * 通してこれを呼ぶだけで独自の比較を書かない。当たり方は前方一致だけなので `server/src/auth` は
 * `server/src/authz.ts` にも当たる —— 断り側に広く倒れるのは門として正しい向き(取りこぼしが危険な向き)。
 * **大文字小文字も区別しない**(module review 2026-09-16): 区別しない fs(この Mac の APFS)では `Migrations/070.sql` が
 * `migrations/` の中に落ちる。実測では project に一度 `Migrations/` が入ると checkpoint が folder へ運び、次の task が
 * 小文字で書いた file まで `Migrations/` として記録され、門を素通りした。区別する fs で広く断るのは上と同じ向き。
 * 呼び手は cwd に 1 byte も当てる前に、`index.lock` を取る前にこれを通す(AC-3 / AC-X3)
 */
export function decideMergePaths(
  changed: readonly string[],
  forbidden: readonly string[],
): { ok: true } | { ok: false; hit: string[] } {
  const fold = (s: string) => s.toLowerCase();
  const hit = [...new Set(changed.filter((p) => forbidden.some((f) => fold(p).startsWith(fold(f)))))].sort();
  return hit.length === 0 ? { ok: true } : { ok: false, hit };
}

/**
 * 面に出す裁定の 1 マス(PBI-0648・AC-6)。`round` = `review/verdict` の版 = 裁定を書いた回数なので、
 * 2 回目以降だけ数を添える(`changes_requested (2)` = 2 周目でまだ差し戻し)。CLI の表と `work_team` が同じ値を出す
 */
export function taskReviewCell(verdict: TaskReviewVerdict | null, round: number): string {
  return verdict === null ? "-" : round > 1 ? `${verdict} (${round})` : verdict;
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
