// PBI-0552 / CAP-15 Z2: Personal Agent Account Protocol(PAAP)v0.1 の判定の正本。
// 本文は specs/paap/README.md、形は specs/paap/v0.1/*.schema.json(JSON Schema 2020-12)。ここは schema が
// 表せない不変条件(hash・連番・epoch・深さ問わずの会話 key・profile・manifest の整合)まで 1 箇所で判定する。
// 値集合は core の既存定数を使う(書き写さない)。schema との同値は packages/core/test/protocol.test.ts が守る。
// **node builtin を import しない**(capsule.ts と同じ理由 = web bundle)。directory を読むのは node.ts の
// validateCapsuleDir で、ここは path → bytes を受け取る純関数だけ。

import {
  buildManifest,
  CAPSULE_FIELDS,
  CapsuleCredentialRefError,
  findConversationKeys,
  hashCapsuleBody,
  validateCredentialRefs,
  type CapsuleBody,
} from "./capsule.ts";
import { CLOUD_VISIBILITIES, type CloudVisibility } from "./content.ts";
import {
  CONTEXT_PROFILES,
  TRANSFER_IN_PROGRESS_STATES,
  TRANSFER_STATES,
  WORK_STATUSES,
  type ContextProfile,
  type TransferState,
  type WorkStatus,
} from "./work.ts";

export const PAAP_VERSION = "paap/0.1";

/** handles.status(migration 001 の check と同じ 2 値) */
export const HANDLE_STATUSES = ["current", "alias"] as const;
/** handoff を始めた時に源の lease が生きていたか。無ければ held と読む(migration 062 の 2 値) */
export const HANDOFF_SOURCE_STATES = ["held", "lapsed"] as const;

/** spec §9 の表と同じ集合(test が README と invalid fixtures の両方と突き合わせる) */
export const PAAP_REASONS = [
  "missing_file",
  "invalid_json",
  "unsupported_protocol",
  "unknown_key",
  "missing_field",
  "invalid_field",
  "manifest_contents_mismatch",
  "manifest_hash_mismatch",
  "reenter_mismatch",
  "private_key_in_export",
  "path_mismatch",
  "conversation_in_checkpoint",
  "invalid_credential_ref",
  "not_i_json",
  "content_hash_mismatch",
  "profile_field_not_allowed",
  "version_gap",
  "based_on_missing",
  "epoch_not_reserved",
  "handoff_in_progress_twice",
  "handoff_checkpoint_missing",
  "lease_behind_handoff",
] as const;
export type PaapReason = (typeof PAAP_REASONS)[number];

export type Verdict = { ok: true } | { ok: false; reason: PaapReason; at: string };
export type CapsuleVerdict =
  | { ok: true; capsule: PaapCapsule }
  | { ok: false; reason: PaapReason; path: string; at: string };

type Ext = Record<string, unknown>;
export interface PaapIdentity {
  protocol: string;
  account_id: string;
  agent_id: string;
  display_name: string;
  /** 席だけ(Work.owner と同じ `<kind>:<id>`)。会社が agent を持つ日の為に予約 */
  owner?: string;
  handles: { handle: string; status: (typeof HANDLE_STATUSES)[number]; authority?: string }[];
  keys: {
    account?: { key_id: string; jwk: Record<string, unknown> };
    devices: { id: string; name: string; jwk: Record<string, unknown>; revoked_at?: string }[];
  };
  exported_at: string;
  ext?: Ext;
}
export interface PaapWork {
  id: string;
  owner: string;
  title: string;
  goal?: string;
  status: WorkStatus;
  visibility: CloudVisibility;
  lease: { epoch: number; holder_run?: string; acquired_at?: string; expires_at?: string };
  profile: ContextProfile;
  parent_work_id?: string;
  forked_from?: { work_id: string; checkpoint_version: number };
  created_at: string;
  updated_at: string;
  ext?: Ext;
}
export interface PaapCheckpoint {
  work_id: string;
  version: number;
  write_epoch: number;
  run_id?: string;
  content_hash: string;
  /** I-12: rollback = 同じ work の古い版 / fork・clone = 別 work の版。work_id 省略 = 同じ work */
  based_on?: { work_id?: string; version: number };
  body: CapsuleBody;
  created_at: string;
  ext?: Ext;
}
export interface PaapHandoff {
  id: string;
  work_id: string;
  from_run?: string;
  from_epoch: number;
  reserved_epoch: number;
  to_runtime: string;
  source_state?: (typeof HANDOFF_SOURCE_STATES)[number];
  checkpoint_version?: number;
  state: TransferState;
  reason?: string;
  note?: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  ext?: Ext;
}
export interface PaapManifest {
  protocol: string;
  exported_at: string;
  exporter: { name: string; version: string };
  contents: { path: string; sha256: string }[];
  reenter: { credential_refs: string[]; devices: number };
  ext?: Ext;
}
export interface PaapCapsule {
  manifest: PaapManifest;
  identity: PaapIdentity;
  /** work id の昇順。checkpoints は version の昇順、handoffs は file 名(id)の昇順 */
  works: { work: PaapWork; checkpoints: PaapCheckpoint[]; handoffs: PaapHandoff[] }[];
}

