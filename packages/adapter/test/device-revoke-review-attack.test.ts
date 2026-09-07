// PBI-0253 の有界 review(agent 側)。**通すためではなく破るために**書く。
//
// 測るのは 3 つ:
//   ① AC-4 の 5 分 TTL が **読む経路**(openIfEnvelope → readerKeys → loadGrantedAccountKey)まで
//      効いているか。既存の AC-4 test は loadGrantedAccountKey 単体で、開く所まで通していない
//   ② **送る経路は TTL に依らない**事 —— grant cache が温まっていても、revoke された device の
//      送信は POST /v1/devices の 409 で **その場で**止まる(5 分待たない)
//   ③ AC-X1 の error 文言が名乗る「復帰の手順」が **実在する**か。PBI の G2 は「復帰は openroly login の
//      やり直しで、そこが新しい device 鍵を作る」と書いたが、`openroly login` は broker を pair するだけで
//      device 鍵に触らない(apps/cli/src/openroly.ts の login は devicekeys を import すらしない)。
//      revoke された鍵は手元に残り続けるので、案内どおり打っても同じ id で 409 のまま = 永久に詰む。
//      戻る道は **pairing のやり直し(人の承認)の直後に鍵を作り直す** 1 本。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEnvelopePlaintext } from "@openroly/core";
import { generateAccountKeyPair, seal, wrapPrivateKeyForDevice } from "@openroly/crypto-envelope";
import { getOrCreateDeviceKey } from "../src/devicekeys.ts";
import {
  loadGrantedAccountKey,
  openIfEnvelope,
  resetGrantedAccountKeyCache,
  sealForHandle,
  type E2eeCall,
} from "../src/e2ee.ts";
import { pairRuntime } from "../src/pairing.ts";

let openrolyHomeBefore: string | undefined;
let tmpHome = "";

beforeAll(async () => {
  openrolyHomeBefore = process.env.OPENROLY_HOME;
  tmpHome = await mkdtemp(join(tmpdir(), "openroly-rv0253-"));
  process.env.OPENROLY_HOME = tmpHome;
});
afterAll(async () => {
  process.env.OPENROLY_HOME = openrolyHomeBefore;
  await rm(tmpHome, { recursive: true, force: true });
});
beforeEach(() => resetGrantedAccountKeyCache());

const httpError = (status: number, body: unknown) =>
  Object.assign(new Error(`OpenRoly API error ${status}`), { status, body });

const content = { text: "hello" };

/** 宛先 @aya と自分 @me の account 鍵が在り、grant は revoke されるまで降りる fake */
async function fakeAccount(kind: string) {
  const device = await getOrCreateDeviceKey(kind);
  const own = await generateAccountKeyPair();
  const theirs = await generateAccountKeyPair();
  const state = { revoked: false, log: [] as string[] };
  const call: E2eeCall = async (path, init) => {
    state.log.push(`${init?.method ?? (init?.body !== undefined ? "POST" : "GET")} ${path}`);
    if (path === "/v1/devices") {
      if (state.revoked) throw httpError(409, { error: "device_revoked" });
      return { ok: true };
    }
    if (path === "/v1/whoami") return { handle: "me" };
    if (path.startsWith("/v1/me/account-key/grant?")) {
      // revoke は grant の包みを消す(store.revokeDeviceKey)ので 404 になる
      if (state.revoked) throw httpError(404, { error: "not_found" });
      return {
        key_id: own.keyId,
        public_key_jwk: own.publicJwk,
        wrapped_private_key: await wrapPrivateKeyForDevice(own.privateJwk, device),
      };
    }
    if (path === "/v1/handles/me/account-key") return { id: own.keyId, public_key_jwk: own.publicJwk };
    if (path === "/v1/handles/aya/account-key") return { id: theirs.keyId, public_key_jwk: theirs.publicJwk };
    throw httpError(404, { error: "not_found" });
  };
  return { call, state, own, theirs, device };
}

