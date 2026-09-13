// PBI-0433: Work Project の context(key / value)と source(file)の判定。保存の正本は migration 053。
//
// owner の手描き 1 枚目(2026-09-12): Work Project = Context(key / value)+ Source(md file)。
// Agent A が handoff で書き、Agent B が search で要る key だけを取る。
// **値は server に置かない**(PBI-0414 と同じ線) —— server が受け取るのは索引(kind / key / value_hash /
// size)だけで、この file がその形と壁を決める。value は client が端末の CAS に書く
// (@openroly/adapter の work-context.ts)。
// **node builtin を import しない**(capsule.ts と同じ理由: web の bundle に焼き込まれる)。
import { FORBIDDEN_KEYS, findConversationKeys, hashCapsuleBody, isValidCasHash, validateCredentialRefs } from "./capsule.ts";

export const WORK_CONTEXT_KINDS = ["context", "source"] as const;
export type WorkContextKind = (typeof WORK_CONTEXT_KINDS)[number];

/** context key は label(平文で server に置く)。本文を key に書く道を文字種と長さで狭める */
export const WORK_CONTEXT_KEY_MAX = 128;
/** source の key = repo 相対 path */
export const WORK_SOURCE_PATH_MAX = 512;
/** 1 request で書ける entry 数 */
export const WORK_CONTEXT_BATCH_MAX = 100;
/** 1 work が持てる key の総数(context と source を合わせて) */
export const WORK_CONTEXT_PER_WORK_MAX = 1000;

const CONTEXT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
/** 制御文字(0x00-0x1f と 0x7f)を含むか。正規表現に制御文字を直書きしない(source に不可視の byte を残さない) */
const hasControlChar = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

export type KeyDecision =
  | { ok: true }
  | { ok: false; reason: "invalid_key" | "conversation_key" | "invalid_source_path" };

/**
 * key の壁。context は短い label、source は repo の中を指す相対 path だけを通す。
 * `conversation` / `messages` / `transcript` という名前の key は Capsule と同じ理由で拒否する
 * (C4 #13「会話を Work state に入れない」を key の名前で迂回させない)。
 */
export function validateContextKey(kind: WorkContextKind, key: unknown): KeyDecision {
  if (kind === "source") {
    return isRepoRelativePath(key) ? { ok: true } : { ok: false, reason: "invalid_source_path" };
  }
  if (typeof key !== "string" || key.length === 0 || key.length > WORK_CONTEXT_KEY_MAX) {
    return { ok: false, reason: "invalid_key" };
  }
  if (!CONTEXT_KEY_RE.test(key) || key.includes("..")) return { ok: false, reason: "invalid_key" };
  if ((FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) {
    return { ok: false, reason: "conversation_key" };
  }
  return { ok: true };
}

/** 空 segment / `.` / `..` / 絶対 path / Windows の drive / backslash / 制御文字を持たない相対 path */
function isRepoRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > WORK_SOURCE_PATH_MAX) return false;
  if (path.startsWith("/") || path.includes("\\") || hasControlChar(path) || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** server が受け取る索引 1 行。**value は無い**(持つ field がここで閉じている) */
export interface WorkContextIndexEntry {
  kind: WorkContextKind;
  key: string;
  value_hash: string;
  size: number;
  /** 最後に見た版。無い key を「まだ無いはず」と言うなら 0。付けなければ上書き(後勝ち) */
  expected_version?: number;
}

const ENTRY_FIELDS = new Set(["kind", "key", "value_hash", "size", "expected_version"]);

export type EntriesDecision =
  | { ok: true; entries: WorkContextIndexEntry[] }
  | { ok: false; reason: string; key?: string };

/**
 * server 側の形式検証。未知 field は**黙って落とさず拒否**する —— `value` を送ってきた request を
 * 「受けてから捨てる」にすると、平文が server の手元を一度通る(AC-X2 は経路の不在で守る)。
 */
export function validateContextEntries(input: unknown): EntriesDecision {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, reason: "invalid_entries" };
  if (input.length > WORK_CONTEXT_BATCH_MAX) return { ok: false, reason: "too_many_entries" };
  const seen = new Set<string>();
  const entries: WorkContextIndexEntry[] = [];
  for (const raw of input) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "invalid_entries" };
    }
    const o = raw as Record<string, unknown>;
    if (Object.keys(o).some((k) => !ENTRY_FIELDS.has(k))) return { ok: false, reason: "invalid_field" };
    if (!(WORK_CONTEXT_KINDS as readonly string[]).includes(o.kind as never)) {
      return { ok: false, reason: "invalid_kind" };
    }
    const kind = o.kind as WorkContextKind;
    const decision = validateContextKey(kind, o.key);
    if (!decision.ok) {
      return { ok: false, reason: decision.reason, ...(typeof o.key === "string" ? { key: o.key } : {}) };
    }
    const key = o.key as string;
    if (typeof o.value_hash !== "string" || !isValidCasHash(o.value_hash)) {
      return { ok: false, reason: "invalid_value_hash", key };
    }
    if (typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < 0) {
      return { ok: false, reason: "invalid_size", key };
    }
    const ev = o.expected_version;
    if (ev !== undefined && (typeof ev !== "number" || !Number.isInteger(ev) || ev < 0)) {
      return { ok: false, reason: "invalid_expected_version", key };
    }
    const id = `${kind}:${key}`; // kind は ":" を含まないので、key に ":" が在っても割れない
    if (seen.has(id)) return { ok: false, reason: "duplicate_key", key };
    seen.add(id);
    entries.push({
      kind,
      key,
      value_hash: o.value_hash,
      size: o.size,
      ...(ev !== undefined ? { expected_version: ev as number } : {}),
    });
  }
  return { ok: true, entries };
}

