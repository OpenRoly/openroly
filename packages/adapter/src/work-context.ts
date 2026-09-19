// PBI-0433: Work Project context の端末側。
//
// server は索引(kind / key / value_hash / size)しか持たない(apps/server/migrations/053)。
// ここが持つのは「value を CAS に書く」「source file を hash する」「server の索引を agent に見せる
// entry へ組み直す」の 3 つで、**MCP(packages/mcp)と CLI(apps/cli)が同じ関数を呼ぶ** ——
// 組み直しを 2 箇所に書くと、片方だけが missing_on_device を黙って落とす形に割れる。
// PBI-0446: 値は自分の account 公開鍵へ seal して server に預け、別端末は開いて hash を確かめてから CAS に置く(図80d)。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { open, seal, type EncryptedEnvelope } from "@openroly/crypto-envelope";
import {
  buildContextValue,
  estimateTokens,
  isValidCasHash,
  validateContextKey,
  verifySealedValue,
  WORK_CONTEXT_SYNC_MAX_BYTES,
  WORK_CONTEXT_BRIEF_KEYS,
  WORK_CONTEXT_WELL_KNOWN_KEYS,
  type ContextSyncReason,
  type ContextValuePayload,
  type WorkContextKind,
} from "@openroly/core";
import { checkpointsDir, readCasPayload, writeCasPayload } from "./checkpoint-cas.ts";
import { openrolyHome } from "./credentials.ts";
import { ownAccountPublicKey, readerKeys, type E2eeCall } from "./e2ee.ts";

type Env = Record<string, string | undefined>;

/** server に送る索引 1 行(value は入らない) */
export interface ContextIndexEntryInput {
  kind: WorkContextKind;
  key: string;
  value_hash: string;
  size: number;
  expected_version?: number;
}

/** server が返す索引 1 行 */
export interface ContextIndexRow {
  kind: string;
  key: string;
  version: number;
  value_hash: string;
  size: number;
  run_id: string | null;
  runtime_id: string | null;
  actor: string;
  updated_at: string;
  /** PBI-0434: work = この work の行 / project = 親の Work Project の行 / PBI-0440: fork = fork 元の work の行 */
  scope?: string;
  /** PBI-0443: publish で task から写した行だけが持つ */
  published_from_work_id?: string | null;
  published_from_version?: number | null;
  /** PBI-0444: その work 自身の inbox/ 行だけが持つ(既読か) */
  read?: boolean;
}

export type SourceStatus = "same" | "changed" | "missing";

/** agent / 人に見せる 1 件 */
export interface ResolvedContextEntry {
  kind: string;
  key: string;
  version: number;
  written_by: { actor: string; runtime_id: string | null; run_id: string | null };
  updated_at: string;
  /** PBI-0434: task の search では project の行も来る(同じ key が両方に在っても両方返す) */
  scope?: string;
  /** PBI-0443: task から公開された行の出所 `<task の work id>@<版>` */
  published_from?: string;
  /** PBI-0444: その work 自身の inbox/ 行だけ。この search の前に既読だったか */
  read?: boolean;
  /** context: 値。この端末に無ければ null + missing_on_device */
  value?: unknown;
  missing_on_device?: boolean;
  /** PBI-0446: この端末に無く、account から開いた値 */
  fetched_from?: "account";
  /** PBI-0446: missing_on_device の理由。無い = account にまだ上がっていない */
  reason?: ContextSyncReason;
  /** source: 手元の file を再 hash した結果 */
  source_status?: SourceStatus;
  /** PBI-0438 index_only: この行を値付きで取ったら何 token か / 値の先頭(端末で読んだ物) */
  est_tokens?: number;
  preview?: string | null;
}

/** 端末に無い値を account から開く時の材料(開ける鍵は inbox_read と同じ readerKeys の順) */
export interface ContextAccount {
  call: E2eeCall;
  deviceKind: string;
}

// ---------- 2 段取得と 1 回の上限(PBI-0438・「123やる」の 3) ----------

/** 1 回の search で agent に渡す量の既定と上限(Context Package の ≤1,000 と同じ見積もり estimateTokens で数える) */
export const CONTEXT_SEARCH_DEFAULT_MAX_TOKENS = 2_000;
export const CONTEXT_SEARCH_MAX_TOKENS = 20_000;
/** receipt に名前を出す外れ行の上限(receipt 自体が上限を食わないように) */
export const CONTEXT_SEARCH_OMITTED_MAX = 50;
const PREVIEW_CHARS = 80;

