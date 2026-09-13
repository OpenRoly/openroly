// PBI-0406 / CAP-3 V2: Immutable Work Capsule の判定(保存の正本は migration 050)。
//
// Conversation compression ではなく Work serialization(C4 #13)。入れるのは 8 要素だけ —
// 会話を入れる道を 1 つも作らない(AC-4 の壁が本体)。`conversation` / `messages` / `transcript`
// は名指しで弾いて理由を返す。8 要素以外の未知 key は黙って落とさず、落とした key を返す
// (呼び手が「何が消えたか」を知れる)。
//
// 借りる物(PBI-0406 の「まず 2 つを開いてから決める」): third_party/openclaw の
// workboard-contract に Capsule 相当の型は無い(WorkboardEvent 等はこれとは別物)。
// akitaonrails/ai-memory(MIT・star 6000+)は「pages」を version 付き immutable 行にして
// 最新版だけを読む形を持つが、Rust/SQLite の別スタックで直接移植できる型は無い —— その形自体は
// この repo の work_events(append-only・work 内連番)が既に採っている物と同じなので、
// その既存の型を自作の土台にする(見て自作)。
// **node builtin を import しない**(PBI-0427)。この file は `@openroly/core` の entry から web(vite)の
// bundle に焼き込まれ、`node:crypto` の named import は `"createHash" is not exported by
// "__vite-browser-external"` で web build を殺す(PBI-0380 と同じ型)。hash を実際に計算するのは
// CLI / MCP / adapter / server で、どれも Bun の上で動く(plugin bundle は `--target=bun`、
// 配布 binary は `bun build --compile`)。web は hash を呼ばない。

export const CAPSULE_FIELDS = [
  "goal",
  "current_state",
  "decisions",
  "unresolved_questions",
  "relevant_artifacts",
  "relevant_memory",
  "git_state",
  "capability_requirements",
] as const;
export type CapsuleField = (typeof CAPSULE_FIELDS)[number];
export type CapsuleBody = Partial<Record<CapsuleField, unknown>>;

/** 会話そのものを入れようとした時だけ throw する(C4 #13 の壁)。他の未知 key は黙って落とす側 */
export const FORBIDDEN_KEYS = ["conversation", "messages", "transcript"] as const;

/** value のどこかの階層に会話の key が在れば、その名前を返す(Capsule と Work Project context が共用する壁) */
export function findConversationKeys(value: unknown): string[] {
  return FORBIDDEN_KEYS.filter((k) => hasKeyDeep(value, k));
}

export class CapsuleConversationError extends Error {
  readonly code = "capsule_rejects_conversation";
  constructor(readonly foundKeys: string[]) {
    super(`capsule_rejects_conversation: ${foundKeys.join(", ")}`);
    this.name = "CapsuleConversationError";
  }
}

export interface BuildCapsuleResult {
  body: CapsuleBody;
  hash: string;
  /** 8 要素以外で落とした key(黙って捨てない — 呼び手に返す) */
  droppedKeys: string[];
}

export function buildCapsule(input: Record<string, unknown>): BuildCapsuleResult {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("buildCapsule: input must be a plain object");
  }
  // top-level だけでなく、許可 field(current_state 等)の値に丸ごとネストされた場合も塞ぐ
  // (レビュー 2026-09-09: `current_state: { conversation: [...] }` が top-level 判定を素通りしていた —
  // AC-4 の壁は「body に混ぜる」であって「top-level に置く」ではない)
  const forbiddenFound = findConversationKeys(input);
  if (forbiddenFound.length > 0) throw new CapsuleConversationError(forbiddenFound);

  const allowed = new Set<string>(CAPSULE_FIELDS);
  const body: CapsuleBody = {};
  const droppedKeys: string[] = [];
  for (const key of Object.keys(input)) {
    if (allowed.has(key)) {
      body[key as CapsuleField] = input[key];
    } else {
      droppedKeys.push(key);
    }
  }
  // PBI-0414 AC-5: 秘密は credential_ref(env:NAME)でしか渡せない。ここで弾かないと、
  // 平文を止めた payload の**中**に生の秘密がまた入ってしまう(AC-1 を満たしても無意味になる)
  validateCredentialRefs(body);
  return { body, hash: hashCapsuleBody(body), droppedKeys };
}

// ---------- Secret Reference(PBI-0414 / CAP-3 V4.5): 新しい参照形式は発明しない ----------
// `credential_ref` の `env:NAME` scheme は既に在る(PBI-0009・packages/adapter/src/reconcile.ts の
// resolveCredentialRef と**同じ構文**を要求する — 2 箇所で別のパーサを持たない)。
// `connection:<provider>` 等の他 scheme はこの文脈(capsule payload)では受けない —— 秘密を
// account 側の resolve に委ねる仕組みは reconcile 専用で、capsule は「端末の secrets.json に
// 在る名前を指すだけ」の狭い用途に絞る(G1 AC-5)。

const CREDENTIAL_REF_KEY = "credential_ref";
/** reconcile.ts の `ref.slice("env:".length).split(",").filter(Boolean)` と同じ構文を要求する
 * (env: の後、コンマ区切りの env 変数名。空リストは拒否 — `filter(Boolean)` で 0 件になる形) */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CapsuleCredentialRefError extends Error {
  readonly code = "capsule_invalid_credential_ref";
  constructor(readonly value: unknown) {
    super(`capsule_invalid_credential_ref: ${JSON.stringify(value)}`);
    this.name = "CapsuleCredentialRefError";
  }
}

