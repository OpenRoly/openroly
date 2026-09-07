import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateDeviceKey } from "../src/devicekeys.ts";
import { saveCredential, type RuntimeCredential } from "../src/credentials.ts";

async function tempEnv() {
  return { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-devkeys-")) };
}

const cred = (id: string): RuntimeCredential => ({
  runtime_id: `rt_${id}`,
  token: `par_${id}`,
  base_url: "http://localhost:8787",
  name: `MacBook / ${id}`,
  paired_at: new Date().toISOString(),
});

describe("device key store", () => {
  test("kind ごとに生成し、2回目は同じ鍵を返す", async () => {
    const env = await tempEnv();
    const first = await getOrCreateDeviceKey("claude", env);
    const second = await getOrCreateDeviceKey("claude", env);
    expect(second.keyId).toBe(first.keyId);
    expect(second.privateJwk).toEqual(first.privateJwk);

    const other = await getOrCreateDeviceKey("codex", env);
    expect(other.keyId).not.toBe(first.keyId);
  });

  test("credentials.json の書き換え(再pairing相当)で device key は消えない(EP-0001 LEARN #5型の事故対策)", async () => {
    const env = await tempEnv();
    const before = await getOrCreateDeviceKey("claude", env);

    // openroly install claude の再実行を模す: credential entry を丸ごと置換
    await saveCredential("claude", cred("claude-2"), env);
    await saveCredential("claude", cred("claude-3"), env);

    const after = await getOrCreateDeviceKey("claude", env);
    expect(after.keyId).toBe(before.keyId);
    expect(after.privateJwk).toEqual(before.privateJwk);
  });

  test("並行呼び出しでも同じ鍵に収束する(lock)", async () => {
    const env = await tempEnv();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateDeviceKey("claude", env)),
    );
    const keyIds = new Set(results.map((r) => r.keyId));
    expect(keyIds.size).toBe(1);
  });
});