export interface ContextSearchBudget {
  max_tokens: number;
  used_tokens: number;
  /** 上限に入らず丸ごと外した行の数(値の途中では切らない) */
  omitted_count: number;
  omitted: { kind: string; key: string; scope?: string; est_tokens: number }[];
  hint?: string;
}

/**
 * 決まった key の並び(先頭ほど残る)。**持ち場と完了条件(`brief/`)が goal より先**(PBI-0649 AC-6)——
 * 渡された仕事の境界は、目的より先に知っていないと守れない
 */
const PRIORITY_KEYS: readonly string[] = [...WORK_CONTEXT_BRIEF_KEYS, ...WORK_CONTEXT_WELL_KNOWN_KEYS];

/**
 * 並び: work → project、同じ scope の中は 決まった key(定数の順)→ 自由 key → source → auto/ → inbox/。
 * 上限で外れるのは後ろから —— 次の agent が最初に要る物(brief/ → goal / next_step)ほど残る
 */
const priorityOf = (e: ResolvedContextEntry): [number, number, number] => {
  const known = PRIORITY_KEYS.indexOf(e.key);
  const group =
    e.kind === "source" ? 2 : e.key.startsWith("auto/") ? 3 : e.key.startsWith("inbox/") ? 4 : known >= 0 ? 0 : 1;
  return [e.scope === "project" ? 1 : 0, group, group === 0 ? known : 0];
};

const costOf = (e: ResolvedContextEntry): number => estimateTokens(JSON.stringify(e));

/** account へまだ上がっていない値の印(hash 名の空 file)の置き場 */
const contextSyncDir = (env: Env): string => join(openrolyHome(env), "context-sync");

/** value を CAS に書き、server に送る索引を返す(壁は core の buildContextValue) */
export async function prepareContextValue(key: string, value: unknown, env: Env = process.env): Promise<ContextIndexEntryInput> {
  const built = buildContextValue(key, value);
  const fresh = (await stat(join(checkpointsDir(env), built.hash)).catch(() => null)) == null;
  const written = await writeCasPayload(built.payload, env);
  // PBI-0446: この端末で新しく置いた値だけに印を付ける(同じ中身の再 put・別端末から開いた値は上げ直さない)。
  // 上限を超える値は上げない —— 別端末は索引の size で too_large_to_sync と分かる
  if (fresh && written.size <= WORK_CONTEXT_SYNC_MAX_BYTES) {
    await mkdir(contextSyncDir(env), { recursive: true, mode: 0o700 });
    await writeFile(join(contextSyncDir(env), written.hash), "", { mode: 0o600 });
  }
  return { kind: "context", key, value_hash: written.hash, size: written.size };
}

/** account へまだ上がっていない値の数(`openroly doctor` の context sync: N pending) */
export async function countPendingContextValues(env: Env = process.env): Promise<number> {
  return (await readdir(contextSyncDir(env)).catch(() => [] as string[])).filter(isValidCasHash).length;
}

/**
 * 印の付いた値を自分の account 公開鍵へ seal して上げる(PBI-0446・図80d)。put / handoff の直後と 30 秒 tick が呼ぶ。
 * 印を外すのは上がった物と CAS から消えた物だけ —— 通信断・5xx・account 鍵が無い(throw)は印を残して次の tick で再送する。
 * **平文を上げる道は無い**(seal できなければ上げない)
 */
export async function syncPendingContextValues(call: E2eeCall, env: Env = process.env): Promise<{ synced: number; pending: number }> {
  const dir = contextSyncDir(env);
  const hashes = (await readdir(dir).catch(() => [] as string[])).filter(isValidCasHash);
  if (hashes.length === 0) return { synced: 0, pending: 0 };
  const target = await ownAccountPublicKey(call);
  let synced = 0;
  for (const hash of hashes) {
    const payload = await readCasPayload(hash, env);
    if (payload != null) {
      const envelope = await seal(new TextEncoder().encode(JSON.stringify(payload)), [target]);
      const ok = await call(`/v1/context-values/${hash}`, { method: "PUT", body: envelope }).then(
        () => true,
        () => false,
      );
      if (!ok) continue;
      synced += 1;
    }
    await rm(join(dir, hash), { force: true });
  }
  return { synced, pending: await countPendingContextValues(env) };
}

