// MVP の message content(要件 §9): text / file / URL のみ。独自 Task/Work object を作らない。
// envelope は Native E2EE(アーキ§9-11)の暗号化済み payload。plaintext と排他ではなく、
// E2EE 経路では text/files/urls の代わりに envelope だけが入る。

export interface FileRef {
  name: string;
  /** object storage 等への参照。内部 blob は `paa-file:<id>`(PBI-0074)。それ以外は URL 文字列 */
  ref: string;
  /**
   * 内部 blob の内容鍵(base64。crypto-envelope の encryptFileBytes が出す keyB64)。
   * FileRef ごと envelope 平文に seal される為、server には見えない(E2EE §9)
   */
  key?: string;
  size?: number;
  mime?: string;
}

export interface MessageContent {
  text?: string;
  files?: FileRef[];
  urls?: string[];
  /** crypto-envelope の EncryptedEnvelope(JSON)。運営側は復号できない */
  envelope?: unknown;
}

export function isEmptyContent(c: MessageContent): boolean {
  return (
    !c.text?.trim() &&
    !(c.files && c.files.length > 0) &&
    !(c.urls && c.urls.length > 0) &&
    c.envelope == null
  );
}

/**
 * envelope の中に seal する平文の形(PBI-0006)。text/files/urls をそのまま JSON にするだけ。
 * capture 通知(webhook の L2 seal・android/windows collector の L1 seal)は同じ envelope に
 * `{title, body, url}` を seal する(server は title/body を見ない・受け側だけがこの形を知る)。
 * MessageContent には専用 field を足さず、fromEnvelopePlaintext が text/urls に畳む(PBI-0153)
 */
export interface EnvelopePlaintext {
  text?: string;
  files?: FileRef[];
  urls?: string[];
  title?: string;
  body?: string;
  url?: string;
}

export function toEnvelopePlaintext(c: MessageContent): EnvelopePlaintext {
  const p: EnvelopePlaintext = {};
  if (c.text !== undefined) p.text = c.text;
  if (c.files !== undefined) p.files = c.files;
  if (c.urls !== undefined) p.urls = c.urls;
  return p;
}

/** 中身のある文字列だけを通す。envelope 平文は L1 collector(client)が任意に組める = 型を信じない */
function plainString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * href として描画してよい URL か(順70 review)。thread は urls と file の外部 ref を
 * そのまま `<a href>` にするので、`javascript:` / `data:` を link にしない。envelope 平文は
 * L1 collector が、平文 content は送信側が任意に組めるため、復号側と描画側の両方で通す
 */
export function isRenderableUrl(u: unknown): u is string {
  return typeof u === "string" && /^(?:https?|mailto):/i.test(u);
}

export function fromEnvelopePlaintext(p: EnvelopePlaintext): MessageContent {
  const c: MessageContent = {};
  // title/body(捕捉通知の形)は text に畳む — 1 行目 = title、2 行目以降 = body(PBI-0153)。
  // collector は Full text mode で title 空・body だけの平文も送る(CollectorService.kt /
  // ListenerService.cs)ので、片方だけでも text にする(順70 review 破れ 1)
  const title = plainString(p.title);
  const body = plainString(p.body);
  if (title !== undefined || body !== undefined) {
    c.text = title !== undefined && body !== undefined ? `${title}\n${body}` : (title ?? body)!;
  } else if (typeof p.text === "string") {
    c.text = p.text;
  }
  const files = (Array.isArray(p.files) ? p.files : []).filter(
    (f): f is FileRef => !!f && typeof f.name === "string" && typeof f.ref === "string",
  );
  if (files.length > 0) c.files = files;
  const urls = [...(Array.isArray(p.urls) ? p.urls : []), p.url].filter(isRenderableUrl);
  if (urls.length > 0) c.urls = urls;
  return c;
}

