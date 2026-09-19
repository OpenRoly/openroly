// OpenRoly Account tools contract(要件 §16)の実装。
// runtime は paired credential で HTTP API を叩く。tool は §16 の 8 操作 + reply(PBI-0094)
// + notification_label(EP-0013 W3 triage)+ work_*(PBI-0400 / CAP-3 V9 — 裏が実在する 6 動詞だけ)。
// memory.* / task.* / browser.* 等は提供しない(要件 §16 の非提供リスト)。
//
// PBI-0006(要件 §9-11): send / inbox_read は sender・recipient 双方の account が
// active device を持つ時、自動的に E2EE(HPKE envelope)を使う。片方でも device が
// 無ければ平文のまま送受信する(server 側の強制拒否はしない設計。backlog/PBI-0006 参照)。

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  applyContextProfile,
  buildCapsule,
  estimateTokens,
  memoryFingerprint,
  memoryPayloadBytes,
  memoryScopeKey,
  normalizeGitRemote,
  reviewOpenedMemory,
  scanMemoryContent,
  validateMemoryInput,
  buildManifest,
  CHECKPOINT_TICK_INTERVAL_SECS,
  countInbox,
  findReservedContextKeys,
  inboxDeliveredKeys,
  renderCapsule,
  stallOf,
  summarizeContextIndex,
  decideTaskMerge,
  briefPaths,
  taskReviewCell,
  taskReviewVerdict,
  type BriefCounts,
  TASK_BRIEF_KEYS,
  TASK_MERGE_PATHS_MAX,
  TASK_REVIEW_KEY,
  WORK_CONTEXT_BRIEF_KEYS,
  TASK_REVIEW_VERDICTS,
  type TaskReviewVerdict,
  WORK_LIVENESS_TIMEOUT_SECS,
  mcpSessionRunId,
  type MessageContent,
} from "@openroly/core";
import { open, seal, type EncryptedEnvelope } from "@openroly/crypto-envelope";
import {
  CONTEXT_SEARCH_DEFAULT_MAX_TOKENS,
  buildBrief,
  credentialRejectedHint,
  listHubMcps,
  listHubSkills,
  openrolyHome,
  readHubRule,
  readHubSkill,
  readCasPayload,
  readerKeys,
  openIfEnvelope as openEnvelope,
  ownAccountPublicKey,
  sealForHandle,
  syncPendingContextValues,
  writeCasPayload,
  prepareContextValue,
  prepareSource,
  resolveContextEntries,
  type ContextIndexEntryInput,
  type ContextIndexRow,
} from "@openroly/adapter";
import { checkoutForkFolder, computeGitState, mergeTaskFolder } from "@openroly/core/node";
import { changedSinceGitState, type GitState } from "./git-state.ts";

export interface OpenRolyClientConfig {
  baseUrl: string;
  token: string;
  /** device key の永続化単位(credential store の kind と同じ)。省略時は "default" */
  deviceKind?: string;
  /** この MCP server を動かしている runtime の kind(PBI-0557)。OPENROLY_RUNTIME_KIND と同じ値。
   * work_current が「別の runtime で止まった work」を continue_candidate として出す時の自分側の値 */
  runtimeKind?: string;
  /** session の scope token(EP-0013 W3 / REQ-61 ② → PBI-0320)。broker が 5 lane + Manual の session の
   * env `OPENROLY_SESSION_SCOPE` に載せた物を server.ts が受けて全 request の header に付ける。
   * 無ければ header 自体を送らない(broker を通らない手元の session。agent 面の書き込みは 403 scope_required) */
  scopeToken?: string;
  /** source(repo 相対 path)を解く基点(PBI-0433)。MCP server は起動した cwd = runtime の作業 dir */
  cwd?: string;
}

export class OpenRolyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    /** 401 の時だけ: 戻り道(`openroly pair <kind>`)。無人で動く agent が生の 401 で止まらない(PBI-0264 有界レビュー) */
    hint?: string,
  ) {
    super(`OpenRoly API error ${status}: ${JSON.stringify(body)}${hint ? ` — ${hint}` : ""}`);
  }
}

async function call(
  config: OpenRolyClientConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      // triage scope(REQ-61 ②)。無効 / 期限切れ token は server 側が 401 invalid_scope_token で
      // 拒む(fail-closed)。在る時だけ送る
      ...(config.scopeToken ? { "x-openroly-session-scope": config.scopeToken } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new OpenRolyApiError(res.status, body, res.status === 401 ? credentialRejectedHint(config.deviceKind) : undefined);
  }
  return body;
}

/**
 * E2EE の作法(device upsert → 宛先公開鍵 → seal / open)は `@openroly/adapter` の e2ee.ts が正本。
 * `openroly agent`(PBI-0057)も同じ関数を使う —— client 側に 2 つ目の実装を置かない。
 */
const e2eeCall = (config: OpenRolyClientConfig) =>
  (path: string, init?: { method?: string; body?: unknown }) => call(config, path, init);

const deviceKindOf = (config: OpenRolyClientConfig) => config.deviceKind ?? "default";

/**
 * project の名乗り(PBI-0378): この folder の git origin を host/path に揃えた物。origin が無ければ repo root の path、
 * git の外なら null。server へは core の memoryScopeKey で hash にしてから出す(repo の名前は出さない)
 */
function projectIdOf(cwd: string): string | null {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  };
  const origin = git("remote", "get-url", "origin");
  if (origin !== "") return normalizeGitRemote(origin);
  const root = git("rev-parse", "--show-toplevel");
  return root === "" ? null : root;
}

/** 記憶の本文を account から開く。上がっていない・鍵が無い・壊れている は null(平文を作る道は無い) */
async function openMemoryBody(
  e2ee: ReturnType<typeof e2eeCall>,
  keys: { keyId: string; privateJwk: JsonWebKey }[],
  fingerprint: string,
): Promise<Uint8Array | null> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = (await e2ee(`/v1/context-values/${fingerprint}`)) as EncryptedEnvelope;
  } catch {
    return null;
  }
  const recipients = (Array.isArray(envelope?.recipients) ? envelope.recipients : []).filter(
    (r): r is EncryptedEnvelope["recipients"][number] => typeof (r as { device_key_id?: unknown } | null)?.device_key_id === "string",
  );
  const key = keys.find((k) => recipients.some((r) => r.device_key_id === k.keyId));
  if (!key) return null;
  return open({ ...envelope, recipients }, key).catch(() => null);
}

export interface SendInput {
  to: string;
  text?: string;
  urls?: string[];
  files?: { name: string; ref: string }[];
  force?: boolean;
}

export interface ReplyInput {
  thread_id: string;
  text?: string;
  urls?: string[];
  files?: { name: string; ref: string }[];
  force?: boolean;
  /** §18: 結果 item が処理対象の notification id を運ぶ(owner thread 報告のみ意味を持つ) */
  refs?: string[];
}

/** Work Core(PBI-0393/0395/0397)の work 行のうち、口が読む列だけ */
interface WorkRow {
  id: string;
  title: string;
  status: string;
  /** 明示の owner("<kind>:<id>"・PBI-0467)。root は自分の account、task は親から継承 */
  owner?: string;
  lease_epoch: number;
  lease_holder_run: string | null;
  lease_acquired_at: string | null;
  lease_expires_at: string | null;
  /** lease を握った runtime(PBI-0444: 未読 notice を「この runtime が握っている work」に絞る) */
  owner_runtime_id?: string | null;
  handled_runtime_id: string | null;
  handoff_note?: string | null;
  parent_work_id?: string | null;
  /** fork の枝(PBI-0440)。枝が何を知ってよいか */
  context_profile?: string;
}

/**
 * 「生きた lease」の述語。**server の 1 文と同じ条件を写す**(store の insertWorkEventRow /
 * writeWork: `lease_holder_run = ...` かつ `lease_expires_at is null or > now()`)。
 * holder だけ見て期限を見ないと、server が 409 で断る work を口が「今の仕事」と答える
 * (有界レビュー 2026-09-09: 実射で 409 と「今の仕事」が同時に成立した)
 */
const isLeaseLive = (w: WorkRow, now: number): boolean =>
  w.lease_holder_run != null && (w.lease_expires_at == null || new Date(w.lease_expires_at).getTime() > now);

export interface WorkProofInput {
  /** 打つ Run の名乗り。server が lease holder と照合する(写しではなく主張) */
  run_id: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  passed?: number;
  failed?: number;
  detail?: string;
}

/**
 * task の裁定 1 行(PBI-0648)。書けるのは project の lease を持つ run と human だけ。
 * `run_id` = 呼び手が名乗る自分の run(MCP の口では必須)。**名乗らないと server は runtime の owner 経路で判定する**ので、
 * Lead と task が同じ runtime(この Mac の既定 = 両方 claude)の時、task 自身が自分に accept を書けてしまう
 * (module review 2026-09-16 で実測)。名乗れば task を握る run の裁定は reserved_key で落ちる
 */
export interface WorkReviewInput {
  verdict: TaskReviewVerdict;
  feedback?: string;
  run_id?: string;
}