/**
 * 端末に無い値を account から開く(PBI-0446・図80d)。**開けて hash が合った値だけ**を CAS に置く。
 * 鍵が無い時に平文を作る道は無い(no_account_key)
 */
async function openFromAccount(
  row: ContextIndexRow,
  account: ContextAccount | undefined,
  env: Env | undefined,
): Promise<{ payload: ContextValuePayload } | { reason?: ContextSyncReason }> {
  if (row.size > WORK_CONTEXT_SYNC_MAX_BYTES) return { reason: "too_large_to_sync" };
  if (!account) return {};
  let envelope: EncryptedEnvelope;
  try {
    envelope = (await account.call(`/v1/context-values/${row.value_hash}`)) as EncryptedEnvelope;
  } catch {
    return {}; // まだ上がっていない(404)・届かない —— 無い物を無いと言う
  }
  // recipients は server から来た値。壊れた entry は宛先に無かった物として扱う(openIfEnvelope と同じ守り)
  const recipients = (Array.isArray(envelope?.recipients) ? envelope.recipients : []).filter(
    (r): r is EncryptedEnvelope["recipients"][number] => typeof (r as { device_key_id?: unknown } | null)?.device_key_id === "string",
  );
  // 宛先が 1 つも読めない = envelope として壊れている(書き換えられた)。鍵の有無の問題ではない
  if (recipients.length === 0) return { reason: "sealed_hash_mismatch" };
  const key = (await readerKeys(account.deviceKind, account.call)).find((k) => recipients.some((r) => r.device_key_id === k.keyId));
  if (!key) return { reason: "no_account_key" };
  const plaintext = await open({ ...envelope, recipients }, key).catch(() => null);
  const verified = plaintext == null ? null : verifySealedValue(row.value_hash, plaintext);
  if (!verified?.ok || verified.payload.key !== row.key) return { reason: "sealed_hash_mismatch" };
  await writeCasPayload(verified.payload, env);
  return { payload: verified.payload };
}

/**
 * source file を hash する。無ければ null。
 * path の壁は core(validateContextKey)が先に落とすが、**symlink で repo の外を指す物**は字面では
 * 見えないので、実体の path でもう一度 cwd の中に居るかを見る(外なら throw)。
 */
export async function hashSourceFile(cwd: string, path: string): Promise<{ sha256: string; size: number } | null> {
  const decision = validateContextKey("source", path);
  if (!decision.ok) throw new Error(`${decision.reason}: ${path}`);
  const abs = join(cwd, path);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  const rel = relative(await realpath(cwd), real);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    throw new Error(`invalid_source_path: ${path} resolves outside the working directory`);
  }
  try {
    const bytes = await readFile(real);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

const isMissing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
};

/** source を索引 1 行にする(無い file は書けない —— 次の agent が読めない物を「在る」と残さない) */
export async function prepareSource(cwd: string, path: string): Promise<ContextIndexEntryInput> {
  const hashed = await hashSourceFile(cwd, path);
  if (!hashed) throw new Error(`source_not_found: ${path}`);
  return { kind: "source", key: path, value_hash: hashed.sha256, size: hashed.size };
}

/**
 * server の索引を agent に見せる形にする。**無い物を無いと言う**:
 *  - context の value がこの端末の CAS に無い(別端末で書いた・GC 済み)→ PBI-0446: `account` が在れば account から開く
 *    (`fetched_from: "account"`)。開けなければ `value: null, missing_on_device: true` + 分かる時は `reason`
 *  - 索引が別の key の payload を指している → 同じく missing(中身を取り違えて返さない)
 *  - source は手元で再 hash して same / changed / missing
 * `query` は**端末側**で key と value の文字列に部分一致(server は value を持たないので検索できない)。
 * PBI-0438: 優先順に並べ、`maxTokens`(既定 2,000)まで詰める。`indexOnly` は値の代わりに est_tokens と preview。
 */