/** owner の account 鍵 1 本へ封をした受信 message(server が保存する形) */
async function sealedTo(key: { keyId: string; publicJwk: JsonWebKey }, text: string) {
  const plaintext = new TextEncoder().encode(JSON.stringify(toEnvelopePlaintext({ text })));
  return { content: { envelope: await seal(plaintext, [key]) } };
}

describe("cache の全経路に TTL が効く(PBI-0253 AC-4)", () => {
  const realNow = Date.now;
  let offsetMs = 0;
  beforeEach(() => {
    offsetMs = 0;
    spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
  });
  afterEach(() => {
    (Date.now as unknown as { mockRestore: () => void }).mockRestore();
  });

  test("読む経路: revoke の 5 分後、openIfEnvelope は undecryptable に落ちる(それまでは読める = 上限)", async () => {
    const kind = "t-rv-read";
    const { call, state, own } = await fakeAccount(kind);
    const message = await sealedTo(own, "secret");

    const before = await openIfEnvelope(kind, message, call);
    expect((before.content as { text?: string }).text).toBe("secret");

    // 人が Revoke を押した。既に起きている process は cache の中に平文の秘密鍵を持っている
    state.revoked = true;
    offsetMs = 4 * 60_000 + 59_000;
    const within = await openIfEnvelope(kind, message, call);
    expect((within.content as { text?: string }).text).toBe("secret"); // PBI が認めた上限の内側

    offsetMs = 5 * 60_000 + 1_000;
    const after = await openIfEnvelope(kind, message, call);
    expect((after.content as { undecryptable?: true }).undecryptable).toBe(true);
    expect((after.content as { text?: string }).text).toBeUndefined();
    // 引き直しは 1 回だけ足された(5 分ごと。message ごとに HTTP を打っていない)
    expect(state.log.filter((l) => l.includes("/v1/me/account-key/grant?")).length).toBe(2);
  });

  test("送る経路は TTL に依らない: grant cache が温まっていても、409 device_revoked でその場で止まる", async () => {
    const kind = "t-rv-send";
    const { call, state, own } = await fakeAccount(kind);
    // 温める(読む経路を 1 回通した直後、という agent の普通の状態)
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(own.keyId);
    // 送れる(陽性対照)
    expect((await sealForHandle(call, kind, "@aya", content)).envelope).toBeDefined();

    state.revoked = true;
    offsetMs = 0; // 時計は進めない —— 5 分待たずに止まる事を測る
    await expect(sealForHandle(call, kind, "@aya", content)).rejects.toThrow(/revoked from the account/);
    // 止まったのは POST /v1/devices の所で、grant の cache を引き直してはいない(引き直しても止まらない)
    expect(state.log.filter((l) => l.includes("/v1/me/account-key/grant?")).length).toBe(1);
  });
});