// ---------- 形(schema と key 集合が同値である事を test が守る) ----------

/** string = 空でない文字列 / int = 0 以上の整数 / version = 1 以上の整数 / 配列 = enum / RegExp = pattern */
type Kind =
  | "string"
  | "int"
  | "version"
  | "timestamp"
  | "jwk"
  | "ext"
  | "any"
  | RegExp
  | readonly string[]
  | Shape
  | { readonly items: Kind };
export interface Shape {
  readonly required: Readonly<Record<string, Kind>>;
  readonly optional?: Readonly<Record<string, Kind>>;
}

/** spec §2 の時刻: RFC 3339 の UTC だけ・暦に在る日・閏秒なし。spec 本文と schema に同じ正規表現を置く。
 * Date.parse は使わない —— Bun(JSC)は 2 月 30 日を 3 月へ繰り上げて通し、ミリ秒より細かい桁を捨てる(engine で verdict と順序が割れる) */
export const TIMESTAMP_RE =
  /^(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?Z$/;
/** 瞬間の順に並ぶ文字列(小数秒を 9 桁に揃える)。UTC の `Z` だけなので桁の比較 = 時刻の比較 */
const instant = (t: string) => t.slice(0, 19) + t.slice(20, -1).padEnd(9, "0");
const EXT_KEY_RE = /^[a-z0-9-]+\.[A-Za-z0-9_.-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** capsule.ts の credential_ref(env:NAME)と同じ名前の構文 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** migration 060 の work_items_owner_shape と同じ形 */
const OWNER_RE = /^[a-z]+:[^:]+$/;
/** RFC 7518 §6.2.2 / §6.3.2 / §6.4 の private member。1 つでも在れば公開鍵ではない(I-9) */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

export const PAAP_SHAPES = {
  identity: {
    required: {
      protocol: "string",
      account_id: "string",
      agent_id: "string",
      display_name: "string",
      handles: { items: { required: { handle: "string", status: HANDLE_STATUSES }, optional: { authority: "string" } } },
      keys: {
        required: {
          devices: {
            items: { required: { id: "string", name: "string", jwk: "jwk" }, optional: { revoked_at: "timestamp" } },
          },
        },
        optional: { account: { required: { key_id: "string", jwk: "jwk" } } },
      },
      exported_at: "timestamp",
    },
    optional: { owner: OWNER_RE, ext: "ext" },
  },
  work: {
    required: {
      id: "string",
      owner: OWNER_RE,
      title: "string",
      status: WORK_STATUSES,
      visibility: CLOUD_VISIBILITIES,
      lease: {
        required: { epoch: "int" },
        optional: { holder_run: "string", acquired_at: "timestamp", expires_at: "timestamp" },
      },
      profile: Object.keys(CONTEXT_PROFILES),
      created_at: "timestamp",
      updated_at: "timestamp",
    },
    optional: {
      goal: "string",
      parent_work_id: "string",
      forked_from: { required: { work_id: "string", checkpoint_version: "version" } },
      ext: "ext",
    },
  },
  checkpoint: {
    required: {
      work_id: "string",
      version: "version",
      write_epoch: "int",
      content_hash: SHA256_RE,
      body: { required: {}, optional: Object.fromEntries(CAPSULE_FIELDS.map((f) => [f, "any" as const])) },
      created_at: "timestamp",
    },
    optional: {
      run_id: "string",
      based_on: { required: { version: "version" }, optional: { work_id: "string" } },
      ext: "ext",
    },
  },
  handoff: {
    required: {
      id: "string",
      work_id: "string",
      from_epoch: "int",
      reserved_epoch: "int",
      to_runtime: "string",
      state: TRANSFER_STATES,
      expires_at: "timestamp",
      created_at: "timestamp",
      updated_at: "timestamp",
    },
    optional: {
      from_run: "string",
      source_state: HANDOFF_SOURCE_STATES,
      checkpoint_version: "version",
      reason: "string",
      note: "string",
      ext: "ext",
    },
  },
  manifest: {
    required: {
      protocol: "string",
      exported_at: "timestamp",
      exporter: { required: { name: "string", version: "string" } },
      contents: { items: { required: { path: "string", sha256: SHA256_RE } } },
      reenter: { required: { credential_refs: { items: ENV_NAME_RE }, devices: "int" } },
    },
    optional: { ext: "ext" },
  },
} as const satisfies Record<string, Shape>;

type Failure = Extract<Verdict, { ok: false }>;
const OK: Verdict = { ok: true };
const fail = (reason: PaapReason, at: string): Failure => ({ ok: false, reason, at });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function checkShape(value: unknown, shape: Shape, at: string): Failure | null {
  if (!isRecord(value)) return fail("invalid_field", at || "/");
  const known: Record<string, Kind> = { ...shape.required, ...shape.optional };
  for (const key of Object.keys(value)) if (!Object.hasOwn(known, key)) return fail("unknown_key", `${at}/${key}`);
  for (const key of Object.keys(shape.required)) if (!Object.hasOwn(value, key)) return fail("missing_field", `${at}/${key}`);
  for (const [key, kind] of Object.entries(known)) {
    if (!Object.hasOwn(value, key)) continue;
    const f = checkKind(value[key], kind, `${at}/${key}`);
    if (f) return f;
  }
  return null;
}

function checkKind(v: unknown, kind: Kind, at: string): Failure | null {
  const bad = fail("invalid_field", at);
  if (kind === "any") return null;
  if (kind === "string") return typeof v === "string" && v.length > 0 ? null : bad;
  if (kind === "int" || kind === "version") {
    return typeof v === "number" && Number.isInteger(v) && v >= (kind === "int" ? 0 : 1) ? null : bad;
  }
  if (kind === "timestamp") return typeof v === "string" && TIMESTAMP_RE.test(v) ? null : bad;
  if (kind === "ext") return isRecord(v) && Object.keys(v).every((k) => EXT_KEY_RE.test(k)) ? null : bad;
  if (kind === "jwk") {
    if (!isRecord(v) || typeof v.kty !== "string" || v.kty === "") return bad;
    const priv = PRIVATE_JWK_MEMBERS.find((m) => Object.hasOwn(v, m));
    return priv ? fail("private_key_in_export", `${at}/${priv}`) : null;
  }
  if (kind instanceof RegExp) return typeof v === "string" && kind.test(v) ? null : bad;
  if (Array.isArray(kind)) return typeof v === "string" && kind.includes(v) ? null : bad;
  if ("items" in kind) {
    if (!Array.isArray(v)) return bad;
    for (let i = 0; i < v.length; i++) {
      const f = checkKind(v[i], kind.items, `${at}/${i}`);
      if (f) return f;
    }
    return null;
  }
  return checkShape(v, kind as Shape, at);
}

/** 版を先に見る: 新しい版の文書を「未知の key」ではなく「読めない版」と名乗る */
function checkProtocol(value: unknown): Failure | null {
  return isRecord(value) && typeof value.protocol === "string" && value.protocol !== PAAP_VERSION
    ? fail("unsupported_protocol", "/protocol")
    : null;
}

/** JCS(RFC 8785)は I-JSON しか受けない。lone surrogate は実装ごとに hash が割れる */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === "string") return LONE_SURROGATE_RE.test(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (isRecord(v)) return Object.entries(v).some(([k, x]) => LONE_SURROGATE_RE.test(k) || hasLoneSurrogate(x));
  return false;
}

/** I-JSON(RFC 7493 §2.3)は 1 つの object に同じ member 名を 2 度書かせない。JSON.parse は後勝ちで黙る(先勝ちの parser は
 * 別の文書を読む = body の会話 key を隠せる)ので、parse できた text を string と `{` `}` の token に割って名前を数える */
const JSON_TOKEN_RE = /"(?:[^"\\]+|\\.)*"(\s*:)?|[{}]/g;
function hasDuplicateMember(text: string): boolean {
  const open: Set<string>[] = [];
  for (const [token, colon] of text.matchAll(JSON_TOKEN_RE)) {
    if (token === "{") open.push(new Set());
    else if (token === "}") open.pop();
    else if (colon !== undefined) {
      const names = open.at(-1);
      const name = JSON.parse(token.slice(0, -colon.length)) as string;
      if (names?.has(name)) return true;
      names?.add(name);
    }
  }
  return false;
}