/** Immutable Work Capsule(PBI-0406)。8 要素はどれも optional(打ちたい分だけ渡す) */
export interface WorkCapsuleInput {
  run_id: string;
  goal?: unknown;
  current_state?: unknown;
  decisions?: unknown;
  unresolved_questions?: unknown;
  relevant_artifacts?: unknown;
  relevant_memory?: unknown;
  git_state?: unknown;
  capability_requirements?: unknown;
}

interface WorkCapsuleRow {
  id: string;
  work_id: string;
  version: number;
  write_epoch: number;
  run_id: string | null;
  body: unknown;
  content_hash: string;
  created_at: string;
}

/** lease を取った時刻(新しい順に並べる為。未設定は最古扱い) */
const leaseTime = (w: WorkRow): number =>
  w.lease_acquired_at == null ? 0 : new Date(w.lease_acquired_at).getTime();

/**
 * capsule を 1 つ打つ(0406 の口 → PBI-0414 で manifest 化)。**本文は server に送らない**(AC-1) ——
 * ここで build して端末の CAS(@openroly/adapter)へ書き、manifest だけを POST する。
 * POST の組み立てを 2 箇所に書かない —— PBI-0408 の自動 checkpoint(30 秒 tick / proof 直後の
 * 即時 push)は、この関数ではなく公開 API の `work_capsule` をそのまま呼ぶ
 * (packages/mcp/src/checkpoint.ts)。
 */
const pushCapsule = async (
  config: OpenRolyClientConfig,
  workId: string,
  w: Pick<WorkRow, "lease_epoch">,
  runId: string,
  fields: Record<string, unknown>,
) => {
  const built = buildCapsule(fields);
  const written = await writeCasPayload(built.body);
  const manifest = buildManifest(built.body, { hash: written.hash, size: written.size, mode: "0600" });
  const result = (await call(config, `/v1/works/${encodeURIComponent(workId)}/capsules`, {
    body: { runId, expectedWriteEpoch: w.lease_epoch, ...manifest },
  })) as { capsule: unknown; deduped: boolean };
  return { ...result, dropped_keys: built.droppedKeys };
};

/** Work Project に publish する物(PBI-0433・手描き 1 枚目)。value は端末の CAS に書かれ server には索引だけが行く */
export interface WorkContextPutInput {
  /** key → value(次の agent が要る事実) */
  context?: Record<string, unknown>;
  /** repo 相対 path(次の agent が読む file) */
  sources?: string[];
  /** 書き手の名乗り(記録だけ) */
  run_id?: string;
  /** key → 最後に見た版。新しい版が在ると呼び出し全体が stale_version で落ちる */
  expected_versions?: Record<string, number>;
}

export type WorkHandoffInput = WorkContextPutInput & { to?: string; note?: string };

export interface WorkContextSearchInput {
  keys?: string[];
  prefix?: string;
  kind?: "context" | "source";
  /** 端末側で key と value の文字列に部分一致 */
  query?: string;
  /** PBI-0438: 値を返さず est_tokens と preview だけ(2 段取得の 1 段目) */
  index_only?: boolean;
  /** PBI-0438: 1 回で返す量の上限(既定 2,000・上限 20,000。入らない行は丸ごと外して budget に残す) */
  max_tokens?: number;
}

/** PBI-0378: memory_propose の入力(schemas.ts の memoryProposeInputShape と同じ形) */
export interface MemoryProposeInput {
  scope: string;
  type: string;
  content: string;
  source_work_id?: string;
  run_id?: string;
  supersedes?: string;
}

/** PBI-0378: memory_search の入力 */
export interface MemorySearchInput {
  /** 端末で開いた本文にどれかの語が含まれる物(大文字小文字は区別しない) */
  query?: string;
  /** 引いた記録を残す仕事 */
  work_id?: string;
  max_tokens?: number;
}

/** GET /v1/memory の 1 行(本文は無い) */
interface MemoryIndexRow {
  id: string;
  scope: string;
  scope_key: string | null;
  type: string;
  fingerprint: string;
  source_work_id: string | null;
  source_runtime_kind: string | null;
  created_at: string;
}

/**
 * PBI-0437: `auto/`(30 秒 tick の事実)と `inbox/`(work_message)は agent の手書きで上書きさせない。
 * 壁は agent が呼ぶ口に置き、tick だけが `allow` で通る(CAS に書く前・task を作る前に落とす)。
 * PBI-0649: `brief`(持ち場と完了条件)は **渡す時だけ** 通る —— `work_task_create` が `brief` で呼び、
 * 受け取った task 自身は他の予約 key と同じに落ちる(本物の壁は server の `decideContextWrite`)
 */
type ReservedMode = "reject" | "brief" | "allow";
const assertNoReservedKeys = (context: Record<string, unknown> | undefined, mode: ReservedMode = "reject"): void => {
  if (mode === "allow") return;
  const allowed = mode === "brief" ? (WORK_CONTEXT_BRIEF_KEYS as readonly string[]) : [];
  const reserved = findReservedContextKeys(Object.keys(context ?? {})).filter((k) => !allowed.includes(k));
  if (reserved.length === 0) return;
  throw new Error(
    `reserved_key: ${reserved.join(", ")} — auto/ is written by the 30-second checkpoint tick, inbox/ by work_message, ` +
      `review/ by work_review and brief/ only by whoever hands the task out (${WORK_CONTEXT_BRIEF_KEYS.join(", ")} on work_task_create). ` +
      "Use your own keys (goal, next_step, decisions, open_questions, failed_attempts, verified_findings)",
  );
};

/** 渡す側が書く持ち場と完了条件。`null` = 行は在るが本文をこの端末で開けない / 形が違う(= 合流は断る) */
export interface TaskBrief {
  allowed: string[] | null;
  forbidden: string[] | null;
}

const briefRowsOf = (entries: readonly ContextIndexRow[]): ContextIndexRow[] =>
  entries.filter((e) => e.kind === "context" && e.scope !== "project" && (WORK_CONTEXT_BRIEF_KEYS as readonly string[]).includes(e.key));

/**
 * PBI-0649: 索引の `brief/` 行から持ち場を開く。無ければ null(brief 無し = 今まで通り全部許す)。
 * **行が在るのに値が来なかった時は `null`**(この端末に無い・予算で外れた・形が違う)—— 呼び手は
 * fail-closed に倒す(AC-X2「読めないから全部許す」を作らない)
 */
const resolveBrief = async (config: OpenRolyClientConfig, entries: readonly ContextIndexRow[]): Promise<TaskBrief | null> => {
  const rows = briefRowsOf(entries);
  if (rows.length === 0) return null;
  const resolved = await resolveContextEntries(rows, {
    cwd: config.cwd ?? process.cwd(),
    account: { call: e2eeCall(config), deviceKind: deviceKindOf(config) },
  });
  const pick = (key: string): string[] | null => {
    if (!rows.some((r) => r.key === key)) return [];
    const e = resolved.entries.find((x) => x.key === key) as { value?: unknown; missing_on_device?: boolean } | undefined;
    return e == null || e.missing_on_device === true ? null : briefPaths(e.value);
  };
  return { allowed: pick(TASK_BRIEF_KEYS.allowed), forbidden: pick(TASK_BRIEF_KEYS.forbidden) };
};

/** task の持ち場を 1 往復で読む(`work_team` と合流の門が使う。索引を既に持っているなら resolveBrief を直に呼ぶ) */
const readTaskBrief = async (config: OpenRolyClientConfig, taskId: string): Promise<TaskBrief | null> => {
  const res = (await call(
    config,
    `/v1/works/${encodeURIComponent(taskId)}/context?prefix=${encodeURIComponent("brief/")}`,
  )) as { entries: ContextIndexRow[] };
  return resolveBrief(config, res.entries);
};

/** 索引 1 行に出す持ち場の数(AC-6)。brief が無い work では出さない */
const briefCountsOf = (brief: TaskBrief | null): BriefCounts | null =>
  brief == null ? null : { allowed: brief.allowed?.length ?? null, forbidden: brief.forbidden?.length ?? null };

/** 表の 1 マス(`work_team` / `openroly work team`)。brief 無しは `-` */
const briefScopeCell = (brief: TaskBrief | null): string => {
  const c = briefCountsOf(brief);
  return c == null ? "-" : `${c.allowed ?? "?"} allowed / ${c.forbidden ?? "?"} forbidden`;
};

/** PBI-0649 AC-X2: 持ち場が在るのに本文を開けない時の断り方(合流は 1 byte も当てずに止まる) */
const BRIEF_UNREADABLE = (taskId: string): string =>
  `brief_unreadable: ${taskId} has ${TASK_BRIEF_KEYS.forbidden}, but its text cannot be read on this device — ` +
  "nothing was merged. Merge from the device that wrote the brief, or have a human rewrite it there";

/**
 * PBI-0648: task の裁定 1 行を読む。索引 1 行(`review/verdict`)+ 本文(この端末の CAS、無ければ account)。
 * **親の Work Project の行(scope project)は数えない** —— task 自身に付いた裁定だけが門を開ける。
 * 本文がこの端末で開けなければ `body: null` = 未裁定(「読めないから通す」に倒さない・AC-X2)。
 * `round` = その key の版 = 裁定を書いた回数(差し戻しの周)
 */
