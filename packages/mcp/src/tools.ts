// OpenRoly Account tools contract(要件 §16)の実装。
// runtime は paired credential で HTTP API を叩く。tool は §16 の 8 操作 + reply(PBI-0094)
// + notification_label(EP-0013 W3 triage)+ work_*(PBI-0400 / CAP-3 V9 — 裏が実在する 6 動詞だけ)。
// memory.* / task.* / browser.* 等は提供しない(要件 §16 の非提供リスト)。
//
// PBI-0006(要件 §9-11): send / inbox_read は sender・recipient 双方の account が
// active device を持つ時、自動的に E2EE(HPKE envelope)を使う。片方でも device が
// 無ければ平文のまま送受信する(server 側の強制拒否はしない設計。backlog/PBI-0006 参照)。

import { buildCapsule, buildManifest, findReservedContextKeys, summarizeContextIndex, type MessageContent } from "@openroly/core";
import { open, type EncryptedEnvelope } from "@openroly/crypto-envelope";
import {
  credentialRejectedHint,
  readerKeys,
  openIfEnvelope as openEnvelope,
  sealForHandle,
  writeCasPayload,
  prepareContextValue,
  prepareSource,
  resolveContextEntries,
  type ContextIndexEntryInput,
  type ContextIndexRow,
} from "@openroly/adapter";