// ---------- 1 文書ずつ ----------

export function validateManifest(value: unknown): Verdict {
  return checkProtocol(value) ?? checkShape(value, PAAP_SHAPES.manifest, "") ?? OK;
}

export function validateIdentity(value: unknown): Verdict {
  const f = checkProtocol(value) ?? checkShape(value, PAAP_SHAPES.identity, "");
  if (f) return f;
  const current = (value as unknown as PaapIdentity).handles.filter((h) => h.status === "current");
  return current.length > 1 ? fail("invalid_field", "/handles") : OK;
}

export function validateWork(value: unknown): Verdict {
  return checkShape(value, PAAP_SHAPES.work, "") ?? OK;
}

/** `profile` は checkpoint が属する work の profile(I-8)。省略 = 絞らない */
export function validateCheckpoint(value: unknown, opts: { profile?: ContextProfile } = {}): Verdict {
  // I-2 を形より先に: body の top-level に `messages` を置いた時も unknown_key ではなく会話の壁で名乗る
  // (buildCapsule と同じ優先)
  if (isRecord(value) && findConversationKeys(value.body).length > 0) return fail("conversation_in_checkpoint", "/body");
  const f = checkShape(value, PAAP_SHAPES.checkpoint, "");
  if (f) return f;
  const cp = value as unknown as PaapCheckpoint;
  try {
    validateCredentialRefs(cp.body);
  } catch (e) {
    if (e instanceof CapsuleCredentialRefError) return fail("invalid_credential_ref", "/body");
    throw e;
  }
  if (hasLoneSurrogate(cp.body)) return fail("not_i_json", "/body");
  if (hashCapsuleBody(cp.body) !== cp.content_hash) return fail("content_hash_mismatch", "/content_hash");
  const allow = opts.profile ? CONTEXT_PROFILES[opts.profile] : null;
  const extra = allow && Object.keys(cp.body).find((k) => !(allow.capsuleFields as readonly string[]).includes(k));
  return extra ? fail("profile_field_not_allowed", `/body/${extra}`) : OK;
}

