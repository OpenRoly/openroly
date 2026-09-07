// OpenRoly Account tools contract(要件 §16)の実装。
// runtime は paired credential で HTTP API を叩く。tool は §16 の 8 操作 + reply(PBI-0094)
// + notification_label(EP-0013 W3 triage)。
// memory.* / task.* / browser.* 等は提供しない(要件 §16 の非提供リスト)。
//
// PBI-0006(要件 §9-11): send / inbox_read は sender・recipient 双方の account が
// active device を持つ時、自動的に E2EE(HPKE envelope)を使う。片方でも device が
// 無ければ平文のまま送受信する(server 側の強制拒否はしない設計。backlog/PBI-0006 参照)。

import type { MessageContent } from "@openroly/core";
import { open, type EncryptedEnvelope } from "@openroly/crypto-envelope";
import {
  credentialRejectedHint,
  readerKeys,
  openIfEnvelope as openEnvelope,
  sealForHandle,
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
  };
}

export type AccountTools = ReturnType<typeof createAccountTools>;
