// PBI-0553 / CAP-15 Z1・CAP-10 T1: OpenRoly の API 応答 → PAAP v0.1 capsule directory の写像(export の正本 1 箇所)と、
// L3 Continuer の判定(`--continued-from`)。1 つの capsule の正しさは protocol.ts の validateCapsule が持つ ——
// ここは再実装しない。ここが持つのは「OpenRoly の何を・どの名前で出すか」と「2 つの capsule の間の約束」だけ。
// 写像の決定は docs/protocol-roadmap.md「入れない物」: owner_runtime_id / handled_* / preferred_runtime /
// source_thread_id / external_ref / priority / summary / CAS の payload_hash・size・mode / refs は出さない。
// **node builtin を import しない**(capsule.ts と同じ理由 = web bundle)。

import { buildManifest, hashCapsuleBody, type CapsuleBody } from "./capsule.ts";
import { PAAP_VERSION, type PaapCapsule } from "./protocol.ts";
import { CONTEXT_PROFILES, isTransferHolderId, type ContextProfile } from "./work.ts";

type Row = Record<string, unknown>;

export interface CapsuleExportInput {
  exportedAt: Date;
  exporter: { name: string; version: string };
  /** GET /v1/whoami(current handle だけ。alias を返す API は無い) */
  account: { account_id: string; agent_id: string; display_name?: string | null; handle: string };
  /** GET /v1/me/account-key。wraps(包まれた秘密鍵)は渡されても読まない */
  accountKey: { key_id: string; public_key_jwk: unknown } | null;
  /** GET /v1/devices(revoke 済みは API が返さない) */
  devices: { id: string; device_name: string; public_key_jwk: unknown }[];
  works: {
    /** GET /v1/works の行 */
    work: Row;
    /** GET /v1/works/:id/capsules の行と、その payload_hash でこの端末の CAS から読んだ本文(無ければ null) */
    capsules: { row: Row; payload: CapsuleBody | null }[];
    /** GET /v1/works/:id/transfers の行 */
    transfers: Row[];
  }[];
  /** この端末が持つ秘密の値(runtime の token)。本文は agent が書く自由な JSON なので、値が紛れたら書き出さない(I-9・spec §11) */
  secrets: readonly string[];
}

export const EXPORT_PROBLEMS = ["payload_missing", "payload_mismatch", "invalid_id", "secret_value", "missing_field"] as const;
export type ExportProblem = {
  reason: (typeof EXPORT_PROBLEMS)[number];
  work_id: string;
  version?: number;
  /** `missing_field` の時だけ: spec の required のうち server が送ってこなかった欄名 */
  field?: string;
};

/** `files` = capsule 内の path → そのまま書く text(manifest.json を含む・path の昇順) */
export type CapsuleExportResult = { ok: true; files: Record<string, string> } | { ok: false; problems: ExportProblem[] };

/** RFC 7517 / 7518 の公開 member だけを通す(I-9)。private member を「消す」のではなく、知っている公開 member しか運ばない */
const PUBLIC_JWK_MEMBERS = ["kty", "crv", "x", "y", "n", "e", "alg", "use", "key_ops", "kid"] as const;
/** file 名になる id。`/` や `..` を含む値で capsule の外へ書かせない */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const present = (v: unknown): boolean => v !== null && v !== undefined && v !== "";
const str = (v: unknown): string | undefined => (present(v) ? String(v) : undefined);
const ts = (v: unknown): string | undefined => (present(v) ? new Date(String(v)).toISOString() : undefined);

/**
 * **spec の required 欄を「server が送ってきた物」から読む唯一の道**(PBI-0626)。
 *
 * 素の `String(v)` は欠落で例外を投げず **文字列 `"undefined"` を作る** ので、
 * 「server が送らなかった」が「壊れた値を書いた」に化けて、判定が capsule を書き終えた後の
 * schema 検査まで遅れる —— 出る言葉は `invalid_field: …/work.json/owner` で、**欄は名指すが
 * 原因(server の版が古い)を名指さない**。読んだ人は exporter か schema を疑う。
 *
 * 欠落の定義は `present` に合わせる(`null` / `undefined` / `""` を同じに扱う)。
 * **在る値の正しさは見ない** —— 型違い(`owner: 123`)や pattern 外れは schema の持ち場で、
 * ここで捕まえると「送られてこなかった」と「送られてきたが変」が 1 つの言葉に潰れる。
 * 呼び手は**問題を積んでも続ける**(1 つの work で 2 欄欠けたら 2 件出す)。
 */