export function validateHandoff(value: unknown): Verdict {
  const f = checkShape(value, PAAP_SHAPES.handoff, "");
  if (f) return f;
  const h = value as unknown as PaapHandoff;
  return h.reserved_epoch !== h.from_epoch + 1 ? fail("epoch_not_reserved", "/reserved_epoch") : OK;
}

// ---------- capsule directory(I-1〜I-11 を全部) ----------

const MANIFEST = "manifest.json";
const IDENTITY = "identity.json";

class Stop {
  constructor(
    readonly reason: PaapReason,
    readonly path: string,
    readonly at = "",
  ) {}
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `files` = capsule 内の相対 path(区切りは `/`)→ file の bytes。1 つ目に見つけた破れを返す */
export function validateCapsule(files: Readonly<Record<string, Uint8Array>>): CapsuleVerdict {
  try {
    return { ok: true, capsule: readCapsule(files) };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: e.reason, path: e.path, at: e.at };
    throw e;
  }
}

function readCapsule(all: Readonly<Record<string, Uint8Array>>): PaapCapsule {
  // `.` で始まる名前(.DS_Store 等)は capsule の一部ではない(spec §3)
  const files = Object.fromEntries(Object.entries(all).filter(([p]) => !p.split("/").some((s) => s.startsWith("."))));
  const doc = (path: string): unknown => {
    const bytes = files[path];
    if (bytes === undefined) throw new Stop("missing_file", path);
    let text: string;
    let value: unknown;
    try {
      // ignoreBOM: BOM を読み飛ばさず text に残す → JSON.parse が落ちる(spec §2。RFC 8259 は無視も許すので実装ごとに割れていた)
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      value = JSON.parse(text);
    } catch {
      throw new Stop("invalid_json", path);
    }
    if (hasDuplicateMember(text)) throw new Stop("invalid_json", path);
    // I-JSON は file 全体(body の外の lone surrogate も、読み手が出力する時に落ちる)
    if (hasLoneSurrogate(value)) throw new Stop("not_i_json", path);
    return value;
  };
  const need = (v: Verdict, path: string) => {
    if (!v.ok) throw new Stop(v.reason, path, v.at);
  };

  // I-11 前半: manifest.contents = manifest 以外の全 file・sha256 は bytes と一致
  const manifestDoc = doc(MANIFEST);
  need(validateManifest(manifestDoc), MANIFEST);
  const manifest = manifestDoc as PaapManifest;
  const listed = new Map(manifest.contents.map((c) => [c.path, c.sha256]));
  if (listed.size !== manifest.contents.length || listed.has(MANIFEST)) {
    throw new Stop("manifest_contents_mismatch", MANIFEST, "/contents");
  }
  const paths = Object.keys(files).sort(cmp);
  for (const path of paths) if (path !== MANIFEST && !listed.has(path)) throw new Stop("manifest_contents_mismatch", path);
  for (const [path, sha] of [...listed].sort(([a], [b]) => cmp(a, b))) {
    const bytes = files[path];
    if (bytes === undefined) throw new Stop("manifest_contents_mismatch", path);
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha) {
      throw new Stop("manifest_hash_mismatch", path);
    }
  }

  const identityDoc = doc(IDENTITY);
  need(validateIdentity(identityDoc), IDENTITY);
  const identity = identityDoc as PaapIdentity;

  // works/<work_id>/{work.json, checkpoints/<version>.json, handoffs/<handoff_id>.json}。他の path は後の版の席(読まない)
  const layout = new Map<string, { checkpoints: string[]; handoffs: string[] }>();
  for (const path of paths) {
    const seg = path.split("/");
    const [top, id, dir, name] = seg;
    if (top !== "works" || id === undefined || seg.length < 3) continue;
    const entry = layout.get(id) ?? { checkpoints: [], handoffs: [] };
    layout.set(id, entry);
    if (seg.length === 4 && name?.endsWith(".json") && (dir === "checkpoints" || dir === "handoffs")) {
      entry[dir].push(path);
    }
  }

  const works: PaapCapsule["works"] = [];
  const refs = new Set<string>();
  const versionsOf = new Map<string, Set<number>>();
  const basedOn: { path: string; workId: string; cp: PaapCheckpoint }[] = [];
  for (const [workId, entry] of [...layout].sort(([a], [b]) => cmp(a, b))) {
    const workPath = `works/${workId}/work.json`;
    const workDoc = doc(workPath);
    need(validateWork(workDoc), workPath);
    const work = workDoc as PaapWork;
    if (work.id !== workId) throw new Stop("path_mismatch", workPath, "/id");

    const checkpoints = entry.checkpoints
      .map((path) => {
        const cpDoc = doc(path);
        need(validateCheckpoint(cpDoc, { profile: work.profile }), path);
        const cp = cpDoc as PaapCheckpoint;
        if (cp.work_id !== workId) throw new Stop("path_mismatch", path, "/work_id");
        if (!path.endsWith(`/${cp.version}.json`)) throw new Stop("path_mismatch", path, "/version");
        return { path, cp };
      })
      .sort((a, b) => a.cp.version - b.cp.version);
    // I-1: version は 1 から連番
    checkpoints.forEach(({ path, cp }, i) => {
      if (cp.version !== i + 1) throw new Stop("version_gap", path, "/version");
    });
    // I-11 後半の材料: credential_ref の名前(形は validateCheckpoint で検査済み。値は無い)
    for (const { cp } of checkpoints) {
      for (const name of buildManifest(cp.body, { hash: "", size: 0, mode: "" }).refs) refs.add(name);
    }

    const versions = new Set(checkpoints.map(({ cp }) => cp.version));
    versionsOf.set(workId, versions);
    for (const { path, cp } of checkpoints) if (cp.based_on) basedOn.push({ path, workId, cp });
    let inProgress = 0;
    const handoffs = entry.handoffs.map((path) => {
      const hDoc = doc(path);
      need(validateHandoff(hDoc), path);
      const h = hDoc as PaapHandoff;
      if (h.work_id !== workId) throw new Stop("path_mismatch", path, "/work_id");
      if (!path.endsWith(`/${h.id}.json`)) throw new Stop("path_mismatch", path, "/id");
      // I-6
      if ((TRANSFER_IN_PROGRESS_STATES as readonly string[]).includes(h.state) && ++inProgress > 1) {
        throw new Stop("handoff_in_progress_twice", path, "/state");
      }
      // I-7: handoff が指す checkpoint は(failed でも)残っている
      if (h.checkpoint_version !== undefined && !versions.has(h.checkpoint_version)) {
        throw new Stop("handoff_checkpoint_missing", path, "/checkpoint_version");
      }
      // I-5 後半: 進行中は lease を handoff 自身が握る(epoch = reserved_epoch)・committed で次の holder が
      // reserved_epoch + 1 を取る(参照実装の PREPARE / COMMIT がそれぞれ +1)
      const inFlight = (TRANSFER_IN_PROGRESS_STATES as readonly string[]).includes(h.state);
      const needed = h.state === "committed" ? h.reserved_epoch + 1 : inFlight ? h.reserved_epoch : 0;
      if (work.lease.epoch < needed) throw new Stop("lease_behind_handoff", path, "/reserved_epoch");
      return h;
    });
    works.push({ work, checkpoints: checkpoints.map(({ cp }) => cp), handoffs });
  }

  // I-12: based_on は書いた時に在った版 = 同じ work なら自分より前の版・別 work なら capsule 内に在る版
  // (別 work の版は全 work を読んでからでないと引けないので、ここでまとめて見る)
  for (const { path, workId, cp } of basedOn) {
    const { work_id = workId, version } = cp.based_on as { work_id?: string; version: number };
    const exists = versionsOf.get(work_id)?.has(version) === true;
    if (!exists || (work_id === workId && version >= cp.version)) throw new Stop("based_on_missing", path, "/based_on");
  }

  // I-11 後半: reenter = 付け直しが要る物の数(値は無い)
  if (JSON.stringify(manifest.reenter.credential_refs) !== JSON.stringify([...refs].sort(cmp))) {
    throw new Stop("reenter_mismatch", MANIFEST, "/reenter/credential_refs");
  }
  if (manifest.reenter.devices !== identity.keys.devices.filter((d) => d.revoked_at === undefined).length) {
    throw new Stop("reenter_mismatch", MANIFEST, "/reenter/devices");
  }
  return { manifest, identity, works };
}