/** 端末の CAS に置く 1 件。key を中に持つので、別の key の索引がこの payload を指しても取り違えを検出できる */
export type ContextValuePayload = { key: string; value: unknown };

export class ContextValueError extends Error {
  constructor(
    readonly code: "invalid_key" | "conversation_key" | "invalid_source_path" | "value_required" | "context_rejects_conversation",
    readonly key: string,
  ) {
    super(`${code}: ${key}`);
    this.name = "ContextValueError";
  }
}

/**
 * value を CAS に書ける形にする(client 側)。壁は Capsule と同じ 2 枚 —— 会話の key をどの階層にも
 * 持たない / 秘密は `credential_ref: "env:NAME"` の形でしか書けない(`validateCredentialRefs` が throw)。
 * hash は Capsule と同じ正規化 hash(CAS の file 名と同じ関数)。
 */
export function buildContextValue(key: string, value: unknown): { payload: ContextValuePayload; hash: string } {
  const decision = validateContextKey("context", key);
  if (!decision.ok) throw new ContextValueError(decision.reason, key);
  if (value === undefined) throw new ContextValueError("value_required", key);
  if (findConversationKeys(value).length > 0) throw new ContextValueError("context_rejects_conversation", key);
  const payload: ContextValuePayload = { key, value };
  validateCredentialRefs(payload);
  return { payload, hash: hashCapsuleBody(payload) };
}

// ---------- 決まった key と索引 1 行(PBI-0437・「123やる」の 2) ----------

/**
 * agent が書く意味の key。**この順で索引に並ぶ**(次の agent が最初に読む物ほど前)。名前は強制しない ——
 * tool の説明と索引の並びで揃える(自由な key も今まで通り書ける)
 */
export const WORK_CONTEXT_WELL_KNOWN_KEYS = [
  "goal",
  "next_step",
  "decisions",
  "open_questions",
  "failed_attempts",
  "verified_findings",
] as const;

/** 機械が書く置き場。`auto/` = 30 秒 tick(PBI-0436)、`inbox/` = work_message(PBI-0434)。agent の手書きでは書かない */
export const WORK_CONTEXT_RESERVED_PREFIXES = ["auto/", "inbox/"] as const;

export function findReservedContextKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => WORK_CONTEXT_RESERVED_PREFIXES.some((p) => k.startsWith(p)));
}

/**
 * 「この仕事に何の key が在るか」を**値を読まずに** 1 行にする(索引行の kind と key だけ)。
 * 例: `context: goal, next_step · auto: git, tests · +2 keys · 1 source · inbox 2`
 * task の索引(自分 + project)で同じ key が 2 行来ても 1 つに数える。
 */
export function summarizeContextIndex(rows: readonly { kind: string; key: string }[]): string {
  const contextKeys = [...new Set(rows.filter((r) => r.kind === "context").map((r) => r.key))];
  const sources = new Set(rows.filter((r) => r.kind === "source").map((r) => r.key)).size;
  const present = new Set(contextKeys);
  const known = WORK_CONTEXT_WELL_KNOWN_KEYS.filter((k) => present.has(k));
  const auto = contextKeys.filter((k) => k.startsWith("auto/")).map((k) => k.slice("auto/".length)).sort();
  const inbox = contextKeys.filter((k) => k.startsWith("inbox/")).length;
  const other = contextKeys.filter(
    (k) => !(WORK_CONTEXT_WELL_KNOWN_KEYS as readonly string[]).includes(k) && findReservedContextKeys([k]).length === 0,
  ).length;
  const parts: string[] = [];
  if (known.length > 0) parts.push(`context: ${known.join(", ")}`);
  if (auto.length > 0) parts.push(`auto: ${auto.join(", ")}`);
  if (other > 0) parts.push(`+${other} key${other === 1 ? "" : "s"}`);
  if (sources > 0) parts.push(`${sources} source${sources === 1 ? "" : "s"}`);
  if (inbox > 0) parts.push(`inbox ${inbox}`);
  return parts.length > 0 ? parts.join(" · ") : "context: (empty)";
}