const req = (
  problems: ExportProblem[],
  workId: string,
  field: string,
  v: unknown,
): string | undefined => {
  if (!present(v)) {
    problems.push({ reason: "missing_field", work_id: workId, field });
    return undefined;
  }
  return String(v);
};

/** `req` の数値版(lease.epoch)。欠落は同じ problem、在れば Number に通す */
const reqNum = (
  problems: ExportProblem[],
  workId: string,
  field: string,
  v: unknown,
): number | undefined => (req(problems, workId, field, v) === undefined ? undefined : Number(v));

/** `req` の時刻版(created_at / updated_at)。欠落は同じ problem、在れば ISO に正規化する */
const reqTs = (
  problems: ExportProblem[],
  workId: string,
  field: string,
  v: unknown,
): string | undefined => (req(problems, workId, field, v) === undefined ? undefined : ts(v));
/** spec §2: optional は null ではなく省く */
function compact<T extends Row>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
function publicJwk(jwk: unknown): Row {
  const src = jwk !== null && typeof jwk === "object" ? (jwk as Row) : {};
  return Object.fromEntries(PUBLIC_JWK_MEMBERS.filter((m) => Object.hasOwn(src, m)).map((m) => [m, src[m]]));
}
const doc = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function buildCapsuleFiles(input: CapsuleExportInput): CapsuleExportResult {
  const exportedAt = input.exportedAt.toISOString();
  const problems: ExportProblem[] = [];
  const files: Record<string, string> = {};
  const refs = new Set<string>();

  files["identity.json"] = doc({
    protocol: PAAP_VERSION,
    account_id: input.account.account_id,
    agent_id: input.account.agent_id,
    display_name: str(input.account.display_name) ?? input.account.handle,
    handles: [{ handle: input.account.handle, status: "current" }],
    keys: compact({
      account: input.accountKey ? { key_id: input.accountKey.key_id, jwk: publicJwk(input.accountKey.public_key_jwk) } : undefined,
      devices: input.devices.map((d) => ({ id: d.id, name: d.device_name, jwk: publicJwk(d.public_key_jwk) })),
    }),
    exported_at: exportedAt,
  });

  for (const { work: w, capsules, transfers } of input.works) {
    const workId = String(w.id);
    if (!PATH_SEGMENT_RE.test(workId)) {
      problems.push({ reason: "invalid_id", work_id: workId });
      continue;
    }
    const profile = (str(w.context_profile) ?? "full") as ContextProfile;
    const forkedFrom =
      present(w.forked_from_work_id) && present(w.forked_from_capsule_version)
        ? { work_id: String(w.forked_from_work_id), checkpoint_version: Number(w.forked_from_capsule_version) }
        : undefined;
    // PBI-0626: spec の required(id / owner / title / status / visibility / lease / profile /
    // created_at / updated_at)のうち **server の行から来る物は req を通す** —— 欠落を
    // `"undefined"` という文字列に化けさせない。id は上の PATH_SEGMENT_RE、profile は既定値を持つ
    files[`works/${workId}/work.json`] = doc(
      compact({
        id: workId,
        owner: req(problems, workId, "owner", w.owner),
        title: req(problems, workId, "title", w.title),
        status: req(problems, workId, "status", w.status),
        visibility: req(problems, workId, "visibility", w.visibility),
        lease: compact({
          epoch: reqNum(problems, workId, "lease.epoch", w.lease_epoch),
          // spec §6 freeze: 進行中の handoff は「誰も lease を持たない」。予約 holder(transfer:<id>)は run ではないので出さない
          holder_run: isTransferHolderId(str(w.lease_holder_run)) ? undefined : str(w.lease_holder_run),
          acquired_at: ts(w.lease_acquired_at),
          expires_at: ts(w.lease_expires_at),
        }),
        profile,
        parent_work_id: str(w.parent_work_id),
        forked_from: forkedFrom,
        created_at: reqTs(problems, workId, "created_at", w.created_at),
        updated_at: reqTs(problems, workId, "updated_at", w.updated_at),
      }),
    );

    // I-8: reviewer_blind の枝は allowlist の field だけを知る。server は fork で元の版の manifest をそのまま写すので、
    // CAS の本文は元の全 field を持つ —— 出す時に絞り、hash は絞った本文で取り直す
    const allow = Object.hasOwn(CONTEXT_PROFILES, profile) ? CONTEXT_PROFILES[profile] : null;
    for (const { row, payload } of capsules) {
      const version = Number(row.version);
      const manifest = (row.body ?? {}) as { payload_hash?: unknown };
      if (payload === null || typeof manifest.payload_hash !== "string") {
        problems.push({ reason: "payload_missing", work_id: workId, version });
        continue;
      }
      // CAS は file 名を hash にしているだけで中身を検証しない。書き換わった本文を「その版」として出さない
      if (hashCapsuleBody(payload) !== manifest.payload_hash) {
        problems.push({ reason: "payload_mismatch", work_id: workId, version });
        continue;
      }
      const body: CapsuleBody = allow
        ? Object.fromEntries(Object.entries(payload).filter(([k]) => (allow.capsuleFields as readonly string[]).includes(k)))
        : payload;
      for (const name of buildManifest(body, { hash: "", size: 0, mode: "" }).refs) refs.add(name);
      files[`works/${workId}/checkpoints/${version}.json`] = doc(
        compact({
          work_id: workId,
          version,
          write_epoch: Number(row.write_epoch),
          run_id: isTransferHolderId(str(row.run_id)) ? undefined : str(row.run_id),
          content_hash: hashCapsuleBody(body),
          // I-12 / spec 付録 A work_fork: 枝の最初の版は fork 元の版を based_on に持つ(server は枝の v1 に元の版を写す)
          based_on: forkedFrom && version === 1 ? { work_id: forkedFrom.work_id, version: forkedFrom.checkpoint_version } : undefined,
          body,
          created_at: ts(row.created_at),
        }),
      );
    }

    for (const t of transfers) {
      const id = String(t.id);
      if (!PATH_SEGMENT_RE.test(id)) {
        problems.push({ reason: "invalid_id", work_id: workId });
        continue;
      }
      // work_items.handoff_note は handoff(= transfer)の note ではない(「誰が係か」/ fork の note)ので載せない
      files[`works/${workId}/handoffs/${id}.json`] = doc(
        compact({
          id,
          work_id: workId,
          from_run: str(t.from_run),
          from_epoch: Number(t.from_epoch),
          reserved_epoch: Number(t.reserved_epoch),
          to_runtime: String(t.to_runtime_kind),
          source_state: str(t.source_state),
          checkpoint_version: present(t.capsule_version) ? Number(t.capsule_version) : undefined,
          state: String(t.state),
          reason: str(t.reason),
          expires_at: ts(t.expires_at),
          created_at: ts(t.created_at),
          updated_at: ts(t.updated_at),
        }),
      );
    }
  }

  // 知っている秘密だけを値で探す(知らない秘密は見つけられない。key 名で縛れるのは I-4 の credential_ref だけ)
  for (const [path, text] of Object.entries(files)) {
    if (!input.secrets.some((s) => s !== "" && text.includes(s))) continue;
    const [, workId = path, version] = /^works\/([^/]+)\/(?:checkpoints\/(\d+)\.json)?/.exec(path) ?? [];
    problems.push({ reason: "secret_value", work_id: workId, ...(version === undefined ? {} : { version: Number(version) }) });
  }
  if (problems.length > 0) return { ok: false, problems };

  const paths = Object.keys(files).sort(cmp);
  const encoder = new TextEncoder();
  files["manifest.json"] = doc({
    protocol: PAAP_VERSION,
    exported_at: exportedAt,
    exporter: input.exporter,
    contents: paths.map((path) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256").update(encoder.encode(files[path])).digest("hex"),
    })),
    reenter: { credential_refs: [...refs].sort(cmp), devices: input.devices.length },
  });
  return { ok: true, files: Object.fromEntries(Object.keys(files).sort(cmp).map((p) => [p, files[p]!])) };
}

