// PBI-0414 / CAP-3 V4.5: Secret Payload の端末側 content-addressed store(CAS)。
//
// server は manifest(payload_hash / size / mode / refs)だけを持つ(apps/server/src/store.ts)。
// 本文(goal / decisions / relevant_memory / git_state 等 8 要素)は payload として**ここにしか
// 無い** —— 置き場は OPENROLY_HOME(credentials.ts の openrolyHome。secrets.json / credentials.json
// と同じ棚・同じ 0600)、書き込みは同じ writeFileAtomic を使う(自作しない)。
//
// hash は core の `hashCapsuleBody`(buildCapsule が返す物と同じ関数)をそのまま使う ——
// 2 箇所で別の hash 関数を持つと、server が dedupe に使っていた比較(client 側へ移した後の
// AC-3)の意味が割れる。
//
// **読み手は hash を信用しない**(PBI-0414 攻撃②・0410 review で同型の path traversal が
// 実物として出ている): server から来た `payload_hash` は他 account の manifest 経由でも
// 届きうる入力なので、file 名に使う前に必ず `isValidCasHash` を通す。
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashCapsuleBody, isValidCasHash, type CapsuleBody } from "@openroly/core";
import { openrolyHome, writeFileAtomic } from "./credentials.ts";

type Env = Record<string, string | undefined>;

export { isValidCasHash };

export function checkpointsDir(env: Env = process.env): string {
  return join(openrolyHome(env), "checkpoints");
}

export interface CasWriteResult {
  hash: string;
  size: number;
}

/**
 * payload を CAS へ書く(immutable — 同じ hash の file が既に在れば何もしない。中身は hash が
 * 保証するので上書きの意味が無い)。**呼ぶ前に `validateCredentialRefs`(core/capsule.ts)を
 * 通しておく事**(ここでは中身を検証しない — 責務を分ける)。
 */
export async function writeCasPayload(body: Record<string, unknown>, env: Env = process.env): Promise<CasWriteResult> {
  const hash = hashCapsuleBody(body);
  const dir = checkpointsDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, hash);
  const text = JSON.stringify(body);
  const size = Buffer.byteLength(text, "utf8");
  // 既に在れば書かない(hash が同じ = 中身も同じ。mtime を更新しない —— GC の「古い順」判定に
  // 「最近また参照された」を混ぜない。参照時刻が要るなら別の仕組みで足す、が v0 はこれで足りる)
  const existing = await stat(path).catch(() => null);
  if (existing) return { hash, size: existing.size };
  await writeFileAtomic(path, text, 0o600);
  return { hash, size };
}

/**
 * payload を読む。`hash` は**信用できない入力として扱う**(呼び出し側が server の manifest から
 * 受け取った値をそのまま渡しうる) —— 形が合わない物は path を組む前に reject する(attack②)。
 * 無ければ `null`(GC で消えた・端末を変えた等。呼び手は「作り直す」で復旧する設計 — AC-8)。
 */
export async function readCasPayload(hash: string, env: Env = process.env): Promise<CapsuleBody | null> {
  if (!isValidCasHash(hash)) {
    throw new Error(`checkpoint-cas: refused to read invalid hash: ${JSON.stringify(hash)}`);
  }
  try {
    const text = await readFile(join(checkpointsDir(env), hash), "utf8");
    return JSON.parse(text) as CapsuleBody;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** AC-8 既定: 512 MiB か 30 日、先に超えた方を基準に古い順で消す */
export const CAS_MAX_BYTES = 512 * 1024 * 1024;
export const CAS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CasGcResult {
  removed: string[];
  removedBytes: number;
  remainingBytes: number;
}

/**
 * 古い順(mtime)に消す。**「参照が生きているか」は見ない**(server に問い合わせない) ——
 * 消しても次の checkpoint tick が同じ内容を同じ hash で作り直すだけ(AC-8 の「参照が生きている
 * payload は消さない」は「消しても実害が無い」の言い換え。cross-account の照会は増やさない)。
 * 期限切れ(age)を全部消してから、まだ size 超過なら古い順にさらに消す。
 */
export async function gcCheckpoints(
  opts: { maxBytes?: number; maxAgeMs?: number; now?: number } = {},
  env: Env = process.env,
): Promise<CasGcResult> {
  const maxBytes = opts.maxBytes ?? CAS_MAX_BYTES;
  const maxAgeMs = opts.maxAgeMs ?? CAS_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const dir = checkpointsDir(env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], removedBytes: 0, remainingBytes: 0 };
    throw e;
  }
  const entries: { name: string; path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!isValidCasHash(name)) continue; // 自分が作った物以外(.tmp 等)は触らない
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (st) entries.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // 古い順

  const removed: string[] = [];
  let removedBytes = 0;
  let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  for (const e of entries) {
    const tooOld = now - e.mtimeMs > maxAgeMs;
    const tooBig = totalBytes > maxBytes;
    if (!tooOld && !tooBig) break; // 古い順に並んでいるので、ここで打ち切ってよい
    await rm(e.path, { force: true });
    removed.push(e.name);
    removedBytes += e.size;
    totalBytes -= e.size;
  }
  return { removed, removedBytes, remainingBytes: totalBytes };
}
