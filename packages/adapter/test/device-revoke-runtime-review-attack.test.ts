// PBI-0264 有界レビュー(p0-c2・2026-09-05)の adapter 側:
//   攻撃2 の戻り道: server が「別の生きた runtime が名乗っている id」を 409 device_key_id_taken で断る様になったので、
//         断られた側は pairing の承認直後(reconnectOwnDevice)にだけ鍵を作り直す。承認の外(ensureOwnDevice)では
//         作り直さず、理由と戻り道を名乗って落ちる(0253 の revoked と同じ形・理由の文言は混ぜない)
//   攻撃6 の戻り道: 401 の error 文字列そのものに `openroly pair <kind>` が在る(e2eeCallFor / credentialRejectedHint)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateDeviceKey } from "../src/devicekeys.ts";
import {
  credentialRejectedHint,
  e2eeCallFor,
  ensureOwnDevice,
  reconnectOwnDevice,
  type E2eeCall,
} from "../src/e2ee.ts";

const httpError = (status: number, body: unknown) =>
  Object.assign(new Error(`OpenRoly API error ${status}`), { status, body });

/** POST /v1/devices だけを持つ server: `rejected` に載っている id は 409 `reason`、それ以外は 201 */
function deviceServer(rejected: Map<string, string>, log: string[]): E2eeCall {
  return async (path, init) => {
    if (path !== "/v1/devices") throw httpError(404, { error: "not_found" });
    const id = (init?.body as { device_key_id: string }).device_key_id;
    log.push(id);
    const reason = rejected.get(id);
    if (reason) throw httpError(409, { error: reason });
    return { id };
  };
}

let home = "";
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-0264-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
const env = () => ({ OPENROLY_HOME: home });

describe("1 鍵 ↔ 1 runtime: 409 device_key_id_taken の戻り道(PBI-0264 有界レビュー 攻撃2)", () => {
  test("pairing の承認直後(reconnectOwnDevice)は taken でも鍵を作り直して新しい id で名乗る", async () => {
    const before = await getOrCreateDeviceKey("t-taken", env());
    const log: string[] = [];
    const result = await reconnectOwnDevice(
      deviceServer(new Map([[before.keyId, "device_key_id_taken"]]), log),
      "t-taken",
      env(),
    );
    expect(result).toBe("rotated");
    const after = await getOrCreateDeviceKey("t-taken", env());
    expect(after.keyId).not.toBe(before.keyId);
    expect(log).toEqual([before.keyId, after.keyId]);
  });

  test("承認の外(ensureOwnDevice)は作り直さず、理由と戻り道(openroly pair <kind>)を名乗って落ちる", async () => {
    const record = await getOrCreateDeviceKey("t-taken2", env());
    const log: string[] = [];
    await expect(
      ensureOwnDevice(deviceServer(new Map([[record.keyId, "device_key_id_taken"]]), log), "t-taken2", env()),
    ).rejects.toThrow(/held by another connection[\s\S]*openroly pair t-taken2/);
    // 鍵は変わっていない(agent が自分の判断で作り直していない)・理由は revoke の文言と混ざらない
    expect((await getOrCreateDeviceKey("t-taken2", env())).keyId).toBe(record.keyId);
    expect(log).toEqual([record.keyId]);
    await expect(
      ensureOwnDevice(deviceServer(new Map([[record.keyId, "device_key_id_taken"]]), []), "t-taken2", env()),
    ).rejects.not.toThrow(/revoked from the account/);
  });

  test("409 でも理由が revoked / taken 以外なら reconnect は作り直さない(未知の 409 を rotate の口にしない)", async () => {
    const record = await getOrCreateDeviceKey("t-other", env());
    await expect(
      reconnectOwnDevice(deviceServer(new Map([[record.keyId, "something_else"]]), []), "t-other", env()),
    ).rejects.toThrow(/409/);
    expect((await getOrCreateDeviceKey("t-other", env())).keyId).toBe(record.keyId);
  });
});

describe("401 の文言は戻り道を名乗る(攻撃6・e2eeCallFor / credentialRejectedHint)", () => {
  test("e2eeCallFor(…, kind) の 401 は message に openroly pair <kind> を持ち、status / body は契約どおり残る", async () => {
    const stub = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    try {
      const call = e2eeCallFor(`http://localhost:${stub.port}`, "par_dead", "claude");
      const err = await call("/v1/whoami").then(
        () => null,
        (e) => e as Error & { status?: number; body?: unknown },
      );
      expect(err?.status).toBe(401);
      expect(err?.body).toEqual({ error: "unauthorized" });
      expect(err?.message).toMatch(/401[\s\S]*openroly pair claude/);
    } finally {
      stub.stop(true);
    }
  });

  test("kind が無い / default なら具体名を捏造しない(<kind> のまま)", () => {
    expect(credentialRejectedHint()).toContain("openroly pair <kind>");
    expect(credentialRejectedHint("default")).toContain("openroly pair <kind>");
    expect(credentialRejectedHint("codex")).toContain("openroly pair codex");
  });
});
