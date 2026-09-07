// PBI-0259(ultrareview 区間 1 の指摘 1 / 4): agent 側の seal 経路。
//  ・平文 fallback は **404 の 1 経路だけ**(500 / 通信断 / 壊れた応答は送信を失敗させる。平文で残さない)
//  ・grant の「無い」は 30 秒だけ覚える(起動後に人が grant を出せば、再起動無しで読める)
// PBI-0253: revoke を本当に効かせる面も同じ経路に居る。
//  ・grant の「有る」は 5 分で捨てる(既に起きている agent が revoke 後も鍵を握り続けない)
//  ・POST /v1/devices の 409 device_revoked は復帰の手順を名乗って落ちる(無人の agent が黙って止まらない)
// PBI-0254: **自分の写しは grant を待たない**。grant される前が agent の既定状態なので、
//  grant に掛けると初期の送信が全部「送った本人だけが永久に読めない 1 通」になる。
// DB も server も使わない —— `call` を差し替えるだけで実物の e2ee.ts を通す。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromEnvelopePlaintext } from "@openroly/core";
import { generateAccountKeyPair, open, wrapPrivateKeyForDevice } from "@openroly/crypto-envelope";
import { getOrCreateDeviceKey } from "../src/devicekeys.ts";
import {
  loadGrantedAccountKey,
  resetGrantedAccountKeyCache,
  resolveSealTargets,
  sealForHandle,
  type E2eeCall,
} from "../src/e2ee.ts";

let openrolyHomeBefore: string | undefined;
let tmpHome = "";

beforeAll(async () => {
  openrolyHomeBefore = process.env.OPENROLY_HOME;
  tmpHome = await mkdtemp(join(tmpdir(), "openroly-e2ee-targets-"));
  process.env.OPENROLY_HOME = tmpHome;
});
afterAll(async () => {
  process.env.OPENROLY_HOME = openrolyHomeBefore;
  await rm(tmpHome, { recursive: true, force: true });
});
beforeEach(() => resetGrantedAccountKeyCache());

/** MCP の OpenRolyApiError / openroly agent の call と同じ形: 非 2xx は `status` を持つ error */
const httpError = (status: number, body: unknown = { error: "boom" }) =>
  Object.assign(new Error(`OpenRoly API error ${status}`), { status, body });

interface Fake {
  /** `/v1/handles/:h/account-key` の応答(handle ごと。throw で失敗を作る) */
  accountKey: (handle: string) => unknown;
  /** 自分の grant。undefined なら 404(まだ承認されていない) */
  grant?: () => unknown;
  /** `/v1/whoami`。既定は handle "me"(= 送信者自身の handle) */
  whoami?: () => unknown;
  log: string[];
}

const fakeCall = (fake: Fake): E2eeCall => async (path, init) => {
  fake.log.push(`${init?.method ?? (init?.body !== undefined ? "POST" : "GET")} ${path}`);
  if (path === "/v1/devices") return { ok: true };
  if (path === "/v1/whoami") return fake.whoami ? fake.whoami() : { handle: "me" };
  if (path.startsWith("/v1/me/account-key/grant?")) {
    if (fake.grant) return fake.grant();
    throw httpError(404, { error: "not_found" });
  }
  const handle = path.match(/^\/v1\/handles\/([^/]+)\/account-key$/)?.[1];
  if (handle) return fake.accountKey(decodeURIComponent(handle));
  throw httpError(404, { error: "not_found" });
};

const content = { text: "hello", urls: ["https://example.com/a"] };

describe("revoke された device は自力で戻れない(PBI-0253 AC-X1)", () => {
  /** POST /v1/devices だけ 409 を返す server(server 側 store.upsertDeviceKey の応答と同じ形) */
  const revokedCall = (log: string[], error: string): E2eeCall => async (path, init) => {
    log.push(path);
    if (path === "/v1/devices") throw httpError(409, { error });
    if (/^\/v1\/handles\/[^/]+\/account-key$/.test(path)) return { id: "ack_them", public_key_jwk: {} };
    throw httpError(404, { error: "not_found" });
  };

  test("409 device_revoked → 黙って止まらず、復帰の手順を名乗って落ちる", async () => {
    const log: string[] = [];
    // 平文へは落ちない(sealForHandle は throw する = 送信が平文で残らない)
    await expect(sealForHandle(revokedCall(log, "device_revoked"), "t-revoked", "@aya", content))
      .rejects.toThrow(/revoked from the account[\s\S]*openroly pair t-revoked/);
    expect(log).toContain("/v1/devices");
  });

  test("同じ 409 でも device_key_id_taken は別物(revoke の理由に混ぜない・戻り道は同じ pair のやり直し)", async () => {
    // 負の対照: 理由が違う(「人が Revoke を押した」ではなく「別の生きた runtime / account が先に名乗っている」)
    // ので revoke の文言を出したら嘘になる。戻り道は同じ `openroly pair <kind>`(承認直後に reconnectOwnDevice が
    // 作り直す・PBI-0264 有界レビュー)。0253 review が書いた「account 単位で鍵を作り直す」道は存在しなかった
    // (device-keys.json は kind だけで引く)
    const message = await sealForHandle(revokedCall([], "device_key_id_taken"), "t-taken", "@aya", content)
      .then(() => "(不当に成功した)", (e) => String((e as Error).message));
    expect(message).toMatch(/held by another connection/);
    expect(message).not.toMatch(/revoked from the account/);
    expect(message).toMatch(/openroly pair t-taken/);
  });
});
/**
 * 送信者(@me)には account 鍵が在る、という既定。PBI-0254 以降 seal 経路は必ず自分の鍵を引くので、
 * 「宛先の応答」だけを書く test でもここが埋まっていないと送信が止まる(= AC-X1 の正しい挙動)。
 */