// ---------- L1 Reader の要約(spec §8.1 の規則) ----------

export interface CapsuleSummary {
  protocol: string;
  handle: string | null;
  display_name: string;
  current_work: { id: string; title: string; status: string } | null;
  latest_checkpoint: { version: number; write_epoch: number; content_hash: string; brief_sections: string[] } | null;
  last_handoff: { id: string; state: string; to_runtime: string; reserved_epoch: number } | null;
  reenter: { credential_refs: string[]; devices: number };
}

/** 新しい順(時刻の降順・小数秒の最後の桁まで)・同時刻は id の昇順で先頭 1 つ */
function newest<T>(xs: readonly T[], key: (x: T) => [time: string, id: string]): T | undefined {
  return [...xs].sort((a, b) => cmp(instant(key(b)[0]), instant(key(a)[0])) || cmp(key(a)[1], key(b)[1]))[0];
}

export function summarizeCapsule(capsule: PaapCapsule): CapsuleSummary {
  const handle = capsule.identity.handles.find((h) => h.status === "current")?.handle;
  const current = newest(
    capsule.works.filter(({ work }) => work.status !== "done"),
    ({ work }) => [work.updated_at, work.id],
  );
  const cp = current?.checkpoints.at(-1);
  const handoff = current && newest(current.handoffs, (h) => [h.created_at, h.id]);
  return {
    protocol: capsule.manifest.protocol,
    handle: handle === undefined ? null : `@${handle}`,
    display_name: capsule.identity.display_name,
    current_work: current ? { id: current.work.id, title: current.work.title, status: current.work.status } : null,
    latest_checkpoint: cp
      ? {
          version: cp.version,
          write_epoch: cp.write_epoch,
          content_hash: cp.content_hash,
          brief_sections: CAPSULE_FIELDS.filter((f) => cp.body[f] !== undefined),
        }
      : null,
    last_handoff: handoff
      ? { id: handoff.id, state: handoff.state, to_runtime: handoff.to_runtime, reserved_epoch: handoff.reserved_epoch }
      : null,
    reenter: capsule.manifest.reenter,
  };
}
