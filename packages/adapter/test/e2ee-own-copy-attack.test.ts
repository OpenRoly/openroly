// PBI-0254 有界レビュー(c4)の攻撃 test。**実装には触らない** —— AC-X1 / AC-X3 / AC-5 を破りに行く。
//  ・AC-X3: 自分の鍵を process に覚えない(別 tab が作り直した後も古い key_id へ封をしない /
//    1 process が複数 account の tools を持つ形で他人の鍵を自分の写しにしない / 温まった grant の
//    cache を seal 先にしない)
//  ・AC-X1: 自分の鍵が 404 の時、手元に grant(= 公開鍵も持っている)が在っても **それへ逃げない**
//  ・AC-5: 「宛先に鍵が無い = 平文」の判定は、自分の鍵・whoami が全部落ちていても変わらない
//  ・0253 と 0254 の失敗文言の優先順(revoke が先に名乗る)を凍結する
// DB も server も使わない —— `call` を差し替えるだけで実物の e2ee.ts を通す。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromEnvelopePlaintext } from "@openroly/core";
import { generateAccountKeyPair, open, wrapPrivateKeyForDevice } from "@openroly/crypto-envelope";
import { getOrCreateDeviceKey } from "../src/devicekeys.ts";
import {
  loadGrantedAccountKey,
  resetGrantedAccountKeyCache,
  sealForHandle,
  type E2eeCall,
} from "../src/e2ee.ts";

let openrolyHomeBefore: string | undefined;
let tmpHome = "";
beforeAll(async () => {
  openrolyHomeBefore = process.env.OPENROLY_HOME;
  tmpHome = await mkdtemp(join(tmpdir(), "openroly-e2ee-own-copy-attack-"));
  process.env.OPENROLY_HOME = tmpHome;
});
afterAll(async () => {
  process.env.OPENROLY_HOME = openrolyHomeBefore;
  await rm(tmpHome, { recursive: true, force: true });
});
beforeEach(() => resetGrantedAccountKeyCache());

const httpError = (status: number, body: unknown = { error: "boom" }) =>
  Object.assign(new Error(`OpenRoly API error ${status}`), { status, body });

type KeyPair = Awaited<ReturnType<typeof generateAccountKeyPair>>;
const pub = (kp: KeyPair) => ({ id: kp.keyId, public_key_jwk: kp.publicJwk });

interface Srv {
  whoami: () => unknown;
  /** `/v1/handles/:h/account-key`。throw で失敗を作る */
  key: (handle: string) => unknown;
  grant?: () => unknown;
  devices?: () => unknown;
  log: string[];
}
const callOf = (s: Srv): E2eeCall => async (path) => {
  s.log.push(path);
  if (path === "/v1/devices") return s.devices ? s.devices() : { ok: true };
  if (path === "/v1/whoami") return s.whoami();
  if (path.startsWith("/v1/me/account-key/grant?")) {
    if (s.grant) return s.grant();
    throw httpError(404, { error: "not_found" });
  }
  const h = path.match(/^\/v1\/handles\/([^/]+)\/account-key$/)?.[1];
  if (h) return s.key(decodeURIComponent(h));
  throw httpError(404, { error: "not_found" });
};

const content = { text: "hello" };
const ids = (sealed: { envelope?: unknown }) =>
  (sealed.envelope as { recipients: { device_key_id: string }[] }).recipients.map((r) => r.device_key_id);
const openWith = async (sealed: { envelope?: unknown }, kp: KeyPair) =>
  fromEnvelopePlaintext(
    JSON.parse(new TextDecoder().decode(await open(sealed.envelope as never, { keyId: kp.keyId, privateJwk: kp.privateJwk }))),
  ).text;

describe("AC-X3 攻撃: 自分の鍵は送信のたびに server から引く(process に覚えない)", () => {
  test("同じ process で鍵が作り直されたら、次の送信は新しい鍵へ封をし、古い鍵へは封をしない", async () => {
    const peer = await generateAccountKeyPair();
    const k1 = await generateAccountKeyPair();
    const k2 = await generateAccountKeyPair();
    let mine = k1;
    const s: Srv = { whoami: () => ({ handle: "me" }), key: (h) => (h === "me" ? pub(mine) : pub(peer)), log: [] };
    const call = callOf(s);

    const first = await sealForHandle(call, "atk-x3-restart", "@aya", content);
    expect(ids(first).sort()).toEqual([k1.keyId, peer.keyId].sort());

    mine = k2; // 別 tab(web)が鍵を作り直した(PBI-0252 AC-4)。process は何も知らされない
    const second = await sealForHandle(call, "atk-x3-restart", "@aya", content);
    expect(ids(second)).toContain(k2.keyId);
    expect(ids(second)).not.toContain(k1.keyId); // 誰も開けない古い鍵へは封をしない
    expect(await openWith(second, k2)).toBe("hello");
    // 引き直しの実測: 2 回の送信で自分の鍵を 2 回引いている(1 回なら覚えている)
    expect(s.log.filter((p) => p === "/v1/handles/me/account-key").length).toBe(2);
  });

  test("1 process に 2 account の tools が居ても、他人の鍵を自分の写しとして入れない", async () => {
    const peer = await generateAccountKeyPair();
    const alice = await generateAccountKeyPair();
    const bob = await generateAccountKeyPair();
    const srvA: Srv = { whoami: () => ({ handle: "alice" }), key: (h) => (h === "alice" ? pub(alice) : pub(peer)), log: [] };
    const srvB: Srv = { whoami: () => ({ handle: "bob" }), key: (h) => (h === "bob" ? pub(bob) : pub(peer)), log: [] };
    // 交互に送る(MCP の test と同じ形: 同じ process・同じ module state)
    const a1 = await sealForHandle(callOf(srvA), "atk-x3-alice", "@aya", content);
    const b1 = await sealForHandle(callOf(srvB), "atk-x3-bob", "@aya", content);
    const a2 = await sealForHandle(callOf(srvA), "atk-x3-alice", "@aya", content);
    for (const a of [a1, a2]) {
      expect(ids(a).sort()).toEqual([alice.keyId, peer.keyId].sort());
      expect(ids(a)).not.toContain(bob.keyId);
    }
    expect(ids(b1).sort()).toEqual([bob.keyId, peer.keyId].sort());
    expect(ids(b1)).not.toContain(alice.keyId);
  });

  test("温まった grant の cache(古い鍵)は seal 先にならない —— 写しは server の今の公開鍵", async () => {
    const kind = "atk-x3-grant";
    const device = await getOrCreateDeviceKey(kind);
    const peer = await generateAccountKeyPair();
    const stale = await generateAccountKeyPair(); // grant として降りている(5 分は覚える)鍵
    const fresh = await generateAccountKeyPair(); // server の今の account 鍵
    const s: Srv = {
      whoami: () => ({ handle: "me" }),
      key: (h) => (h === "me" ? pub(fresh) : pub(peer)),
      grant: async () => ({
        key_id: stale.keyId,
        public_key_jwk: stale.publicJwk,
        wrapped_private_key: await wrapPrivateKeyForDevice(stale.privateJwk, device),
      }),
      log: [],
    };
    const call = callOf(s);
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(stale.keyId); // cache を温める

    const sealed = await sealForHandle(call, kind, "@aya", content);
    expect(ids(sealed)).toContain(fresh.keyId);
    expect(ids(sealed)).not.toContain(stale.keyId);
    expect(await openWith(sealed, fresh)).toBe("hello");
  });
});