function isValidCredentialRef(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("env:")) return false;
  // reconcile.ts の resolveCredentialRef と同じ split + filter(Boolean)(空セグメントは無視)。
  // 2 箇所で別のパーサにしない —— ここが reconcile より厳しいと、capsule には通るのに
  // 実際の解決は失敗する(または逆)という drift が起きる
  const names = value.slice("env:".length).split(",").filter(Boolean);
  return names.length > 0 && names.every((n) => ENV_NAME_RE.test(n));
}

/** body のどこかに `credential_ref` key が在れば、その値が `env:NAME[,NAME...]` である事を要求する。
 * 見つからなければ何もしない(credential_ref を使わない capsule は普通に在る)。 */
function collectInvalidCredentialRefs(value: unknown, found: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectInvalidCredentialRefs(v, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === CREDENTIAL_REF_KEY) {
        if (!isValidCredentialRef(v)) found.push(v);
      } else {
        collectInvalidCredentialRefs(v, found);
      }
    }
  }
}

export function validateCredentialRefs(body: Record<string, unknown>): void {
  const found: unknown[] = [];
  collectInvalidCredentialRefs(body, found);
  if (found.length > 0) throw new CapsuleCredentialRefError(found[0]);
}

/** value のどこかの階層(object のキー)に key が在るか(array の要素の中も潜る)。
 * 会話の壁は「top-level に無ければ通す」ではなく「どこにも無ければ通す」でないと、
 * 許可 field(current_state 等)の値へ丸ごとネストするだけで壁が素通りになる */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (key in obj) return true;
    return Object.values(obj).some((v) => hasKeyDeep(v, key));
  }
  return false;
}

/** key の順序に依らない正規化 hash(AC-5: 同じ中身 → 同じ hash) */
export function hashCapsuleBody(body: Record<string, unknown>): string {
  return new Bun.CryptoHasher("sha256").update(stableStringify(body)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------- Capsule Manifest(PBI-0414 / CAP-3 V4.5) ----------
// server が持つのはこれだけ。8 要素の本文は 1 つも入らない(AC-1) —— payload_hash が
// 端末の CAS(packages/adapter/checkpoint-cas.ts)への参照。version / write_epoch / run_id は
// 既存の work_capsules の型付き列のまま(ここへ重複させない)。

/** sha256 hex(64 文字)以外は全部拒否する。CAS の file 名に直結する値なので、path traversal
 * (`../` 等)が文字種で機械的に弾かれる形にする(全長一致のみ。部分一致にしない)。 */
const CAS_HASH_RE = /^[0-9a-f]{64}$/;
export function isValidCasHash(hash: string): boolean {
  return CAS_HASH_RE.test(hash);
}

/** file mode(8 進 4 桁の文字列。`checkpoint-cas.ts` は常に "0600" で書く — CAS は常に 1 通りの
 * 権限だが、値の形自体は汎用にしておく。0700 台までを許可) */
const MODE_RE = /^0[0-7]{3}$/;

export interface CapsuleManifest {
  payload_hash: string;
  size: number;
  mode: string;
  /** payload の中で使われている credential_ref の env 変数名だけ(値は入れない・重複無し・昇順) */
  refs: string[];
}

/** body の中の credential_ref から env 変数名だけを集める(`validateCredentialRefs` を先に
 * 通した body を渡す前提 —— ここでは形式チェックをしない)。 */
function collectCredentialRefNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectCredentialRefNames(v, names);
    return;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === CREDENTIAL_REF_KEY && typeof v === "string" && v.startsWith("env:")) {
        for (const n of v.slice("env:".length).split(",").filter(Boolean)) names.add(n);
      } else {
        collectCredentialRefNames(v, names);
      }
    }
  }
}

/** payload を CAS へ書いた後、server へ送る manifest を組み立てる(hash/size は書いた側が持つ)。 */
export function buildManifest(
  body: CapsuleBody,
  payload: { hash: string; size: number; mode: string },
): CapsuleManifest {
  const names = new Set<string>();
  collectCredentialRefNames(body, names);
  return { payload_hash: payload.hash, size: payload.size, mode: payload.mode, refs: [...names].sort() };
}

export type ManifestValidation = { ok: true; manifest: CapsuleManifest } | { ok: false; reason: string };

/**
 * server 側が受け取る manifest の形式検証(**中身は見えない・見ない** —— payload はここに無い)。
 * 8 要素の生の値が紛れ込んでいないかは見ようがない(server は payload を受け取らないので、
 * そもそも「平文を送る口」自体が無い — AC-1 は経路の不在で保証する。ここは manifest の形だけ)。
 */
export function validateManifest(input: unknown): ManifestValidation {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid_manifest" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.payload_hash !== "string" || !isValidCasHash(o.payload_hash)) {
    return { ok: false, reason: "invalid_payload_hash" };
  }
  if (typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < 0) {
    return { ok: false, reason: "invalid_size" };
  }
  if (typeof o.mode !== "string" || !MODE_RE.test(o.mode)) {
    return { ok: false, reason: "invalid_mode" };
  }
  if (!Array.isArray(o.refs) || o.refs.some((r) => typeof r !== "string" || !ENV_NAME_RE.test(r))) {
    return { ok: false, reason: "invalid_refs" };
  }
  return { ok: true, manifest: { payload_hash: o.payload_hash, size: o.size, mode: o.mode, refs: o.refs as string[] } };
}
