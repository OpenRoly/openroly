// PBI-0433: Work Project context の端末側。
//
// server は索引(kind / key / value_hash / size)しか持たない(apps/server/migrations/053)。
// ここが持つのは「value を CAS に書く」「source file を hash する」「server の索引を agent に見せる
// entry へ組み直す」の 3 つで、**MCP(packages/mcp)と CLI(apps/cli)が同じ関数を呼ぶ** ——
// 組み直しを 2 箇所に書くと、片方だけが missing_on_device を黙って落とす形に割れる。
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  buildContextValue,
  estimateTokens,
  validateContextKey,
  WORK_CONTEXT_WELL_KNOWN_KEYS,
  type ContextValuePayload,
  type WorkContextKind,
} from "@openroly/core";
import { readCasPayload, writeCasPayload } from "./checkpoint-cas.ts";

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
  /** PBI-0434: work = この work の行 / project = 親の Work Project の行 */
  scope?: string;
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
  /** context: 値。この端末に無ければ null + missing_on_device */
  value?: unknown;
  missing_on_device?: boolean;
  /** source: 手元の file を再 hash した結果 */
  source_status?: SourceStatus;
  /** PBI-0438 index_only: この行を値付きで取ったら何 token か / 値の先頭(端末で読んだ物) */
  est_tokens?: number;
  preview?: string | null;
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
 * 並び: work → project、同じ scope の中は 決まった key(定数の順)→ 自由 key → source → auto/ → inbox/。
 * 上限で外れるのは後ろから —— 次の agent が最初に要る物(goal / next_step)ほど残る
 */
const priorityOf = (e: ResolvedContextEntry): [number, number, number] => {
  const known = (WORK_CONTEXT_WELL_KNOWN_KEYS as readonly string[]).indexOf(e.key);
  const group =
    e.kind === "source" ? 2 : e.key.startsWith("auto/") ? 3 : e.key.startsWith("inbox/") ? 4 : known >= 0 ? 0 : 1;
  return [e.scope === "project" ? 1 : 0, group, group === 0 ? known : 0];
};

const costOf = (e: ResolvedContextEntry): number => estimateTokens(JSON.stringify(e));

/** value を CAS に書き、server に送る索引を返す(壁は core の buildContextValue) */
export async function prepareContextValue(key: string, value: unknown, env: Env = process.env): Promise<ContextIndexEntryInput> {
  const built = buildContextValue(key, value);
  const written = await writeCasPayload(built.payload, env);
  return { kind: "context", key, value_hash: written.hash, size: written.size };
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
 *  - context の value がこの端末の CAS に無い(別端末で書いた・GC 済み)→ `value: null, missing_on_device: true`
 *  - 索引が別の key の payload を指している → 同じく missing(中身を取り違えて返さない)
 *  - source は手元で再 hash して same / changed / missing
 * `query` は**端末側**で key と value の文字列に部分一致(server は value を持たないので検索できない)。
 * PBI-0438: 優先順に並べ、`maxTokens`(既定 2,000)まで詰める。`indexOnly` は値の代わりに est_tokens と preview。
 */
export async function resolveContextEntries(
  rows: ContextIndexRow[],
  opts: { cwd: string; query?: string; env?: Env; indexOnly?: boolean; maxTokens?: number },
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
    };
    if (r.kind === "source") {
      const hashed = await hashSourceFile(opts.cwd, r.key).catch(() => null);
      const status: SourceStatus = hashed == null ? "missing" : hashed.sha256 === r.value_hash ? "same" : "changed";
      entries.push({ ...base, source_status: status });
      continue;
    }
    // value_hash は server から来た値 —— readCasPayload が形を検査してから path を組む(PBI-0414 攻撃②)
    const payload = (await readCasPayload(r.value_hash, opts.env)) as ContextValuePayload | null;
    if (payload == null || payload.key !== r.key) {
      entries.push({ ...base, value: null, missing_on_device: true });
      continue;
    }
    entries.push({ ...base, value: payload.value });
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