describe("AC-X1 攻撃: 自分の鍵が取れない時に、手元の物へ逃げない", () => {
  test("grant(公開鍵も持っている)が手元に在っても、handle の 404 は送信中止(grant へ逃げない)", async () => {
    const kind = "atk-x1-grant";
    const device = await getOrCreateDeviceKey(kind);
    const peer = await generateAccountKeyPair();
    const granted = await generateAccountKeyPair();
    const s: Srv = {
      whoami: () => ({ handle: "me" }),
      key: (h) => {
        if (h === "me") throw httpError(404, { error: "not_found" });
        return pub(peer);
      },
      grant: async () => ({
        key_id: granted.keyId,
        public_key_jwk: granted.publicJwk,
        wrapped_private_key: await wrapPrivateKeyForDevice(granted.privateJwk, device),
      }),
      log: [],
    };
    const call = callOf(s);
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(granted.keyId);
    await expect(sealForHandle(call, kind, "@aya", content)).rejects.toThrow(/has no account key yet/);
  });

  test("whoami が落ちている(503)→ 送信中止。`@` 付きの handle でも自分宛の重複除去は効く", async () => {
    const peer = await generateAccountKeyPair();
    const me = await generateAccountKeyPair();
    const down: Srv = { whoami: () => { throw httpError(503); }, key: (h) => (h === "me" ? pub(me) : pub(peer)), log: [] };
    await expect(sealForHandle(callOf(down), "atk-x1-whoami", "@aya", content)).rejects.toThrow(/503/);
    // 陽性対照: whoami が `@me` の形で返しても、handle 経由の鍵は同じ 1 本に解ける(AC-4)
    const at: Srv = { whoami: () => ({ handle: "@me" }), key: (h) => (h === "me" ? pub(me) : pub(peer)), log: [] };
    expect(ids(await sealForHandle(callOf(at), "atk-x1-at", "@me", content))).toEqual([me.keyId]);
    expect(ids(await sealForHandle(callOf(at), "atk-x1-at", "@aya", content)).sort()).toEqual([me.keyId, peer.keyId].sort());
  });

  test("失敗の名乗りの優先順: revoke された device(PBI-0253)は自分の鍵の有無より先に名乗る", async () => {
    const peer = await generateAccountKeyPair();
    const both: Srv = {
      whoami: () => ({ handle: "me" }),
      key: (h) => {
        if (h === "me") throw httpError(404, { error: "not_found" });
        return pub(peer);
      },
      devices: () => { throw httpError(409, { error: "device_revoked" }); },
      log: [],
    };
    await expect(sealForHandle(callOf(both), "atk-order", "@aya", content)).rejects.toThrow(
      /revoked from the account[\s\S]*openroly pair atk-order/,
    );
    // 自分の鍵の 404 は device が通ってから名乗る(両方の文言が同じ 1 通に混ざらない)
    const onlyKey: Srv = { ...both, devices: undefined, log: [] };
    const said = await sealForHandle(callOf(onlyKey), "atk-order", "@aya", content).then(
      () => "(不当に成功した)",
      (e) => String((e as Error).message),
    );
    expect(said).toMatch(/has no account key yet/);
    expect(said).not.toMatch(/openroly login/);
  });
});

describe("AC-5 攻撃: 「宛先に鍵が無い = 平文」は自分の側が全部落ちていても変わらない", () => {
  test("宛先 404 + whoami 500 + 自分の鍵 500 → 平文のまま。自分の側は 1 度も叩かない", async () => {
    const s: Srv = {
      whoami: () => { throw httpError(500); },
      key: (h) => {
        if (h === "me") throw httpError(500);
        throw httpError(404, { error: "not_found" });
      },
      log: [],
    };
    expect(await sealForHandle(callOf(s), "atk-ac5", "@aya", content)).toEqual(content);
    expect(s.log).toEqual(["/v1/handles/aya/account-key"]);
  });
});