// ---------- L3 Continuer(spec §8 の L3 行): `prev` の routed な handoff を `next` が続けたか ----------

export const CONTINUATION_REASONS = [
  "identity_mismatch",
  "no_routed_handoff",
  "checkpoint_lost",
  "handoff_not_committed",
  "handoff_rewritten",
  "no_continuation_checkpoint",
  "continuation_epoch_mismatch",
] as const;
export type ContinuationReason = (typeof CONTINUATION_REASONS)[number];
const HANDOFF_KEPT = [
  "work_id",
  "from_run",
  "from_epoch",
  "reserved_epoch",
  "to_runtime",
  "source_state",
  "checkpoint_version",
  "note",
  "expires_at",
  "created_at",
] as const;
export type ContinuationVerdict =
  | { ok: true; continued: { work_id: string; handoff_id: string; version: number }[] }
  | { ok: false; reason: ContinuationReason; path: string };

/**
 * どちらも validateCapsule を通った capsule を渡す(1 つの capsule の中の約束 —— committed なら lease.epoch ≥
 * reserved_epoch + 1 等 —— はそちらが既に見ている。ここで書き写さない)。判定の順: 同じ account か → 続ける handoff が
 * 在るか → prev の checkpoint が全部同じ hash で残っているか(I-1・I-7)→ handoff ごとに committed / version = prev の
 * 最新 + 1 が在る / その write_epoch = reserved_epoch + 1(commit で lease.epoch がそこへ進み、新しい holder がその
 * epoch で書く = spec §8 L3)。prev の routed な handoff は**全部**続いている事
 */