const readTaskReview = async (config: OpenRolyClientConfig, taskId: string): Promise<{ body: unknown; round: number }> => {
  const res = (await call(
    config,
    `/v1/works/${encodeURIComponent(taskId)}/context?key=${encodeURIComponent(TASK_REVIEW_KEY)}`,
  )) as { entries: ContextIndexRow[] };
  const row = res.entries.find((e) => e.kind === "context" && e.key === TASK_REVIEW_KEY && e.scope !== "project");
  if (!row) return { body: null, round: 0 };
  const resolved = await resolveContextEntries([row], {
    cwd: config.cwd ?? process.cwd(),
    account: { call: e2eeCall(config), deviceKind: deviceKindOf(config) },
  });
  const entry = resolved.entries[0] as { value?: unknown; missing_on_device?: boolean } | undefined;
  return { body: entry?.missing_on_device === true ? null : (entry?.value ?? null), round: row.version };
};

/** PBI-0648: 門が断った理由を「次に何をすればよいか」に訳す(4 値は core の decideTaskMerge が決める) */
const TASK_MERGE_GATE_HINTS: Record<"no_proof" | "not_reviewed" | "changes_requested" | "rejected", (taskId: string) => string> = {
  no_proof: (t) => `the last proof on ${t} is not passed — the run doing the task records one with work_proof`,
  not_reviewed: (t) => `no verdict on ${t} that this device can read — the Work Project's lead writes one with work_review`,
  changes_requested: (t) => `the lead sent ${t} back (changes_requested) — read review/verdict with work_context_search and fix it first`,
  rejected: (t) => `the lead rejected ${t}`,
};

/** context / sources を端末で準備し、server へ送る索引だけを返す(value は返り値に入らない) */
const prepareEntries = async (
  config: OpenRolyClientConfig,
  input: WorkContextPutInput,
  reserved: ReservedMode = "reject",
): Promise<ContextIndexEntryInput[]> => {
  assertNoReservedKeys(input.context, reserved);
  const cwd = config.cwd ?? process.cwd();
  const out: ContextIndexEntryInput[] = [];
  for (const [key, value] of Object.entries(input.context ?? {})) out.push(await prepareContextValue(key, value));
  for (const path of input.sources ?? []) out.push(await prepareSource(cwd, path));
  // PBI-0446: 新しく CAS に置いた値を account へ seal して上げる。落ちても put は通す(印が残り 30 秒 tick が再送)
  if (Object.keys(input.context ?? {}).length > 0) await syncPendingContextValues(e2eeCall(config)).catch(() => {});
  const expected = input.expected_versions ?? {};
  return out.map((e) => (expected[e.key] !== undefined ? { ...e, expected_version: expected[e.key] } : e));
};