describe("復帰の手順は実在する(PBI-0253 AC-X1 の裏側)", () => {
  test("error 文言は pairing のやり直しを名乗る(openroly login は device 鍵に触らないので案内にならない)", async () => {
    const kind = "t-rv-msg";
    const { call, state } = await fakeAccount(kind);
    state.revoked = true;
    const message = await sealForHandle(call, kind, "@aya", content).then(
      () => "(不当に成功した)",
      (e) => String((e as Error).message),
    );
    expect(message).toMatch(/revoked from the account/);
    expect(message).toMatch(new RegExp(`openroly pair ${kind}`)); // kind を名指しで(人はどの runtime か知らない)
    expect(message).not.toMatch(/openroly login/);
  });

  /** pair/start・pair/claim(即 approved)・POST /v1/devices を持つ fake Account API */
  function fakeServer(revokedIds: Set<string>, devicesStatus = 201) {
    const devices: { id: string; status: number }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/v1/pair/start") {
          return Response.json(
            {
              device_code: "pdc_rv",
              user_code: "ABCD2345",
              expires_in: 6,
              interval: 1,
              verification_uri: "http://localhost:5173/connect",
            },
            { status: 201 },
          );
        }
        if (path === "/v1/pair/claim") {
          return Response.json({ status: "approved", runtime_id: "rt_rv", token: "par_rv" });
        }
        if (path === "/v1/devices") {
          const body = (await req.json()) as { device_key_id: string };
          const status = revokedIds.has(body.device_key_id) ? 409 : devicesStatus;
          devices.push({ id: body.device_key_id, status });
          if (status === 409) return Response.json({ error: "device_revoked" }, { status: 409 });
          if (status !== 201) return Response.json({ error: "boom" }, { status });
          return Response.json({ id: body.device_key_id }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { server, devices, base: `http://localhost:${server.port}` };
  }

  async function pairWith(base: string, kind: string, env: Record<string, string>) {
    return pairRuntime({
      baseUrl: base,
      kind,
      name: `MacBook / ${kind}`,
      env,
      onPrompt: () => {},
      sleep: async () => {},
      now: Date.now,
    });
  }

  test("pairing をやり直すと、revoke された device 鍵は **人の承認の後で** 作り直され、新しい id で登録される", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-rv0253-pair-")) };
    const old = await getOrCreateDeviceKey("claude", env);
    const { server, devices, base } = fakeServer(new Set([old.keyId]));
    try {
      const outcome = await pairWith(base, "claude", env);
      expect(outcome.status).toBe("paired");
      const fresh = await getOrCreateDeviceKey("claude", env);
      expect(fresh.keyId).not.toBe(old.keyId);
      expect(fresh.privateJwk).not.toEqual(old.privateJwk);
      // 古い id で 1 回名乗って 409 を受け、新しい id で 201(= device_paired 通知が owner に出る)
      expect(devices).toEqual([
        { id: old.keyId, status: 409 },
        { id: fresh.keyId, status: 201 },
      ]);
      // 別の kind の鍵は巻き添えにならない
      const codexBefore = await getOrCreateDeviceKey("codex", env);
      expect(codexBefore.keyId).not.toBe(fresh.keyId);
    } finally {
      server.stop(true);
      await rm(env.OPENROLY_HOME, { recursive: true, force: true });
    }
  });

  test("負の対照: revoke されていない鍵は pairing をやり直しても **同じまま**(L1 の device 宛 envelope を失わない)", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-rv0253-keep-")) };
    const old = await getOrCreateDeviceKey("claude", env);
    const { server, devices, base } = fakeServer(new Set());
    try {
      expect((await pairWith(base, "claude", env)).status).toBe("paired");
      expect((await getOrCreateDeviceKey("claude", env)).keyId).toBe(old.keyId);
      expect(devices).toEqual([{ id: old.keyId, status: 201 }]);
    } finally {
      server.stop(true);
      await rm(env.OPENROLY_HOME, { recursive: true, force: true });
    }
  });

  test("手元に鍵の無い kind(broker の login)は device を名乗らない = 一覧に broker の行を増やさない", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-rv0253-broker-")) };
    const { server, devices, base } = fakeServer(new Set());
    try {
      expect((await pairWith(base, "broker", env)).status).toBe("paired");
      expect(devices).toEqual([]);
    } finally {
      server.stop(true);
      await rm(env.OPENROLY_HOME, { recursive: true, force: true });
    }
  });

  test("鍵の登録に失敗しても pairing は成功のまま・鍵は作り直さない(credential は書けている。次の送信で名乗り直す)", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-rv0253-500-")) };
    const old = await getOrCreateDeviceKey("claude", env);
    const { server, base } = fakeServer(new Set(), 500);
    try {
      expect((await pairWith(base, "claude", env)).status).toBe("paired");
      expect((await getOrCreateDeviceKey("claude", env)).keyId).toBe(old.keyId);
    } finally {
      server.stop(true);
      await rm(env.OPENROLY_HOME, { recursive: true, force: true });
    }
  });
});