export interface OpenRolyClientConfig {
  baseUrl: string;
  token: string;
  /** device key の永続化単位(credential store の kind と同じ)。省略時は "default" */
  deviceKind?: string;
  /** triage session の scope token(EP-0013 W3 / REQ-61 ②)。broker が dedicated session の
   * env `OPENROLY_SESSION_SCOPE` に載せた物を server.ts が受けて全 request の header に付ける。
   * 無ければ header 自体を送らない(Manual / AUTO / owner lane は従来どおり全権) */
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
  lease_epoch: number;
  lease_holder_run: string | null;
  lease_acquired_at: string | null;
  lease_expires_at: string | null;
  handled_runtime_id: string | null;
  handoff_note?: string | null;
  parent_work_id?: string | null;
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

/**
 * PBI-0437: `auto/`(30 秒 tick の事実)と `inbox/`(work_message)は agent の手書きで上書きさせない。
 * 壁は agent が呼ぶ口に置き、tick だけが allowReserved で通る(CAS に書く前・task を作る前に落とす)
 */
const assertNoReservedKeys = (context: Record<string, unknown> | undefined): void => {
  const reserved = findReservedContextKeys(Object.keys(context ?? {}));
  if (reserved.length === 0) return;
  throw new Error(
    `reserved_key: ${reserved.join(", ")} — auto/ is written by the 30-second checkpoint tick and inbox/ by work_message. ` +
      "Use your own keys (goal, next_step, decisions, open_questions, failed_attempts, verified_findings)",
  );
};

/** context / sources を端末で準備し、server へ送る索引だけを返す(value は返り値に入らない) */
const prepareEntries = async (
  config: OpenRolyClientConfig,
  input: WorkContextPutInput,
  allowReserved = false,
): Promise<ContextIndexEntryInput[]> => {
  if (!allowReserved) assertNoReservedKeys(input.context);
  const cwd = config.cwd ?? process.cwd();
  const out: ContextIndexEntryInput[] = [];
  for (const [key, value] of Object.entries(input.context ?? {})) out.push(await prepareContextValue(key, value));
  for (const path of input.sources ?? []) out.push(await prepareSource(cwd, path));
  const expected = input.expected_versions ?? {};
  return out.map((e) => (expected[e.key] !== undefined ? { ...e, expected_version: expected[e.key] } : e));
};

/** handoff の 1 回(work_handoff と work_task_create が共用する —— POST の組み立てを 2 箇所に書かない) */
const handoffCall = async (config: OpenRolyClientConfig, workId: string, input: WorkHandoffInput) => {
  const entries = input.context || input.sources ? await prepareEntries(config, input) : [];
  return call(config, `/v1/works/${encodeURIComponent(workId)}/handoff`, {
    body: {
      ...(input.to !== undefined ? { runtimeId: input.to } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(entries.length > 0 ? { entries } : {}),
      ...(input.run_id ? { runId: input.run_id } : {}),
    },
  });
};

/** この credential の runtime(id と kind)。human の credential は runtime を持たないので両方 null */
const resolveMe = async (config: OpenRolyClientConfig): Promise<{ runtimeId: string | null; kind: string | null }> => {
  const agents = (await call(config, "/v1/agents")) as {
    me: { runtime_id: string | null };
    runtimes: { id: string; kind: string }[];
  };
  const runtimeId = agents.me.runtime_id;
  return { runtimeId, kind: runtimeId ? (agents.runtimes.find((r) => r.id === runtimeId)?.kind ?? null) : null };
};

/** 係がこの runtime か(handoff の `to` は runtime id でも kind でも受ける) */
const isMine = (handled: string | null | undefined, me: { runtimeId: string | null; kind: string | null }): boolean =>
  handled != null && me.runtimeId != null && (handled === me.runtimeId || handled === me.kind);

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
  return {
    whoami: () => call(config, "/v1/whoami"),
    inbox_list: () => call(config, "/v1/inbox/messages"),
    inbox_read: async (messageId: string) => {
      const message = (await call(config, `/v1/messages/${messageId}`)) as { content: MessageContent };
      return openEnvelope(deviceKindOf(config), message, e2eeCall(config));
    },
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
      return call(config, `/v1/messages/${messageId}/label`, { body });
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
     * lease 付きが複数在る時は最新 1 件 + `ambiguous: true` —— 黙って 1 件に見せない。
     * 無ければ `null`(空配列でも error でもない = 呼び手の分岐を 1 つに保つ)
     */
    work_current: async () => {
      const works = (await call(config, "/v1/works")) as WorkRow[];
      const now = Date.now();
      const held = works
        .filter((w) => isLeaseLive(w, now))
        .sort((a, b) => leaseTime(b) - leaseTime(a));
      const w = held[0];
      if (!w) return null;
      return {
        work_id: w.id,
        title: w.title,
        status: w.status,
        lease: { epoch: w.lease_epoch, holder_run: w.lease_holder_run },
        handled_runtime_id: w.handled_runtime_id ?? null,
        ambiguous: held.length > 1,
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
      const entries = await prepareEntries(config, input, opts.allowReserved === true);
      if (entries.length === 0) throw new Error("nothing to put — pass context and/or sources");
      return call(config, `/v1/works/${encodeURIComponent(workId)}/context`, {
        method: "PUT",
        body: { entries, ...(input.run_id ? { runId: input.run_id } : {}) },
      });
    },
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
      )) as { entries: ContextIndexRow[] };
      const resolved = await resolveContextEntries(res.entries, {
        cwd: config.cwd ?? process.cwd(),
        query: input.query,
        indexOnly: input.index_only,
        maxTokens: input.max_tokens,
      });
      return { work_id: workId, ...resolved };
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
          // PBI-0437: 値を読まずに「何の key が在るか」の 1 行(server の索引の key 名だけから組む)
          const index = (await call(config, `/v1/works/${encodeURIComponent(w.id)}/context`)) as { entries: ContextIndexRow[] };
          return {
            work_id: w.id,
            title: w.title,
            status: w.status,
            handoff_note: w.handoff_note ?? null,
            /** task なら属する Work Project(PBI-0434)。単独の work は null */
            project_id: w.parent_work_id ?? null,
            lease_live: isLeaseLive(w, now),
            context_index: summarizeContextIndex(index.entries),
          };
        }),
      );
    },
    // ---------- Work Project の task と住所(PBI-0434・手描き 2 枚目) ----------
    /**
     * Work Project に task を 1 つ作り、そのまま渡す(Task A → Agent A)。渡す部分は work_handoff と同じ 1 tx。
     * 作れたが渡せなかった時は、作った task の id を添えて throw する(黙って宙に浮いた task を残さない)
     */
    work_task_create: async (parentWorkId: string, input: WorkTaskCreateInput) => {
      const { title, ...handoff } = input;
      assertNoReservedKeys(handoff.context);
      const task = (await call(config, "/v1/works", { body: { title, parent_work_id: parentWorkId } })) as WorkRow;
      const wants = handoff.to !== undefined || handoff.note !== undefined || handoff.context !== undefined || handoff.sources !== undefined;
      if (!wants) return { task_id: task.id, task, handed_off: null };
      try {
        return { task_id: task.id, task, handed_off: await handoffCall(config, task.id, handoff) };
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
        call(config, `/v1/works/${encodeURIComponent(workId)}/team`) as Promise<{ project: WorkRow; tasks: WorkRow[] }>,
        resolveMe(config),
      ]);
      const now = Date.now();
      return {
        project: { work_id: team.project.id, title: team.project.title, status: team.project.status },
        tasks: team.tasks.map((t) => ({
          address: t.id,
          title: t.title,
          status: t.status,
          assigned_to: t.handled_runtime_id ?? null,
          is_you: isMine(t.handled_runtime_id, me),
          lease_live: isLeaseLive(t, now),
        })),
      };
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
  };
}

export type AccountTools = ReturnType<typeof createAccountTools>;