export async function resolveContextEntries(
  rows: ContextIndexRow[],
  opts: { cwd: string; query?: string; env?: Env; indexOnly?: boolean; maxTokens?: number; account?: ContextAccount },
): Promise<{ entries: ResolvedContextEntry[]; missing_on_device: number; budget: ContextSearchBudget }> {
  // 値を読む前に落とす(上限の無い search を黙って通さない)
  const maxTokens = opts.maxTokens ?? CONTEXT_SEARCH_DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > CONTEXT_SEARCH_MAX_TOKENS) {
    throw new Error(`invalid_max_tokens: ${opts.maxTokens} — an integer from 1 to ${CONTEXT_SEARCH_MAX_TOKENS}`);
  }
  const entries: ResolvedContextEntry[] = [];
  for (const r of rows) {
    const base = {
      kind: r.kind,
      key: r.key,
      version: r.version,
      written_by: { actor: r.actor, runtime_id: r.runtime_id, run_id: r.run_id },
      updated_at: String(r.updated_at),
      ...(r.scope ? { scope: r.scope } : {}),
      ...(r.published_from_work_id ? { published_from: `${r.published_from_work_id}@${r.published_from_version}` } : {}),
      ...(r.read !== undefined ? { read: r.read } : {}),
    };
    if (r.kind === "source") {
      const hashed = await hashSourceFile(opts.cwd, r.key).catch(() => null);
      const status: SourceStatus = hashed == null ? "missing" : hashed.sha256 === r.value_hash ? "same" : "changed";
      entries.push({ ...base, source_status: status });
      continue;
    }
    // value_hash は server から来た値 —— readCasPayload が形を検査してから path を組む(PBI-0414 攻撃②)
    const payload = (await readCasPayload(r.value_hash, opts.env)) as ContextValuePayload | null;
    if (payload != null && payload.key === r.key) {
      entries.push({ ...base, value: payload.value });
      continue;
    }
    const opened = payload == null ? await openFromAccount(r, opts.account, opts.env) : {};
    if ("payload" in opened) {
      entries.push({ ...base, value: opened.payload.value, fetched_from: "account" });
      continue;
    }
    entries.push({ ...base, value: null, missing_on_device: true, ...(opened.reason ? { reason: opened.reason } : {}) });
  }
  const q = opts.query?.toLowerCase();
  const hits = q
    ? entries.filter((e) => e.key.toLowerCase().includes(q) || (e.value != null && JSON.stringify(e.value).toLowerCase().includes(q)))
    : entries;
  const ordered = hits
    .map((e, i) => ({ e, i, p: priorityOf(e) }))
    .sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1] || a.p[2] - b.p[2] || a.i - b.i)
    .map(({ e }) => e);
  // index_only: 値を落とし、「取ったら何 token か」と先頭だけを付ける(2 段目で keys を選ぶ材料)
  const shaped = opts.indexOnly
    ? ordered.map((e) => {
        const { value, ...rest } = e;
        if (e.kind === "source") return { ...rest, est_tokens: costOf(e) };
        const text = value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
        return { ...rest, est_tokens: costOf(e), preview: text == null ? null : text.slice(0, PREVIEW_CHARS) };
      })
    : ordered;
  // 上限まで詰める。入らない行は値の途中で切らず丸ごと外し、名前と est_tokens を receipt に残して次の行を試す
  const kept: ResolvedContextEntry[] = [];
  const omitted: ContextSearchBudget["omitted"] = [];
  let used = 0;
  for (const e of shaped) {
    const cost = costOf(e);
    if (used + cost <= maxTokens) {
      kept.push(e);
      used += cost;
    } else {
      omitted.push({ kind: e.kind, key: e.key, ...(e.scope ? { scope: e.scope } : {}), est_tokens: e.est_tokens ?? cost });
    }
  }
  const budget: ContextSearchBudget = {
    max_tokens: maxTokens,
    used_tokens: used,
    omitted_count: omitted.length,
    omitted: omitted.slice(0, CONTEXT_SEARCH_OMITTED_MAX),
    ...(omitted.length > 0
      ? {
          hint:
            `${omitted.length} entr${omitted.length === 1 ? "y" : "ies"} did not fit max_tokens ${maxTokens} and ${omitted.length === 1 ? "was" : "were"} left out whole (values are never cut). ` +
            `Pull what you need with keys: [...] and a larger max_tokens (up to ${CONTEXT_SEARCH_MAX_TOKENS}), or index_only: true to see sizes first`,
        }
      : {}),
  };
  return { entries: kept, missing_on_device: hits.filter((e) => e.missing_on_device).length, budget };
}