export function verifyContinuation(prev: PaapCapsule, next: PaapCapsule): ContinuationVerdict {
  const bad = (reason: ContinuationReason, path: string): ContinuationVerdict => ({ ok: false, reason, path });
  if (prev.identity.account_id !== next.identity.account_id) return bad("identity_mismatch", "identity.json");
  const nextWorks = new Map(next.works.map((x) => [x.work.id, x]));

  const routed = prev.works.flatMap((x) => x.handoffs.filter((h) => h.state === "routed"));
  if (routed.length === 0) return bad("no_routed_handoff", "manifest.json");

  for (const { work, checkpoints } of prev.works) {
    const kept = new Map((nextWorks.get(work.id)?.checkpoints ?? []).map((c) => [c.version, c.content_hash]));
    for (const cp of checkpoints) {
      if (kept.get(cp.version) !== cp.content_hash) return bad("checkpoint_lost", `works/${work.id}/checkpoints/${cp.version}.json`);
    }
  }

  const continued: { work_id: string; handoff_id: string; version: number }[] = [];
  for (const h of routed) {
    const handoffPath = `works/${h.work_id}/handoffs/${h.id}.json`;
    const after = nextWorks.get(h.work_id);
    const committed = after?.handoffs.find((x) => x.id === h.id);
    if (!after || committed?.state !== "committed") return bad("handoff_not_committed", handoffPath);
    // commit が変えるのは state と updated_at だけ(spec §8 L3)。epoch・行き先・起点の版を書き換えれば、下の epoch の照合を
    // 書き換えた値で通せてしまう
    if (HANDOFF_KEPT.some((k) => committed[k] !== h[k])) return bad("handoff_rewritten", handoffPath);
    const prevLatest = prev.works.find((x) => x.work.id === h.work_id)?.checkpoints.at(-1)?.version ?? 0;
    const cp = after.checkpoints.find((c) => c.version === prevLatest + 1);
    const cpPath = `works/${h.work_id}/checkpoints/${prevLatest + 1}.json`;
    if (!cp) return bad("no_continuation_checkpoint", cpPath);
    if (cp.write_epoch !== h.reserved_epoch + 1) return bad("continuation_epoch_mismatch", cpPath);
    continued.push({ work_id: h.work_id, handoff_id: h.id, version: cp.version });
  }
  return { ok: true, continued };
}