// ---------- item 種別(EP-0013 W1 / 要件 v0.7 §14) ----------
// message は chat(既存の全経路)と notification(外部 source の着信を持ち込む行)に分かれる。
// digest は W4(まとめ配信)で使うため先に値集合だけ固定 — DB の check 制約と同じ集合を
// ここが正本として持つ(diagrams-check.sh が migration 022 との一致を機械検査する)

export const MESSAGE_KINDS = ["chat", "notification", "digest"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * 通知の流れて来る入口。mail / paa は thread から導出できる(deriveSource)。
 * collector(W2b の android 等)と webhook は行に明示的に載る。値は v0.7 §14 の列挙
 */
export const SOURCE_KINDS = [
  "mail",
  "paa",
  "webhook",
  "android",
  "windows",
  "macos",
  "ios",
  "digest",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** messages.source 列(jsonb)の中身。平文 metadata のみ — 通知本文は content 側に seal される */
export interface NotificationSource {
  kind: SourceKind;
  /** 発生源の app(例: com.example.app)。collector 経路で付く */
  app_id?: string;
  /** UI 表示用の app 名。app_id が無い時の fallback 表示にも使う */
  app_display?: string;
  /** 発生源側の通知 id。同一 thread 内の重複投入を unique index で弾く(REQ-62) */
  external_id?: string;
  /** 秘匿境界(REQ-68)。rule 適用で ingest 時に決まる。無い行は full 扱い */
  cloud_visibility?: CloudVisibility;
  /**
   * mail が**どの住所に届いたか**(PBI-0191 で住所を複数持てるようになった為・図61)。
   * `+t_<token>` を落とした形(`ryo@shibubu.ai`)。routing に使った metadata で、本文とは無関係。
   * 古い行には無い(optional のまま・列は増やさない)
   */
  delivered_to?: string;
}

/** thread の peer から source を導出する(既存 chat 行は source 列が null のため) */
export function deriveSource(thread: {
  peer_address: string | null;
  peer_account_id: string | null;
}): NotificationSource {
  if (thread.peer_address) return { kind: "mail" };
  return { kind: "paa" };
}

// ---------- capture source(EP-0013 W2a / PBI-0114・要件 v0.7 §7.4・§20) ----------
// 世界からの通知の入口。行を sources 表に持ち、token 認証で POST /v1/inbound/notification に届く。
// mail / paa / digest は導出・自動なので source 行を作らない(CAPTURE_SOURCE_KINDS から外れている)

/** source 行を作る種別。webhook = W2a の endpoint、android/windows/macos/ios = collector(W2b 以降) */
export const CAPTURE_SOURCE_KINDS = ["webhook", "android", "windows", "macos", "ios"] as const;
export type CaptureSourceKind = (typeof CAPTURE_SOURCE_KINDS)[number];

/** sources.status の値集合。DB の check 制約と同じ集合をここが正本として持つ(diagrams-check が機械検査) */
export const SOURCE_STATUSES = ["active", "paused", "revoked"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** owner thread の表示名。AI 宛の指示 thread と同じ 1 本に通知が流れる(messaging.ts から移動) */
export const OWNER_THREAD_DISPLAY = "Your AI";

/** POST /v1/inbound/notification の L2 body。平文 — server が device 鍵群へ seal する前の形(図43) */
export interface NotificationPayload {
  /** 発生源の app(例: com.example.app) */
  app_id: string;
  /** UI 表示用の app 名 */
  app_display?: string;
  /** 発生源側の通知 id。無ければ server が内容 hash から生成する(REQ-62) */
  external_id?: string;
  /** 通知タイトル。必須 — 無い物は 422 invalid_payload */
  title: string;
  body?: string;
  /** 通知を開く URL(任意) */
  url?: string;
  /** 発生源側の発生日時(任意。hash の分単位 bucket は受信時刻基準) */
  occurred_at?: string;
}

// ---------- triage の 3 軸(EP-0013 W3 / PBI-0117・要件 v0.7 §15) ----------
// 対処状態の軸 2(triage label)と軸 3(handling)。既読(軸 1)は既存 read_states のまま。
// 値集合の正本はここ — DB の check 制約(migration 024)と同じ集合を
// diagrams-check.sh が機械検査する。triage session は triage_label と summary だけを
// 変える(handling は rule engine / 実行 agent / 人が担う・REQ-64)

/** triage label の値集合。none = 未対処( triage pending の対象) */
export const TRIAGE_LABELS = ["none", "action", "fyi", "discard"] as const;
export type TriageLabel = (typeof TRIAGE_LABELS)[number];

/** item の処理状態。digest 遷移(digest_pending→digested)は W4 の scheduler が担う */
export const HANDLING_STATES = [
  "open",
  "digest_pending",
  "digested",
  "in_progress",
  "done",
  "dismissed",
] as const;
export type HandlingState = (typeof HANDLING_STATES)[number];

// ---------- 自然言語 rule(EP-0013 W4 / PBI-0119・要件 v0.7 §16) ----------
// rule = NL 原文つき JSON。値集合の正本はここ — migration 025 の check 制約と同じ集合を
// diagrams-check.sh が機械検査する。layer の導出規則(REQ-55): scope に sender / keywords
// (本文・送信者の語)を含む → content(server は評価しない・sealed 保管)、それ以外 →
// metadata(source_kind / app_id / time_window の平文一致・server が ingest で評価)

export const RULE_LAYERS = ["metadata", "content"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

export const RULE_ACTION_TYPES = ["immediate", "digest", "discard", "cloud_visibility"] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

/** cloud_visibility の値集合(REQ-68)。masked の server 適用は REQ-69 の MCP masking が担う */
export const CLOUD_VISIBILITIES = ["full", "masked", "local_only", "none"] as const;
export type CloudVisibility = (typeof CLOUD_VISIBILITIES)[number];

// ---------- 秘匿境界 L3 = local_only(EP-0013 W6 / REQ-70) ----------
/** local_only item の content を読める runtime kind の集合。local model server(PBI-0025 の
 * ollama / lmstudio)と broker(端末常駐 process・LLM 無し)。**fail-closed**: この集合に無い
 * kind(claude / codex / gemini 等の cloud LLM CLI・今後の detector id 追加分も)は全部
 * 読めない = 新しい cloud runtime の追加で静かに漏れる経路を構造で潰す。human は常に読める */
export const LOCAL_ONLY_READER_KINDS = ["broker", "ollama", "lmstudio"] as const;
export type LocalOnlyReaderKind = (typeof LOCAL_ONLY_READER_KINDS)[number];

export const isLocalOnlyReaderKind = (kind: string): boolean =>
  (LOCAL_ONLY_READER_KINDS as readonly string[]).includes(kind);

/** local_only item の判定の正本(REQ-70)。notification item のみが対象(digest / chat は外れない)。
 * source 列が無い既存 chat 行は full 扱い */
export const isLocalOnlyItem = (m: {
  kind?: string | null;
  source?: NotificationSource | null;
}): boolean => m.kind === "notification" && m.source?.cloud_visibility === "local_only";

/** rule の scope。metadata 部分(source_kind / app_id / time_window)は平文、
 * sender / keywords は content layer で content_scope(envelope)へ封入される */
export interface RuleScope {
  source_kind?: SourceKind;
  app_id?: string;
  /** 時間帯の絞り込み。W4 は一致判定のみ(quiet hours の triage 組み込みはスコープ外) */
  time_window?: string;
  /** content layer のみ。server には平文で残らない */
  sender?: string;
  keywords?: string[];
}

/** rule の action。type ごとに付く field が決まっている(digest は schedule+tz 必須) */
export interface RuleAction {
  type: RuleActionType;
  /** digest 用。「HH:MM」 */
  schedule?: string;
  /** digest 用。IANA tz(例: UTC / Asia/Tokyo) */
  tz?: string;
  /** cloud_visibility 用 */
  visibility?: CloudVisibility;
}
