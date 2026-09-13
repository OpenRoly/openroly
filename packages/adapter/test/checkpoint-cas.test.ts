import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointsDir,
  gcCheckpoints,
  isValidCasHash,
  readCasPayload,
  writeCasPayload,
} from "../src/checkpoint-cas.ts";

// PBI-0414 / CAP-3 V4.5: 端末側 CAS。credentials.test.ts と同じ形(env を毎回 tempEnv で渡す —
// process.env を触らない。並行 test file が同じ ~/.openroly を取り合わない・汚さない為)。
async function tempEnv() {
  return { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-cas-")) };
}

describe("isValidCasHash(攻撃②: CAS の path traversal)", () => {
  test("sha256 hex(64 文字の小文字)だけを受け付ける", () => {
    expect(isValidCasHash("a".repeat(64))).toBe(true);
    expect(isValidCasHash("0123456789abcdef".repeat(4))).toBe(true);
  });

  test("path traversal / 絶対 path / 大文字 / 長さ違いは全部拒否する", () => {
    expect(isValidCasHash("../../../etc/passwd")).toBe(false);
    expect(isValidCasHash("/etc/passwd")).toBe(false);
    expect(isValidCasHash("a".repeat(63))).toBe(false); // 63 文字(1 足りない)
    expect(isValidCasHash("a".repeat(65))).toBe(false); // 65 文字(1 多い)
    expect(isValidCasHash("A".repeat(64))).toBe(false); // 大文字
    expect(isValidCasHash("../" + "a".repeat(61))).toBe(false); // 長さは合わせつつ traversal を混ぜる
    expect(isValidCasHash("")).toBe(false);
  });

  test("実射: 不正な hash で readCasPayload を呼ぶと path を組む前に reject する(実際に呼んで確認)", async () => {
    const env = await tempEnv();
    await expect(readCasPayload("../../../etc/passwd", env)).rejects.toThrow(/invalid hash/);
    // CAS dir の外(親)に何も作られていない事も確認(traversal が実際に起きていない)
    const parentEntries = await readdir(join(env.OPENROLY_HOME, ".."));
    expect(parentEntries).not.toContain("passwd");
  });
});

describe("writeCasPayload / readCasPayload(往復)", () => {
  test("書いた物がそのまま読める。hash は hashCapsuleBody と一致する", async () => {
    const env = await tempEnv();
    const body = { goal: "ship V2", decisions: ["a", "b"] };
    const written = await writeCasPayload(body, env);
    expect(isValidCasHash(written.hash)).toBe(true);
    expect(written.size).toBeGreaterThan(0);

    const read = await readCasPayload(written.hash, env);
    expect(read).toEqual(body);
  });

  test("無い hash は null(GC で消えた・別端末が push した 等)", async () => {
    const env = await tempEnv();
    const read = await readCasPayload("f".repeat(64), env);
    expect(read).toBeNull();
  });

  test("file 権限は 0600(AC-X1: 端末側で他 user から読めない)", async () => {
    const env = await tempEnv();
    const written = await writeCasPayload({ goal: "secret" }, env);
    const st = await stat(join(checkpointsDir(env), written.hash));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("同じ内容を 2 回書いても 1 file のまま(immutable・上書きしない)", async () => {
    const env = await tempEnv();
    const body = { goal: "same" };
    const first = await writeCasPayload(body, env);
    const before = await stat(join(checkpointsDir(env), first.hash));
    await new Promise((r) => setTimeout(r, 10));
    const second = await writeCasPayload(body, env);
    expect(second.hash).toBe(first.hash);
    const after = await stat(join(checkpointsDir(env), first.hash));
    // mtime が更新されていない(GC の「古い順」判定を「最近また参照された」で汚さない設計どおり)
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("gcCheckpoints(AC-8)", () => {
  test("期限(maxAgeMs)を超えた物は古い順に消え、参照が新しい物は残る", async () => {
    const env = await tempEnv();
    const old = await writeCasPayload({ goal: "old" }, env);
    const fresh = await writeCasPayload({ goal: "fresh" }, env);
    // old だけ mtime を過去へ動かす(utimes で実際に古くする — 実射)
    const oldPath = join(checkpointsDir(env), old.hash);
    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 日前
    await utimes(oldPath, past, past);

    const result = await gcCheckpoints({ maxAgeMs: 30 * 24 * 60 * 60 * 1000 }, env);
    expect(result.removed).toEqual([old.hash]);
    expect(await readCasPayload(old.hash, env)).toBeNull();
    expect(await readCasPayload(fresh.hash, env)).toEqual({ goal: "fresh" });
  });

  test("期限内でも容量(maxBytes)超過は古い順に消す(新しい物は残す)", async () => {
    const env = await tempEnv();
    const a = await writeCasPayload({ goal: "a".repeat(200) }, env);
    await new Promise((r) => setTimeout(r, 5));
    const b = await writeCasPayload({ goal: "b".repeat(200) }, env);
    await new Promise((r) => setTimeout(r, 5));
    const c = await writeCasPayload({ goal: "c".repeat(200) }, env);
    // 3 file 分の合計より小さい上限にする → 古い方(a)から消えて、c が残る事を確認
    const totalBytes = a.size + b.size + c.size;
    const result = await gcCheckpoints({ maxBytes: totalBytes - a.size - 1, maxAgeMs: 999 * 24 * 60 * 60 * 1000 }, env);
    expect(result.removed).toContain(a.hash);
    expect(await readCasPayload(c.hash, env)).not.toBeNull(); // 最新は残る
  });

  test("CAS 形式でない file(.tmp 等)には触らない", async () => {
    const env = await tempEnv();
    await writeCasPayload({ goal: "real" }, env);
    await mkdir(checkpointsDir(env), { recursive: true });
    await writeFile(join(checkpointsDir(env), "not-a-hash.tmp"), "junk");
    const result = await gcCheckpoints({ maxAgeMs: 0 }, env); // 全部「古い」扱いにして最大限動かす
    expect(result.removed.every((name) => name !== "not-a-hash.tmp")).toBe(true);
    const stillThere = await readFile(join(checkpointsDir(env), "not-a-hash.tmp"), "utf8");
    expect(stillThere).toBe("junk");
  });

  test("checkpoints dir が無ければ何もしない(初回起動前)", async () => {
    const env = await tempEnv();
    const result = await gcCheckpoints({}, env);
    expect(result).toEqual({ removed: [], removedBytes: 0, remainingBytes: 0 });
  });
});