/** handoff の 1 回(work_handoff と work_task_create が共用する —— POST の組み立てを 2 箇所に書かない) */
const handoffCall = async (config: OpenRolyClientConfig, workId: string, input: WorkHandoffInput, reserved: ReservedMode = "reject") => {
  const entries = input.context || input.sources ? await prepareEntries(config, input, reserved) : [];
  return call(config, `/v1/works/${encodeURIComponent(workId)}/handoff`, {
    body: {
      ...(input.to !== undefined ? { runtimeId: input.to } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(entries.length > 0 ? { entries } : {}),
      ...(input.run_id ? { runId: input.run_id } : {}),
    },
  });
};

/** この credential の runtime(id と kind)。token が human でも config.runtimeKind があれば kind は残る */
const resolveMe = async (config: OpenRolyClientConfig): Promise<{ runtimeId: string | null; kind: string | null }> => {
  const agents = (await call(config, "/v1/agents")) as {
    me: { runtime_id: string | null };
    runtimes: { id: string; kind: string }[];
  };
  const runtimeId = agents.me.runtime_id;
  const kindFromId = runtimeId ? (agents.runtimes.find((r) => r.id === runtimeId)?.kind ?? null) : null;
  return { runtimeId, kind: kindFromId ?? config.runtimeKind ?? null };
};

/** 係がこの runtime か(handoff の `to` は runtime id でも kind でも受ける) */
const isMine = (handled: string | null | undefined, me: { runtimeId: string | null; kind: string | null }): boolean =>
  handled != null && ((me.runtimeId != null && handled === me.runtimeId) || (me.kind != null && handled === me.kind));

/** task の folder(PBI-0447)。path は task id から決まるので server に保存しない */
const taskFolder = (taskId: string): string => join(openrolyHome(), "worktrees", taskId);

/** Work Project に task を作る時の入力(PBI-0434)。to / note / context / sources を付ければそのまま渡す */
export type WorkTaskCreateInput = WorkHandoffInput & { title: string };

/** §16 contract の 8 操作 + reply(PBI-0094)。MCP server と検査の双方がこの実装を使う */
export function createAccountTools(config: OpenRolyClientConfig) {
  // notification_label の summary の seal 宛先 = 自分の handle(自分の item にだけ付く)。whoami は
  // 1 回だけ引いて cache する(tool 呼び出し毎の往復を避ける)。reply はこれを使わない(PBI-0261)
  let ownHandle: Promise<string> | null = null;
  const resolveOwnHandle = () =>
    (ownHandle ??= (async () => {
      const who = (await call(config, "/v1/whoami")) as { handle: string };
      return who.handle;
    })());
  // PBI-0444: 未読 notice の cache。server を叩くのは最大 tick の間隔に 1 回。既読にした直後は捨てる
  let notice: { at: number; text: Promise<string | null> } | null = null;
  return {
    whoami: async () => {
      const who = (await call(config, "/v1/whoami")) as Record<string, unknown>;
      let messages: unknown[] = [];
      try {
        const body = await call(config, "/v1/inbox/messages");
        if (Array.isArray(body)) messages = body;
      } catch {
        /* stub / 古い server は inbox 件数だけ（F43 と同じ加算を落とす） */
      }
      const brief = buildBrief(who, messages);
      return { ...who, unread: brief.unread + brief.requests, requests: brief.requests };
    },
    inbox_list: async () => {
      // dogfood F49: /v1/inbox/messages は direction=in だけ。CLI は thread の最終行を
      // inbox + requests の 2 bucket で出す。同じ 2 口に揃える。
      const rows: Record<string, unknown>[] = [];
      for (const bucket of ["inbox", "requests"] as const) {
        const threads = (await call(config, `/v1/inbox?bucket=${bucket}`)) as {
          id: string;
          peer_display?: string;
          last_message?: Record<string, unknown> | null;
        }[];
        for (const t of threads) {
          const m = t.last_message;
          if (!m) continue;
          const { content: _content, ...meta } = m;
          rows.push({
            ...meta,
            bucket,
            thread_id: t.id,
            sender_display: t.peer_display ?? meta.sender_display,
          });
        }
      }
      return rows;
    },
    inbox_read: async (messageId: string) => {
      const message = (await call(config, `/v1/messages/${messageId}`)) as { content: MessageContent };
      return openEnvelope(deviceKindOf(config), message, e2eeCall(config));
    },
    // PBI-0579: message の thread(peer_address / peer_handle)。MCP server が untrusted な lane で「値を運んできた送り手」を引く
    thread_get: (threadId: string) => call(config, `/v1/threads/${encodeURIComponent(threadId)}`),
    send: async (input: SendInput) => {
      const { to, text, urls, files, force } = input;
      const content = await sealForHandle(e2eeCall(config), deviceKindOf(config), to, { text, urls, files });
      return call(config, "/v1/send", { body: { to, force, ...content } });
    },
    // thread への返信(PBI-0094 → **PBI-0261 で seal 先が thread の相手に**)。E2EE は send と同じ作法 —
    // seal 先は `GET /v1/threads/:id` の `peer_handle`(相手の account 鍵 + 自分の写し・図9)。自分宛て
    // thread(owner instruction)は peer_handle = 自 handle なので今までどおり 1 本。前は常に自 handle へ
    // 封をしていたので、peer thread への AUTO 返信は **相手が永久に開けない 1 通**だった(`openroly agent` と
    // 同じ材料で同じ事をする)。
    // thread が読めない(404 / 403 / 500 / 通信断)時は **送らない**(AC-X1) —— 自 handle へ封をする
    // fallback は同じ「相手が開けない 1 通」をまた作る。peer_handle が null(外部 mail peer / 相手が
    // account を消した)は平文 —— それ以外の壊れた応答は平文の合図にしない(PBI-0259 と同じ読み方)。
    // refs(§18)は本文と別の平文 metadata として body に載せる(id のみ — server が検証する)
    reply: async (input: ReplyInput) => {
      const { thread_id, text, urls, files, force, refs } = input;
      let peerHandle: string | null;
      try {
        const thread = (await call(config, `/v1/threads/${thread_id}`)) as { peer_handle?: unknown };
        const ph = thread?.peer_handle;
        if (ph !== null && typeof ph !== "string") throw new Error("thread response has no peer_handle");
        peerHandle = ph;
      } catch (e) {
        throw new Error(
          `could not read thread ${thread_id} to find who to encrypt the reply for — not sending: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
      const content = peerHandle
        ? await sealForHandle(e2eeCall(config), deviceKindOf(config), peerHandle, { text, urls, files })
        : { text, urls, files };
      return call(config, `/v1/threads/${thread_id}/reply`, {
        body: { force, ...(refs?.length ? { refs } : {}), ...content },
      });
    },
    // PBI-0129: agent directory。自 account の runtime(live 付き)と宛先一覧を 1 回で返す。
    // 読み取りのみ・自 account 内のみ。peer の presence は含まない(要件 v0.6 §28)
    agents_list: () => call(config, "/v1/agents"),
    contacts_list: () => call(config, "/v1/contacts"),
    contacts_get: (contactId: string) => call(config, `/v1/contacts/${contactId}`),
    mark_read: (messageId: string) =>
      call(config, `/v1/messages/${messageId}/read`, { body: {} }),
    // PBI-0031: 自分が起こした approval の pending/approved/rejected を polling できる。
    // content は server が返さない(human の編集後本文を runtime に見せる理由が無い)
    approval_get: (approvalId: string) => call(config, `/v1/approvals/${approvalId}`),
    // triage の出力面(EP-0013 W3 / REQ-64)。label は notification item にだけ付く。
    // summary は自 handle の device 鍵で seal してから送る — 平文 summary の送信面は作らない
    // (account に device が 0 本で seal 出来ない時は 422 で失敗させる。平文 fallback は downgrade)
    notification_label: async (messageId: string, label: string, summary?: string) => {
      const body: { label: string; summary?: { envelope: unknown } } = { label };
      if (summary !== undefined && summary.trim() !== "") {
        const handle = await resolveOwnHandle();
        const sealed = await sealForHandle(e2eeCall(config), deviceKindOf(config), handle, {
          text: summary,
        });
        if (!("envelope" in sealed)) {
          throw new OpenRolyApiError(422, { error: "summary_requires_device_key" });
        }
        body.summary = { envelope: sealed.envelope };
      }
      try {
        return await call(config, `/v1/messages/${messageId}/label`, { body });
      } catch (e) {
        if (e instanceof OpenRolyApiError && e.status === 403) {
          throw new OpenRolyApiError(403, {
            error: "scope_required",
            hint: "MCP triage needs a broker session (OPENROLY_SESSION_SCOPE). Label from a woken runtime, not a desktop-started Grok.",
          });
        }
        throw e;
      }
    },
    // 自然言語 rule(EP-0013 W4 / REQ-54)。compile は runtime、正規化と layer 導出は server。
    // 応答の正規化 rule を owner に echo する(REQ-54「解釈を同一 thread で返す」)
    rules_put: (input: { nl: string; scope?: unknown; action: unknown }) =>
      call(config, "/v1/rules", { body: input }),
    // rule の一覧。content rule の nl / sender / keywords は content_scope(envelope)で
    // 返る為、device 鍵で開いて scope に戻す(封入平文が MessageContent 形でない為、
    // inbox_read の openIfEnvelope ではなく open を直接使う)
    rules_list: async () => {
      const rules = (await call(config, "/v1/rules")) as {
        nl: string | null;
        scope: Record<string, unknown>;
        content_scope: { envelope: unknown } | null;
      }[];
      // 開ける鍵は inbox_read と同じ順(account 鍵の grant → device 鍵)。ここで device 鍵だけを
      // 見ると、rule の私的部だけが agent から読めない形に片落ちする(PBI-0247)
      let keys: Awaited<ReturnType<typeof readerKeys>> | null = null;
      return Promise.all(
        rules.map(async (rule) => {
          if (rule.content_scope?.envelope == null) return rule;
          keys ??= await readerKeys(deviceKindOf(config), e2eeCall(config));
          const envelope = rule.content_scope.envelope as EncryptedEnvelope;
          const own = keys.find((k) => envelope.recipients?.some((r) => r.device_key_id === k.keyId));
          if (!own) return rule;
          try {
            const bytes = await open(envelope, own);
            const plain = JSON.parse(new TextDecoder().decode(bytes)) as {
              nl: string;
              sender?: string;
              keywords?: string[];
            };
            const { content_scope, ...rest } = rule;
            return {
              ...rest,
              nl: plain.nl,
              scope: {
                ...rest.scope,
                ...(plain.sender !== undefined ? { sender: plain.sender } : {}),
                ...(plain.keywords !== undefined ? { keywords: plain.keywords } : {}),
              },
            };
          } catch {
            // 開けない device でも metadata 部分の一覧は壊さない(envelope はそのまま残す)
            return rule;
          }
        }),
      );
    },
    // ---------- Work Core の口(PBI-0400 / CAP-3 V9・図79) ----------
    // 裏(route / 表)は 0393 / 0395 / 0397 が作った物をそのまま叩く —— **server の route も
    // 判定も 1 つも足さない**。ここに在るのは「shell で openroly を叩かなくて済む」為の口だけ。
    /**
     * 今の仕事 1 件。**選ぶ条件は lease だけ**(`isLeaseLive` = holder が立っていて期限内 —
     * server が書き込みを許す条件と同じ)。係(`handled_runtime_id`)は持続する割り当てであって「動いている証拠」では
     * ないので **選ぶ条件に混ぜず別 field で返す**(PBI-0397 の破れ 1・図78 と同じ読み方)。
     * lease 付きが複数在る時は最新 1 件。係が自分なら `ambiguous: false`（F55 / continue --to 自分と同じ）。
     * 係が無い live が複数だけ `ambiguous: true`。無ければ `null`
     */
    work_current: async () => {
      const works = (await call(config, "/v1/works")) as WorkRow[];
      const now = Date.now();
      const me = await resolveMe(config);
      const held = works
        .filter((w) => isLeaseLive(w, now) && w.status !== "done")
        .sort((a, b) => leaseTime(b) - leaseTime(a));
      // F55: live が複数でも係が自分なら newest 1 本。probe が ambiguous を立てない（continue --to 自分と同じ）
      const mineHeld = held.filter((w) => isMine(w.handled_runtime_id, me));
      // PBI-0557: 別の runtime が usage limit で止まった work を候補として出す(自分の runtime で
      // 止まった物は出さない — それは自分が続けるべき仕事であって移し先の候補ではない)。
      // live の work の event 末尾だけが根拠(stallOf)。複数止まっていたら lease の新しい方 1 本
      let candidate: { work_id: string; title: string; runtime: string; reason: string; at: string } | null = null;
      const mine = config.runtimeKind ?? null;
      for (const h of held) {
        const ev = (await call(config, `/v1/works/${encodeURIComponent(h.id)}/events`)) as {
          kind: string;
          payload: Record<string, unknown> | null;
          occurred_at: string;
        }[];
        const s = stallOf(
          ev.map((x) => ({ kind: x.kind, payload: x.payload, createdAt: new Date(x.occurred_at) })),
        );
        if (s && s.runtime != null && s.runtime !== mine) {
          candidate = {
            work_id: h.id,
            title: h.title,
            runtime: s.runtime,
            reason: s.reason,
            at: s.at.toISOString(),
          };
          break;
        }
      }
      const w = mineHeld[0] ?? held[0];
      if (w) {
        return {
          work_id: w.id,
          title: w.title,
          status: w.status,
          lease: { epoch: w.lease_epoch, holder_run: w.lease_holder_run },
          handled_runtime_id: w.handled_runtime_id ?? null,
          lease_live: true,
          ambiguous: mineHeld.length > 0 ? false : held.length > 1,
          ...(candidate ? { continue_candidate: candidate } : {}),
        };
      }
      // dogfood F47: continue で grok に渡したあと合成 run がすぐ空き、live lease が 0 になる。
      // 係が自分の未完了 work を今の仕事として返す（書き込み lease ではないので standing）。
      const standing = works
        .filter((row) => row.status !== "done" && isMine(row.handled_runtime_id, me))
        .sort((a, b) => leaseTime(b) - leaseTime(a));
      const s = standing[0];
      if (!s) return candidate == null ? null : { continue_candidate: candidate };
      // dogfood F50: continue-wtr_ の合成 run は心拍せずすぐ空く。この MCP process が claim する。
      const runId = mcpSessionRunId(config.runtimeKind);
      try {
        const claimed = (await call(config, `/v1/works/${encodeURIComponent(s.id)}/claim`, {
          body: { runId },
        })) as WorkRow;
        return {
          work_id: claimed.id,
          title: claimed.title,
          status: claimed.status,
          lease: { epoch: claimed.lease_epoch, holder_run: claimed.lease_holder_run },
          handled_runtime_id: claimed.handled_runtime_id ?? s.handled_runtime_id ?? null,
          lease_live: true,
          standing: false,
          ambiguous: standing.length > 1,
          ...(candidate ? { continue_candidate: candidate } : {}),
        };
      } catch {
        /* claim できなければ standing のまま返す */
      }
      return {
        work_id: s.id,
        title: s.title,
        status: s.status,
        lease: { epoch: s.lease_epoch, holder_run: s.lease_holder_run },
        handled_runtime_id: s.handled_runtime_id ?? null,
        lease_live: false,
        standing: true,
        ambiguous: standing.length > 1,
        ...(candidate ? { continue_candidate: candidate } : {}),
      };
    },
    work_get: (workId: string) => call(config, `/v1/works/${encodeURIComponent(workId)}`),
    /** event log の差分取得。`after` は work_sequence の cursor(CLI の `work events --after` と同じ) */
    work_events: (workId: string, after?: number) =>
      call(
        config,
        `/v1/works/${encodeURIComponent(workId)}/events${after != null ? `?after=${encodeURIComponent(String(after))}` : ""}`,
      ),
    /**
     * proof を打つ(work_proofs 1 行 + work_events 1 行 —— CLI `openroly work proof` と同じ 2 行)。
     * **`run_id` は呼び手が名乗る**。work から読んだ `lease_holder_run` を黙って写すと、lease を
     * 持たない Run の proof が holder の名前で残る = 「誰が打ったか」が嘘になる(攻撃③)。
     * server の 1 文(`lease_holder_run = runId`)が名乗りを照合して落とす。
     * epoch は今の lease から読む(staleness の楽観検査。最終判定は同じ 1 文の中)
     */
    work_proof: async (workId: string, input: WorkProofInput) => {
      const w = (await call(config, `/v1/works/${encodeURIComponent(workId)}`)) as WorkRow;
      if (!w.lease_holder_run) {
        throw new Error(
          `no run holds work ${workId} — claim it first (openroly work claim ${workId} --run <runId>)`,
        );
      }
      return call(config, `/v1/works/${encodeURIComponent(workId)}/proofs`, {
        body: {
          runId: input.run_id,
          expectedWriteEpoch: w.lease_epoch,
          status: input.status,
          ...(input.passed !== undefined ? { passed: input.passed } : {}),
          ...(input.failed !== undefined ? { failed: input.failed } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
        },
      });
    },
    /**
     * capsule を 1 つ打つ(PBI-0406 / CAP-3 V2)。**`run_id` は呼び手が名乗る**(work_proof と
     * 同じ理由 —— lease_holder_run を黙って写さない)。8 要素以外(conversation 等)は route の
     * buildCapsule が壁を持つので、ここでは runId/epoch を切り出して残りをそのまま渡すだけ
     */
    work_capsule: async (workId: string, input: WorkCapsuleInput) => {
      const w = (await call(config, `/v1/works/${encodeURIComponent(workId)}`)) as WorkRow;
      if (!w.lease_holder_run) {
        throw new Error(
          `no run holds work ${workId} — claim it first (openroly work claim ${workId} --run <runId>)`,
        );
      }
      const { run_id, ...fields } = input;
      return pushCapsule(config, workId, w, run_id, fields);
    },
    /** 版の一覧(version 昇順)。中身は version を選んだ後で work_capsule の応答を見返す運用 */
    work_capsules: (workId: string) =>
      call(config, `/v1/works/${encodeURIComponent(workId)}/capsules`) as Promise<WorkCapsuleRow[]>,
    /**
     * triage で action と判定した thread を work へ昇格する。2 回目は server が 409
     * already_promoted + 同じ work_id を返すので、**error にせず同じ形で返す**(冪等・PBI-0397)。
     * 呼び手が「1 回目か 2 回目か」で分岐を持たずに済む
     */
    work_promote: async (threadId: string) => {
      try {
        const work = (await call(config, "/v1/works/promote", { body: { threadId } })) as WorkRow;
        return { work_id: work.id, already_promoted: false, work };
      } catch (e) {
        if (e instanceof OpenRolyApiError && e.status === 409) {
          const workId = (e.body as { work_id?: unknown } | null)?.work_id;
          if (typeof workId === "string") return { work_id: workId, already_promoted: true, work: null };
        }
        throw e;
      }
    },
    /**
     * 係の差し替え(lease holder の制約は受けない = 0397 の handoff route)。**PBI-0433 で Work Project への
     * publish を同じ 1 回に載せられる**(手描き 1 枚目の Agent A): context の value は端末の CAS へ、
     * source は hash だけ —— server には索引だけが 1 tx で届く(係と索引が片方だけ立つ事は無い)
     */
    work_handoff: (workId: string, input: WorkHandoffInput) => handoffCall(config, workId, input),
    /** handoff せずに Work Project へ publish する(並列で動いている agent が途中で書く口) */
    work_context_put: async (workId: string, input: WorkContextPutInput, opts: { allowReserved?: boolean } = {}) => {
      const entries = await prepareEntries(config, input, opts.allowReserved === true ? "allow" : "reject");
      if (entries.length === 0) throw new Error("nothing to put — pass context and/or sources");
      return call(config, `/v1/works/${encodeURIComponent(workId)}/context`, {
        method: "PUT",
        body: { entries, ...(input.run_id ? { runId: input.run_id } : {}) },
      });
    },
    /**
     * task に書いた key を Work Project へ公開する(PBI-0443)。値は同じ hash を写すだけなので CAS に書き足す物は無い。
     * 全部か 0 件・project の行に published_from(task@版)が残る
     */
    work_context_publish: (
      workId: string,
      input: { keys: string[]; run_id?: string; expected_versions?: Record<string, number> },
    ) =>
      call(config, `/v1/works/${encodeURIComponent(workId)}/context/publish`, {
        body: {
          keys: input.keys,
          ...(input.expected_versions ? { expected_versions: input.expected_versions } : {}),
          ...(input.run_id ? { runId: input.run_id } : {}),
        },
      }) as Promise<{ entries: ContextIndexRow[] }>,
    /**
     * 始める前に要る物だけ取る(手描き 1 枚目の Agent B)。server で key / prefix / kind を絞り、
     * value は端末の CAS から開き、source は手元で再 hash する(組み直しは adapter の 1 関数・CLI と共用)
     */
    work_context_search: async (workId: string, input: WorkContextSearchInput = {}) => {
      const params = new URLSearchParams();
      if (input.kind) params.set("kind", input.kind);
      if (input.prefix) params.set("prefix", input.prefix);
      for (const key of input.keys ?? []) params.append("key", key);
      const qs = params.toString();
      const res = (await call(
        config,
        `/v1/works/${encodeURIComponent(workId)}/context${qs ? `?${qs}` : ""}`,
      )) as { entries: ContextIndexRow[]; hidden_by_profile?: string[] };
      const resolved = await resolveContextEntries(res.entries, {
        cwd: config.cwd ?? process.cwd(),
        query: input.query,
        indexOnly: input.index_only,
        maxTokens: input.max_tokens,
        // PBI-0446: この端末に無い値は account から開く(鍵は inbox_read と同じ readerKeys の順)
        account: { call: e2eeCall(config), deviceKind: deviceKindOf(config) },
      });
      // PBI-0444: 値が渡った未読の inbox/ だけを既読に。落ちても値は返す —— 読んでいないのに既読にする方向には倒さず、
      // 次の search でもう一度送る(POST は冪等)
      const delivered = inboxDeliveredKeys(resolved.entries);
      if (delivered.length > 0) {
        await call(config, `/v1/works/${encodeURIComponent(workId)}/context/reads`, { body: { keys: delivered } }).then(
          () => {
            notice = null;
          },
          () => {},
        );
      }
      // PBI-0440: 枝の Context Profile で server が隠した key(名前だけ)。無い = 絞っていない work
      return { work_id: workId, ...resolved, ...(res.hidden_by_profile ? { hidden_by_profile: res.hidden_by_profile } : {}) };
    },
    /**
     * PBI-0378(図86): 覚える候補を 1 つ出す。形の壁と注入検査は **送る前に**この端末で行い、落ちたら HTTP を 1 本も打たない。
     * 本文は account 鍵へ seal して fingerprint の置き場に預け、server には索引だけを出す(使える記憶にするのは人)
     */
    memory_propose: async (input: MemoryProposeInput) => {
      let scopeKey: string | null = null;
      if (input.scope === "project") {
        const projectId = projectIdOf(config.cwd ?? process.cwd());
        if (projectId === null) return { proposed: false, error: "not_in_a_repository" };
        scopeKey = await memoryScopeKey(projectId);
      }
      const checked = validateMemoryInput({ scope: input.scope, scope_key: scopeKey, type: input.type, content: input.content });
      if (!checked.ok) return { proposed: false, error: checked.reason };
      const scan = scanMemoryContent(checked.payload.content);
      if (!scan.ok) return { proposed: false, blocked: scan.reason };
      const bytes = memoryPayloadBytes(checked.payload);
      const fingerprint = await memoryFingerprint(checked.payload);
      const envelope = await seal(bytes, [await ownAccountPublicKey(e2eeCall(config))]);
      await call(config, `/v1/context-values/${fingerprint}`, { method: "PUT", body: envelope });
      const res = (await call(config, "/v1/memory", {
        body: {
          scope: checked.payload.scope,
          scope_key: checked.payload.scope_key,
          type: checked.payload.type,
          fingerprint,
          size: bytes.byteLength,
          ...(input.source_work_id ? { source_work_id: input.source_work_id } : {}),
          ...(input.run_id ? { source_run_id: input.run_id } : {}),
          ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        },
      })) as { record: { id: string; status: string }; created: boolean };
      return { proposed: true, id: res.record.id, status: res.record.status, created: res.created };
    },
    /**
     * PBI-0378(図86): 承認済みの記憶を引く(この repo の project と personal)。本文はこの端末で開き、core の
     * reviewOpenedMemory(hash 照合 + 注入検査)を通った物だけを返す —— tool を迂回して置かれた候補もここで止まる。
     * 返した record id は /v1/memory/recalled に残す(順 10 の bench が「誰が何を使ったか」を読む口)
     */
    memory_search: async (input: MemorySearchInput = {}) => {
      const { records } = (await call(config, "/v1/memory")) as { records: MemoryIndexRow[] };
      const projectId = projectIdOf(config.cwd ?? process.cwd());
      const projectKey = projectId === null ? null : await memoryScopeKey(projectId);
      const e2ee = e2eeCall(config);
      const keys = await readerKeys(deviceKindOf(config), e2ee);
      // ponytail: 語のどれかを含むだけ(順位なし)。溜まって外れが目立ったら C2 の端末索引(FTS5)で置き換える
      const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const budget = input.max_tokens ?? CONTEXT_SEARCH_DEFAULT_MAX_TOKENS;
      const found: {
        id: string;
        type: string;
        scope: string;
        content: string;
        source: { runtime_kind: string | null; work_id: string | null };
        created_at: string;
      }[] = [];
      let blocked = 0;
      let unreadable = 0;
      let omitted = 0;
      let used = 0;
      for (const r of records) {
        if (r.scope !== "personal" && (projectKey === null || r.scope_key !== projectKey)) continue;
        const plaintext = await openMemoryBody(e2ee, keys, r.fingerprint);
        if (plaintext === null) {
          unreadable += 1;
          continue;
        }
        const review = await reviewOpenedMemory(r, plaintext);
        if (!review.ok) {
          blocked += 1;
          continue;
        }
        const text = review.payload.content.toLowerCase();
        if (words.length > 0 && !words.some((w) => text.includes(w))) continue;
        const item = {
          id: r.id,
          type: r.type,
          scope: r.scope,
          content: review.payload.content,
          source: { runtime_kind: r.source_runtime_kind, work_id: r.source_work_id },
          created_at: r.created_at,
        };
        const cost = estimateTokens(JSON.stringify(item));
        if (used + cost > budget) {
          omitted += 1;
          continue;
        }
        used += cost;
        found.push(item);
      }
      const recallRecorded =
        found.length > 0 &&
        (await call(config, "/v1/memory/recalled", {
          body: { record_ids: found.map((f) => f.id), ...(input.work_id ? { work_id: input.work_id } : {}) },
        }).then(
          () => true,
          () => false,
        ));
      return { records: found, blocked, unreadable, omitted, recall_recorded: recallRecorded };
    },
    /**
     * 係(handled_runtime_id)がこの runtime の work。**id でも kind でも一致**(handoff の `to` はどちらも受ける)。
     * work_current(lease で選ぶ)とは別の口 —— 係は「動いている証拠」ではない(PBI-0397 の破れ 1)ので混ぜない。
     * human の credential には runtime が無いので常に空
     */
    work_assigned: async () => {
      const [me, works] = await Promise.all([resolveMe(config), call(config, "/v1/works") as Promise<WorkRow[]>]);
      const now = Date.now();
      const mine = works.filter((w) => isMine(w.handled_runtime_id, me));
      return Promise.all(
        mine.map(async (w) => {
          // PBI-0437: 値を読まずに「何の key が在るか」の 1 行(server の索引の key 名だけから組む)。
          // PBI-0649: 持ち場だけは数が意味を持つので、`brief/` 行が在る時だけ値を開いて数を足す(往復は増やさない)
          const index = (await call(config, `/v1/works/${encodeURIComponent(w.id)}/context`)) as { entries: ContextIndexRow[] };
          const brief = await resolveBrief(config, index.entries);
          return {
            work_id: w.id,
            title: w.title,
            status: w.status,
            handoff_note: w.handoff_note ?? null,
            /** task なら属する Work Project(PBI-0434)。単独の work は null */
            project_id: w.parent_work_id ?? null,
            /** PBI-0447: この端末に task の folder が在ればその path(そこで書く)。無ければ null */
            folder: existsSync(taskFolder(w.id)) ? taskFolder(w.id) : null,
            lease_live: isLeaseLive(w, now),
            context_index: summarizeContextIndex(index.entries, briefCountsOf(brief)),
          };
        }),
      );
    },
    /**
     * PBI-0444: この runtime が lease を握っている work に未読の inbox が在れば 1 work 1 行(無ければ null)。MCP server が
     * 全 tool の応答に足す —— 新しい push 経路を作らず、作業中の agent が次に tool を呼んだ時に見える。server を叩くのは
     * 最大 CHECKPOINT_TICK_INTERVAL_SECS に 1 回なので、届いてから最大その秒数遅れる。取れなければ null(応答を巻き込まない)
     */
    /** PBI-0446: account へまだ上がっていない context の値を再送する(30 秒 tick が呼ぶ。MCP の tool ではない) */
    context_sync: () => syncPendingContextValues(e2eeCall(config)),
    inbox_notice: (): Promise<string | null> => {
      const now = Date.now();
      if (notice && now - notice.at < CHECKPOINT_TICK_INTERVAL_SECS * 1000) return notice.text;
      const text = (async () => {
        const [me, works] = await Promise.all([resolveMe(config), call(config, "/v1/works") as Promise<WorkRow[]>]);
        if (me.runtimeId == null) return null;
        const lines: string[] = [];
        for (const w of works.filter((x) => x.owner_runtime_id === me.runtimeId && isLeaseLive(x, now))) {
          const index = (await call(config, `/v1/works/${encodeURIComponent(w.id)}/context?prefix=inbox%2F`)) as {
            entries: ContextIndexRow[];
          };
          const { unread } = countInbox(index.entries);
          if (unread > 0) {
            lines.push(
              `notice: ${unread} unread inbox message${unread === 1 ? "" : "s"} on ${w.id} — work_context_search(work_id:${JSON.stringify(w.id)}, prefix:"inbox/")`,
            );
          }
        }
        return lines.length > 0 ? lines.join("\n") : null;
      })().catch(() => null);
      notice = { at: now, text };
      return text;
    },
    // ---------- Work Project の task と住所(PBI-0434・手描き 2 枚目) ----------
    /**
     * Work Project に task を 1 つ作り、そのまま渡す(Task A → Agent A)。渡す部分は work_handoff と同じ 1 tx。
     * 作れたが渡せなかった時は、作った task の id を添えて throw する(黙って宙に浮いた task を残さない)
     */
    work_task_create: async (parentWorkId: string, input: WorkTaskCreateInput) => {
      const { title, ...handoff } = input;
      assertNoReservedKeys(handoff.context, "brief");
      // PBI-0649: 持ち場は書けた時に形を見る。`*.sql` を glob のつもりで書いた brief を黙って受けると、
      // 1 つも当たらない門を「守っている」顔で持つ事になる(合流の側は fail-closed で断るだけで理由を言えない)
      for (const key of [TASK_BRIEF_KEYS.allowed, TASK_BRIEF_KEYS.forbidden]) {
        const v = handoff.context?.[key];
        if (v !== undefined && briefPaths(v) === null) {
          throw new Error(
            `invalid_brief: ${key} must be a list of repo-relative path prefixes matched by prefix only — ` +
              'no globs, no leading "/", no ".." (e.g. ["migrations/", "server/src/auth"])',
          );
        }
      }
      // PBI-0648(AC-4): folder が作れないなら渡さない。**task を作る前に**落とす —— 折れた後に
      // 宙に浮いた task を残さない。folder が無い task は Lead と同じ作業ツリーに座り、合流の門も
      // 「誰が書いたか」も意味を失う(実測 6: `if (state?.baseCommit)` の else がその道だった)
      const cwd = config.cwd ?? process.cwd();
      const state = handoff.to !== undefined ? computeGitState(cwd) : null;
      if (handoff.to !== undefined && !state?.baseCommit) {
        throw new Error(
          `no_base_commit: ${cwd} has no commit, so a folder for the task cannot be built — nothing was created and nothing was handed off. ` +
            "Make the first commit here, then hand the task off again",
        );
      }
      const task = (await call(config, "/v1/works", { body: { title, parent_work_id: parentWorkId } })) as WorkRow;
      const wants = handoff.to !== undefined || handoff.note !== undefined || handoff.context !== undefined || handoff.sources !== undefined;
      if (!wants) return { task_id: task.id, task, folder: null, handed_off: null };
      // PBI-0447: runtime に渡す task は自分の folder で書く(この cwd の今の状態から・fork と同じ作り方)
      let folder: string | null = null;
      if (state?.baseCommit) {
        try {
          checkoutForkFolder(cwd, state, taskFolder(task.id));
          folder = taskFolder(task.id);
        } catch (e) {
          throw new Error(
            `task ${task.id} was created under ${parentWorkId}, but its folder could not be built — nothing was handed off: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
      }
      try {
        return { task_id: task.id, task, folder, handed_off: await handoffCall(config, task.id, handoff, "brief") };
      } catch (e) {
        throw new Error(
          `task ${task.id} was created under ${parentWorkId}, but handing it off failed — retry work_handoff on ${task.id}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },
    /** 同じ Work Project で分担している task と住所(= task の work id)。is_you = 係がこの runtime */
    work_team: async (workId: string) => {
      const [team, me] = await Promise.all([
        call(config, `/v1/works/${encodeURIComponent(workId)}/team`) as Promise<{ project: WorkRow; tasks: (WorkRow & { merge?: string | null })[] }>,
        resolveMe(config),
      ]);
      const now = Date.now();
      // PBI-0648 / PBI-0649: 裁定と持ち場の本文は端末の CAS に在る(server は索引しか持てない)ので、面を出す側が task ごとに開く。
      // ponytail: task の数だけ往復する。task が数十を超えて重くなったら server に「裁定の有無と版」だけを /team に足す
      const reviews = await Promise.all(team.tasks.map((t) => readTaskReview(config, t.id)));
      const briefs = await Promise.all(team.tasks.map((t) => readTaskBrief(config, t.id)));
      return {
        project: { work_id: team.project.id, title: team.project.title, status: team.project.status },
        tasks: team.tasks.map((t, i) => ({
          address: t.id,
          title: t.title,
          status: t.status,
          assigned_to: t.handled_runtime_id ?? null,
          is_you: isMine(t.handled_runtime_id, me),
          lease_live: isLeaseLive(t, now),
          /** PBI-0447: 最新の合流(work_task_merge)の結果 */
          merge: t.merge ?? "not_started",
          /** PBI-0648: Lead の裁定。`-` / `accept` / `changes_requested (2)`(数 = 裁定を書いた回数) */
          review: taskReviewCell(taskReviewVerdict(reviews[i]!.body), reviews[i]!.round),
          /** PBI-0649: 渡した持ち場。`-` = brief 無し(全部許す) / `2 allowed / 1 forbidden`(`?` = この端末で読めない) */
          scope: briefScopeCell(briefs[i]!),
        })),
      };
    },

    /**
     * task に裁定を 1 行書く(PBI-0648・図80c ⑦)。`review/` は予約 prefix なので、書けるのは human と
     * **その task の Work Project の lease を握っている run** だけ(自分の task に自分で accept は書けない = 422 reserved_key)。
     * 本文(verdict / feedback)は他の context と同じ端末の CAS に載り、server には索引だけが出る。
     * `accept` が付いて初めて work_task_merge の門が開く
     */
    work_review: async (taskId: string, input: WorkReviewInput) => {
      if (!(TASK_REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) {
        throw new Error(`invalid_verdict: ${String(input.verdict)} — one of ${TASK_REVIEW_VERDICTS.join(" / ")}`);
      }
      const body = { verdict: input.verdict, ...(input.feedback !== undefined ? { feedback: input.feedback } : {}), at: new Date().toISOString() };
      // 同時に 2 人が裁定したら 1 本だけ通す(負けた側は 409 stale_version)。読んだ版を名乗って書く
      const { round } = await readTaskReview(config, taskId);
      const entries = await prepareEntries(config, { context: { [TASK_REVIEW_KEY]: body }, expected_versions: { [TASK_REVIEW_KEY]: round } }, "allow");
      let res: { entries: { version: number }[] };
      try {
        res = (await call(config, `/v1/works/${encodeURIComponent(taskId)}/context`, {
          method: "PUT",
          // 名乗る(module review 2026-09-16)。省くと server は runtime の owner 経路で見る = 同じ runtime の task が自分に書ける
          body: { entries, ...(input.run_id ? { runId: input.run_id } : {}) },
        })) as { entries: { version: number }[] };
      } catch (e) {
        if (e instanceof OpenRolyApiError && e.status === 422 && (e.body as { error?: { code?: string } })?.error?.code === "reserved_key") {
          throw new Error(
            `reserved_key: a task cannot rule on itself — review/verdict on ${taskId} is written by a human or by the run holding its Work Project (name yourself with run_id)`,
            { cause: e },
          );
        }
        throw e;
      }
      return { task_id: taskId, verdict: input.verdict, round: res.entries[0]?.version ?? 1 };
    },
    /**
     * task の folder を呼び手の cwd(= Work Project の作業ツリー)へ合流する(PBI-0447・図80c ⑥)。cwd に触る前に
     * ① task が projectWorkId の task か(team・not_on_team)② この端末に task の folder が在るか(worktree_missing)を見る。
     * applied / conflict は task の events に残す(busy / empty は何も起きていないので残さない)
     */
    work_task_merge: async (projectWorkId: string, taskId: string) => {
      const team = (await call(config, `/v1/works/${encodeURIComponent(projectWorkId)}/team`)) as { project: WorkRow; tasks: WorkRow[] };
      if (team.project.id !== projectWorkId || !team.tasks.some((t) => t.id === taskId)) {
        throw new Error(`not_on_team: ${taskId} is not a task of Work Project ${projectWorkId} — nothing was merged`);
      }
      // PBI-0648: 証拠と裁定の門。**cwd に触る前**に通す(断った時は 1 byte も当たらない)
      const [proofs, review, brief] = await Promise.all([
        call(config, `/v1/works/${encodeURIComponent(taskId)}/proofs`) as Promise<{ status: string }[]>,
        readTaskReview(config, taskId),
        readTaskBrief(config, taskId),
      ]);
      const gate = decideTaskMerge(proofs, review.body);
      if (!gate.ok) throw new Error(`${gate.reason}: ${TASK_MERGE_GATE_HINTS[gate.reason](taskId)} — nothing was merged`);
      // PBI-0649: 持ち場が在るのに読めないなら断る(「読めないから全部許す」に倒さない・AC-X2)
      if (brief != null && brief.forbidden === null) throw new Error(BRIEF_UNREADABLE(taskId));
      const cwd = config.cwd ?? process.cwd();
      const d = mergeTaskFolder(taskFolder(taskId), cwd, brief?.forbidden ?? []);
      if (d.result === "applied" || d.result === "conflict" || d.result === "outside_scope") {
        try {
          await call(config, `/v1/works/${encodeURIComponent(taskId)}/merges`, {
            body: { projectWorkId, merge: d.result, paths: d.paths.slice(0, TASK_MERGE_PATHS_MAX) },
          });
        } catch (e) {
          throw new Error(
            `${d.result === "applied" ? `merged ${taskId} into ${cwd}` : `${taskId} ${d.result === "conflict" ? `conflicts with ${cwd}` : "changed files outside its scope"} (nothing applied)`}, but recording it on the task failed: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
      }
      return { task_id: taskId, project_id: projectWorkId, cwd, ...d };
    },
    /**
     * 同じ project の相手に 1 件届ける。**会話ではなく Work State**(think.md) —— 相手の task の context に
     * `inbox/<送り手の task>/<時刻>` の key で置く(本文は 1 枚目と同じ端末の CAS・server には索引だけ)。
     * 宛先が送り手と同じ project に居なければ送らない(not_on_team)。読むのは work_context_search(prefix: "inbox/")
     */
    work_message: async (toWorkId: string, input: { from_work_id: string; text: string }) => {
      const team = (await call(config, `/v1/works/${encodeURIComponent(input.from_work_id)}/team`)) as {
        project: WorkRow;
        tasks: WorkRow[];
      };
      const members = new Set([team.project.id, ...team.tasks.map((t) => t.id)]);
      if (!members.has(toWorkId)) {
        throw new Error(`not_on_team: ${toWorkId} is not in the same Work Project as ${input.from_work_id} — nothing was sent`);
      }
      const key = `inbox/${input.from_work_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry = await prepareContextValue(key, { from: input.from_work_id, text: input.text, sent_at: new Date().toISOString() });
      const sent = (await call(config, `/v1/works/${encodeURIComponent(toWorkId)}/context`, {
        method: "PUT",
        body: { entries: [entry] },
      })) as { entries: unknown[] };
      return { to: toWorkId, key, delivered: sent.entries.length === 1 };
    },
    // ---------- runtime transfer(PBI-0439 / CAP-3 V7・図84) ----------
    /**
     * client 3 段を 1 回で回す: FREEZE(server が lease を予約 id で塞ぐ)→ CHECKPOINT(この folder の git_state)+
     * BUILD CAPSULE(予約 id・予約 epoch で既存の capsules の口へ)→ ROUTE(server が target をこの folder で起こす)。
     * 途中で落ちたら transfer id と今の state を名指しして throw する(黙って宙に浮いた予約を残さない)
     */
    work_transfer: async (
      workId: string,
      input: { to: string; run_id: string; intent?: string; note?: string } & Omit<WorkCapsuleInput, "run_id" | "git_state">,
    ) => {
      const { to, run_id, intent, note, ...fields } = input;
      const path = `/v1/works/${encodeURIComponent(workId)}`;
      const w = (await call(config, path)) as WorkRow;
      const frozen = (await call(config, `${path}/transfers`, {
        body: { to, runId: run_id, expectedWriteEpoch: w.lease_epoch, ...(intent !== undefined ? { intent } : {}) },
      })) as { transfer_id: string; reserved_epoch: number; holder_run: string };
      const tid = frozen.transfer_id;
      const stopped = (state: string, detail: string, next: string, cause?: unknown) =>
        new Error(`transfer ${tid} of work ${workId} to ${to} stopped at ${state}: ${detail} — ${next}`, { cause });
      const cwd = config.cwd ?? process.cwd();
      let routed: { transfer: { state: string; reason: string | null } };
      let version: number;
      let droppedKeys: string[];
      try {
        if (note !== undefined) await call(config, `${path}/handoff`, { body: { note } });
        const gitState = computeGitState(cwd);
        const pushed = await pushCapsule(config, workId, { lease_epoch: frozen.reserved_epoch }, frozen.holder_run, {
          ...fields,
          ...(gitState ? { git_state: gitState } : {}),
        });
        version = (pushed.capsule as { version: number }).version;
        droppedKeys = pushed.dropped_keys;
        routed = (await call(config, `${path}/transfers/${encodeURIComponent(tid)}/route`, {
          body: { capsuleVersion: version, folder: cwd },
        })) as typeof routed;
      } catch (e) {
        throw stopped(
          "frozen",
          e instanceof Error ? e.message : String(e),
          `the lease stays reserved for this transfer until the server expires it (${WORK_LIVENESS_TIMEOUT_SECS}s); then claim the work again to resume here`,
          e,
        );
      }
      if (routed.transfer.state !== "routed") {
        throw stopped(routed.transfer.state, routed.transfer.reason ?? "not routed", "the lease was released; claim the work again to resume here");
      }
      return { work_id: workId, transfer_id: tid, state: "routed", to, reserved_epoch: frozen.reserved_epoch, capsule_version: version, dropped_keys: droppedKeys };
    },
    /**
     * REHYDRATE。lease を取り(transfer_id 有り = transfer の COMMIT / 無し = 空いている work の claim = fork の枝・PBI-0440)、
     * capsule をこの端末の CAS から読み、**その work の Context Profile を通してから** runtime 非依存の文面(renderCapsule)に
     * する。先頭に tree の変化(capsule の git_state と今の folder)と context 索引の 1 行(索引は server が同じ profile で
     * 絞った物)。上限は work_context_search と同じ既定 —— 入らない field は receipt.omitted、profile が隠した field は
     * receipt.hidden に名前だけ(値は出さない)。receipt.enforcement は今は常に cooperative —— scope token は MCP の道で
     * 他の work を 403 にするが、scope は header で付くので、同じ runtime credential(sandbox は読みを許す)で header を
     * 外した request は server が見ない。端末の CAS の file も読める。credential 自体が scope に束ねられるまで server と名乗らない
     */
    work_accept: async (workId: string, input: { transfer_id?: string; run_id?: string }) => {
      const path = `/v1/works/${encodeURIComponent(workId)}`;
      const runId = input.run_id ?? mcpSessionRunId(config.runtimeKind);
      let work: WorkRow;
      let version: number | null = null;
      if (input.transfer_id !== undefined) {
        const committed = (await call(config, `${path}/transfers/${encodeURIComponent(input.transfer_id)}/commit`, {
          body: { runId },
        })) as { work: WorkRow; transfer: { capsule_version: number | null } };
        work = committed.work;
        version = committed.transfer.capsule_version;
      } else {
        work = (await call(config, `${path}/claim`, { body: { runId } })) as WorkRow;
      }
      const [capsules, index] = await Promise.all([
        call(config, `${path}/capsules`) as Promise<WorkCapsuleRow[]>,
        call(config, `${path}/context`) as Promise<{ entries: ContextIndexRow[] }>,
      ]);
      // transfer は VALIDATE を通った版、枝(claim)は今の最新版 = fork で copy された v1 か、その後に積まれた版
      const capsule = version == null ? capsules.at(-1) : capsules.find((c) => c.version === version);
      version = capsule?.version ?? version;
      const hash = (capsule?.body as { payload_hash?: unknown } | undefined)?.payload_hash;
      const body = typeof hash === "string" ? await readCasPayload(hash) : null;
      const profile = work.context_profile ?? "full";
      const shown = applyContextProfile(profile, body ?? {});
      const preamble: string[] = [];
      const saved = shown.kept.git_state;
      if (saved != null && typeof saved === "object") {
        const changed = changedSinceGitState(saved as GitState, config.cwd ?? process.cwd());
        if (changed && changed.length > 0) preamble.push(`tree changed since capsule: ${changed.join(", ")}`);
      }
      if (!capsule) {
        preamble.push("this work has no capsule yet");
      } else if (body == null) {
        preamble.push(`capsule v${version} is not on this device, so its content cannot be shown (pushed from another device or cleaned up)`);
      }
      preamble.push(`context index: ${summarizeContextIndex(index.entries, briefCountsOf(await resolveBrief(config, index.entries)))}`);
      const r = renderCapsule(shown.kept, { maxTokens: CONTEXT_SEARCH_DEFAULT_MAX_TOKENS, preamble });
      return {
        work_id: workId,
        transfer_id: input.transfer_id ?? null,
        run_id: runId,
        lease: { epoch: work.lease_epoch, holder_run: work.lease_holder_run },
        capsule_version: version,
        rendered: r.rendered,
        receipt: {
          omitted: r.omitted,
          ...(profile !== "full"
            ? { profile, hidden: shown.hidden, enforcement: "cooperative" }
            : {}),
          est_tokens: r.est_tokens,
          max_tokens: CONTEXT_SEARCH_DEFAULT_MAX_TOKENS,
        },
      };
    },
    // ---------- fork / review(PBI-0440 / CAP-3 V8・図84) ----------
    /**
     * 元の work を止めずに枝を 1 本立てる。端末で ① 元の最新 capsule の git_state をこの端末の CAS から読む
     * ② fork folder(`$OPENROLY_HOME/worktrees/<uuid>`)を checkoutForkFolder で作る(元の folder と .git に書かない)
     * ③ server に forks を POST(folder = fork folder)。①② が落ちたら server に何も送らない。③ が断られたら
     * 作った folder を消してから throw する(枝 0・folder 0)。wake が起きなくても枝は ready で残り wake.reason に理由
     */
    work_fork: async (workId: string, input: { to: string; role: "implementer" | "reviewer"; note?: string }) => {
      const path = `/v1/works/${encodeURIComponent(workId)}`;
      const capsules = (await call(config, `${path}/capsules`)) as WorkCapsuleRow[];
      const latest = capsules.at(-1);
      if (!latest) {
        throw new Error(`no_capsule: work ${workId} has no capsule to fork from — push one with work_capsule first`);
      }
      const hash = (latest.body as { payload_hash?: unknown } | null)?.payload_hash;
      const body = typeof hash === "string" ? await readCasPayload(hash) : null;
      const gitState = body?.git_state;
      if (gitState == null || typeof gitState !== "object") {
        throw new Error(`capsule v${latest.version} of work ${workId} has no git_state on this device — the fork's folder cannot be built`);
      }
      const folder = `${openrolyHome()}/worktrees/${crypto.randomUUID()}`;
      checkoutForkFolder(config.cwd ?? process.cwd(), gitState as GitState, folder);
      let forked: { work: WorkRow; wake: { ok: boolean; reason: string | null } };
      try {
        forked = (await call(config, `${path}/forks`, {
          body: {
            to: input.to,
            role: input.role,
            capsuleVersion: latest.version,
            folder,
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        })) as typeof forked;
      } catch (e) {
        rmSync(folder, { recursive: true, force: true });
        throw e;
      }
      return {
        work_id: forked.work.id,
        forked_from: `${workId}@${latest.version}`,
        profile: forked.work.context_profile ?? "full",
        folder,
        wake: forked.wake,
      };
    },
    /**
     * v0 Authority(PBI-0413 / CAP-3 V10): freeze = stop_primary。**token 無しで呼べば必ず
     * 拒否される**(server が explicit_user_intent_required を返す — runtime credential の
     * MCP 呼び出しは `work_intent` を持たない。token は human 側の CLI/UI が先に発行する)。
     * claim には権限段が無い(held な work を上書きできないので transfer にならない — 0400 が
     * MCP 口を作らなかったままで、この PBI でも足さない)
     */
    work_freeze: (workId: string, input: { intent?: string } = {}) =>
      call(config, `/v1/works/${encodeURIComponent(workId)}/freeze`, {
        body: { intent: input.intent ?? null },
      }),
    skills_list: () => listHubSkills(),
    skill_get: (name: string) => readHubSkill(name),
    instructions_get: async (name?: string) => {
      if (name) return readHubRule(name);
      return (await readHubRule("common-rules")) ?? (await readHubRule("claude-rules"));
    },
    mcp_servers_list: () => listHubMcps(),
  };
}

export type AccountTools = ReturnType<typeof createAccountTools>;