async function withOwnKey(
  theirsFor: (handle: string) => unknown,
): Promise<{ fake: Fake; own: Awaited<ReturnType<typeof generateAccountKeyPair>> }> {
  const own = await generateAccountKeyPair();
  const fake: Fake = {
    accountKey: (h) => (h === "me" ? { id: own.keyId, public_key_jwk: own.publicJwk } : theirsFor(h)),
    log: [],
  };
  return { fake, own };
}

describe("平文 fallback は 404 の 1 経路だけ(PBI-0259 AC-1 / AC-X1 / AC-X2・PBI-0023 F4)", () => {
  test("404(宛先がまだ account 鍵を持たない)→ 平文のまま返す", async () => {
    const fake: Fake = { accountKey: () => { throw httpError(404, { error: "not_found" }); }, log: [] };
    expect(await resolveSealTargets(fakeCall(fake), "t-404", "@aya")).toBeNull();
    expect(await sealForHandle(fakeCall(fake), "t-404", "@aya", content)).toEqual(content);
  });

  test("500 → 送信は失敗する(平文で返さない)", async () => {
    const fake: Fake = { accountKey: () => { throw httpError(500); }, log: [] };
    await expect(resolveSealTargets(fakeCall(fake), "t-500", "@aya")).rejects.toThrow();
    await expect(sealForHandle(fakeCall(fake), "t-500", "@aya", content)).rejects.toThrow();
  });

  test("通信断(status を持たない error)→ 送信は失敗する", async () => {
    const fake: Fake = { accountKey: () => { throw new TypeError("fetch failed"); }, log: [] };
    await expect(sealForHandle(fakeCall(fake), "t-net", "@aya", content)).rejects.toThrow("fetch failed");
  });

  test("200 でも id / public_key_jwk の無い応答 → 送信は失敗する(壊れた鍵へ封をしない・平文にもしない)", async () => {
    const empty: Fake = { accountKey: () => ({}), log: [] };
    await expect(sealForHandle(fakeCall(empty), "t-shape", "@aya", content)).rejects.toThrow(/public_key_jwk/);
    const half: Fake = { accountKey: () => ({ id: "ack_x" }), log: [] };
    await expect(sealForHandle(fakeCall(half), "t-shape", "@aya", content)).rejects.toThrow(/public_key_jwk/);
  });

  test("陽性対照: 200 で正しい鍵 → envelope になり、宛先の account 鍵で開く", async () => {
    const theirs = await generateAccountKeyPair();
    const { fake, own } = await withOwnKey(() => ({ id: theirs.keyId, public_key_jwk: theirs.publicJwk }));
    const sealed = await sealForHandle(fakeCall(fake), "t-ok", "@aya", content);
    expect(sealed.text).toBeUndefined();
    expect(sealed.envelope).toBeDefined();
    const recipients = (sealed.envelope as { recipients: { device_key_id: string }[] }).recipients;
    // 宛先と送信者、**この 2 本ちょうど**(PBI-0254 で写しが常に入る様になった。緩めて `toContain`
    // にすると「3 本目が紛れ込んだ」を見逃す)
    expect(recipients.map((r) => r.device_key_id).sort()).toEqual([own.keyId, theirs.keyId].sort());
    const plain = await open(sealed.envelope as never, { keyId: theirs.keyId, privateJwk: theirs.privateJwk });
    expect(fromEnvelopePlaintext(JSON.parse(new TextDecoder().decode(plain))).text).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// PBI-0254: **自分が送った物を自分で読めない 1 通を作らせない**。
// 壊れていた形: `resolveSealTargets` が自分の写しを `loadGrantedAccountKey`(= 人が承認した
// **秘密**鍵)に掛けていた。写しを入れるのに要るのは公開鍵だけで、公開鍵は handle から誰でも
// 引ける。**grant される前が agent の既定状態**なので、`openroly send` / MCP の send・reply の
// 初期の送信が全部「後で承認されても永久に開かない 1 通」になっていた。
// ---------------------------------------------------------------------------
describe("自分の写しは grant を待たない(PBI-0254 AC-2 / AC-4 / AC-X1)", () => {
  test("AC-2: grant が 1 本も降りていない agent の送信にも、送信者の account 鍵が入る", async () => {
    const theirs = await generateAccountKeyPair();
    const { fake, own } = await withOwnKey(() => ({ id: theirs.keyId, public_key_jwk: theirs.publicJwk }));
    expect(fake.grant).toBeUndefined(); // まだ人が承認していない = agent の既定状態

    const sealed = await sealForHandle(fakeCall(fake), "t-nogrant", "@aya", content);
    const recipients = (sealed.envelope as { recipients: { device_key_id: string }[] }).recipients;
    expect(recipients.map((r) => r.device_key_id).sort()).toEqual([own.keyId, theirs.keyId].sort());

    // AC-X2 の client 側: owner の account 鍵で **実際に開ける**(id が並んでいるだけでは足りない)
    const plain = await open(sealed.envelope as never, { keyId: own.keyId, privateJwk: own.privateJwk });
    expect(fromEnvelopePlaintext(JSON.parse(new TextDecoder().decode(plain))).text).toBe("hello");
    // grant の口は seal 経路から消えている(承認の有無と写しは無関係になった)
    expect(fake.log.filter((l) => l.includes("/v1/me/account-key/grant?"))).toEqual([]);
  });

  test("AC-4: 自分の handle 宛は recipient 1 本のまま(同じ鍵が 2 本並ばない)", async () => {
    const { fake, own } = await withOwnKey(() => ({ id: "ack_never_used", public_key_jwk: {} }));
    const sealed = await sealForHandle(fakeCall(fake), "t-self", "@me", content);
    const recipients = (sealed.envelope as { recipients: { device_key_id: string }[] }).recipients;
    expect(recipients.map((r) => r.device_key_id)).toEqual([own.keyId]);
  });

  test("AC-X1: 自分の鍵が 404 / 500 → 送信を止める(平文で残さない)", async () => {
    const theirs = await generateAccountKeyPair();
    const peer = () => ({ id: theirs.keyId, public_key_jwk: theirs.publicJwk });
    const missing: Fake = {
      accountKey: (h) => {
        if (h === "me") throw httpError(404, { error: "not_found" });
        return peer();
      },
      log: [],
    };
    await expect(sealForHandle(fakeCall(missing), "t-mine-404", "@aya", content)).rejects.toThrow(
      /has no account key yet/,
    );
    const broken: Fake = {
      accountKey: (h) => {
        if (h === "me") throw httpError(500);
        return peer();
      },
      log: [],
    };
    await expect(sealForHandle(fakeCall(broken), "t-mine-500", "@aya", content)).rejects.toThrow();
    // 200 でも shape が壊れていれば止める(`device_key_id: undefined` へ封をしない)
    const shape: Fake = { accountKey: (h) => (h === "me" ? {} : peer()), log: [] };
    await expect(sealForHandle(fakeCall(shape), "t-mine-shape", "@aya", content)).rejects.toThrow(
      /public_key_jwk/,
    );
    // whoami が handle を返さない時も止める(名無しの handle で引きに行かない)
    const nameless: Fake = { accountKey: peer, whoami: () => ({}), log: [] };
    await expect(sealForHandle(fakeCall(nameless), "t-mine-noname", "@aya", content)).rejects.toThrow(
      /no handle/,
    );
  });

  test("AC-5 は維持: 宛先に鍵が無ければ、自分の鍵を引く前に平文へ抜ける", async () => {
    const { fake } = await withOwnKey(() => {
      throw httpError(404, { error: "not_found" });
    });
    expect(await sealForHandle(fakeCall(fake), "t-peer-404", "@aya", content)).toEqual(content);
    // 「宛先が居ない」の判定に自分の鍵は要らない(順序が逆だと平文経路が自分の鍵に依存する)
    expect(fake.log.filter((l) => l.includes("/whoami"))).toEqual([]);
  });
});

describe("grant の cache: 「無い」は 30 秒・「有る」は 5 分(PBI-0259 AC-2 / PBI-0253 AC-4)", () => {
  const realNow = Date.now;
  let offsetMs = 0;
  beforeEach(() => {
    offsetMs = 0;
    // 時計は動かし続ける(固定すると devicekeys の lock 判定が狂う)。進める量だけ足す
    spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
  });
  afterEach(() => {
    (Date.now as unknown as { mockRestore: () => void }).mockRestore();
  });

  const grantHits = (fake: Fake) => fake.log.filter((l) => l.includes("/v1/me/account-key/grant?")).length;

  test("起動後に人が grant を出せば、再起動無しで 30 秒後には読める。30 秒未満は HTTP を足さない", async () => {
    const kind = "t-cache";
    const device = await getOrCreateDeviceKey(kind);
    const fake: Fake = { accountKey: () => ({}), log: [] };
    const call = fakeCall(fake);

    // まだ承認されていない
    expect(await loadGrantedAccountKey(call, kind)).toBeNull();
    expect(grantHits(fake)).toBe(1);
    // 負の対照: 30 秒未満は覚えている(message ごとに HTTP を足さない)
    offsetMs = 29_000;
    expect(await loadGrantedAccountKey(call, kind)).toBeNull();
    expect(grantHits(fake)).toBe(1);

    // 人が web で grant を押した(account 秘密鍵をこの device の公開鍵へ包み直した 1 本)
    const kp = await generateAccountKeyPair();
    fake.grant = async () => ({
      key_id: kp.keyId,
      public_key_jwk: kp.publicJwk,
      wrapped_private_key: await wrapPrivateKeyForDevice(kp.privateJwk, device),
    });

    offsetMs = 31_000;
    const got = await loadGrantedAccountKey(call, kind);
    expect(got?.keyId).toBe(kp.keyId);
    expect(got?.privateJwk).toEqual(kp.privateJwk);
    expect(grantHits(fake)).toBe(2);

    // 有る鍵も 5 分までは引き直さない(message ごとに HTTP を足さない)
    offsetMs = 31_000 + 4 * 60_000;
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(kp.keyId);
    expect(grantHits(fake)).toBe(2);
  });

  // PBI-0253 AC-4: 人が Revoke を押した時、既に起きている agent がいつ鍵を失うか。
  // 前は「有る鍵は process の間ずっと」だったので、再起動するまで revoke が一度も効かなかった
  test("AC-4: 有る鍵も 5 分で捨てる。revoke 後は次の引き直しで鍵を失う", async () => {
    const kind = "t-revoke-ttl";
    const device = await getOrCreateDeviceKey(kind);
    const kp = await generateAccountKeyPair();
    let revoked = false;
    const fake: Fake = { accountKey: () => ({}), log: [] };
    fake.grant = async () => {
      // revoke は grant の包みを消す(store.revokeDeviceKey)ので、引き直すと 404 になる
      if (revoked) throw httpError(404, { error: "not_found" });
      return {
        key_id: kp.keyId,
        public_key_jwk: kp.publicJwk,
        wrapped_private_key: await wrapPrivateKeyForDevice(kp.privateJwk, device),
      };
    };
    const call = fakeCall(fake);
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(kp.keyId);
    expect(grantHits(fake)).toBe(1);

    // 人が web で Revoke を押した。**この時点では process はまだ鍵を握っている**(cache の中)
    revoked = true;
    offsetMs = 4 * 60_000 + 59_000;
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(kp.keyId);
    expect(grantHits(fake)).toBe(1);

    // 5 分を越えたら引き直す → 404 → 鍵を失う(以後は本文を作れない)
    offsetMs = 5 * 60_000 + 1_000;
    expect(await loadGrantedAccountKey(call, kind)).toBeNull();
    expect(grantHits(fake)).toBe(2);
    // 失った後も「無い」は 30 秒だけ覚える(復帰したら読み直せる)
    offsetMs += 31_000;
    revoked = false;
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(kp.keyId);
    expect(grantHits(fake)).toBe(3);
  });

  test("通信断も『無い』と同じ 30 秒。平文にも本文にもならず、後で引き直す", async () => {
    const kind = "t-cache-net";
    await getOrCreateDeviceKey(kind);
    let down = true;
    const fake: Fake = {
      accountKey: () => ({}),
      grant: () => { if (down) throw new TypeError("fetch failed"); return undefined as never; },
      log: [],
    };
    const call = fakeCall(fake);
    expect(await loadGrantedAccountKey(call, kind)).toBeNull();
    expect(grantHits(fake)).toBe(1);
    down = false;
    const kp = await generateAccountKeyPair();
    const device = await getOrCreateDeviceKey(kind);
    fake.grant = async () => ({
      key_id: kp.keyId,
      public_key_jwk: kp.publicJwk,
      wrapped_private_key: await wrapPrivateKeyForDevice(kp.privateJwk, device),
    });
    offsetMs = 31_000;
    expect((await loadGrantedAccountKey(call, kind))?.keyId).toBe(kp.keyId);
    expect(grantHits(fake)).toBe(2);
  });
});
