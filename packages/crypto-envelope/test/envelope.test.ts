import { describe, expect, test } from "bun:test";
import {
  assertWrapAlg,
  decryptFileBytes,
  deriveAuthValue,
  deriveKeyMaterial,
  deriveWrapKey,
  encryptFileBytes,
  generateAccountKeyPair,
  generateDeviceKeyPair,
  KDF_ALG,
  newWrapSalt,
  open,
  seal,
  unwrapPrivateKey,
  wrapPrivateKey,
  WrapOpenError,
  type EncryptedEnvelope,
} from "../src/index.ts";

const text = (s: string) => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array) => new TextDecoder().decode(b);

describe("HPKE versioned envelope (AC-17)", () => {
  test("multi-device roundtrip: 宛先 A/B どちらの device でも開ける", async () => {
    const a = await generateDeviceKeyPair();
    const b = await generateDeviceKeyPair();
    const env = await seal(text("この設計見て"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
      { keyId: b.keyId, publicJwk: b.publicJwk },
    ]);
    expect(env.v).toBe(1);
    expect(env.recipients.length).toBe(2);
    expect(fromBytes(await open(env, a))).toBe("この設計見て");
    expect(fromBytes(await open(env, b))).toBe("この設計見て");
  });

  test("非宛先 device では開けない", async () => {
    const a = await generateDeviceKeyPair();
    const c = await generateDeviceKeyPair();
    const env = await seal(text("secret"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
    ]);
    expect(open(env, c)).rejects.toThrow("not a recipient");
    // key ID を偽装して A の wrapped_key を C の鍵で開こうとしても失敗する
    const forged: EncryptedEnvelope = {
      ...env,
      recipients: [{ ...env.recipients[0]!, device_key_id: c.keyId }],
    };
    expect(open(forged, c)).rejects.toThrow();
  });

  test("ciphertext 改竄で復号失敗", async () => {
    const a = await generateDeviceKeyPair();
    const env = await seal(text("tamper me"), [
      { keyId: a.keyId, publicJwk: a.publicJwk },
    ]);
    const bytes = Buffer.from(env.ciphertext, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...env, ciphertext: bytes.toString("base64url") };
    expect(open(tampered, a)).rejects.toThrow();
  });

  test("未知 version は拒否", async () => {
    const a = await generateDeviceKeyPair();
    const env = await seal(text("v?"), [{ keyId: a.keyId, publicJwk: a.publicJwk }]);
    const future = { ...env, v: 2 as unknown as 1 };
    expect(open(future, a)).rejects.toThrow("unsupported envelope version");
  });

  test("宛先ゼロは seal 不可", () => {
    expect(seal(text("x"), [])).rejects.toThrow("at least one recipient");
  });
});

// PBI-0074 / W13: 添付の 1 回鍵 AEAD(FileRef.key で運ぶ)
test("encryptFileBytes → decryptFileBytes の roundtrip(異なる key では開かない)", async () => {
  const plain = new TextEncoder().encode("添付の中身 attachment body");
  const enc = await encryptFileBytes(plain);
  expect(enc.ciphertext.byteLength).toBeGreaterThan(plain.byteLength); // GCM tag 分
  const restored = await decryptFileBytes(enc.ciphertext, enc.keyB64);
  expect(new TextDecoder().decode(restored)).toBe("添付の中身 attachment body");
  const other = await encryptFileBytes(plain);
  let failed = false;
  try {
    await decryptFileBytes(enc.ciphertext, other.keyB64);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
});

// PBI-0247: 認証に送る値と包みを解く鍵を、同じ秘密から **別の salt / info** で導く。
// ここが 1 つに潰れると「server は password を受け取っても包みを開けられない」が嘘になる(REQ-52)。
// PBI-0251: さらに **包み側にも高価な段**(その包みの乱数 salt を食わせる PBKDF2)を置く ——
// 高価な段が全 account 共通 salt の 1 本だけだと、DB を持ち出した相手は表を service 全体で
// 1 回作れば、以後 1 account 1 推測あたり HKDF + AES-GCM だけ(マイクロ秒)で試せた。
describe("account 鍵の包み — authValue と wrapKey の分離(PBI-0247 AC-X6 / PBI-0251)", () => {
  const secret = "correct-horse-battery-staple-0247";
  // 検査は反復回数を落として速くする(分離しているかは回数に依らない)
  const ITER = 1000;
  const material = () => deriveKeyMaterial(secret, ITER);
  const wrapKey = (salt: string, s = secret) => deriveWrapKey(s, salt, ITER);
  const saltBytes = (salt: string) =>
    Uint8Array.from(
      atob(salt.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (salt.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );

  test("authValue は材料そのものではない(server へ渡る値から PRK が戻らない)", async () => {
    const prk = await material();
    const authValue = await deriveAuthValue(prk);
    const prkB64 = btoa(String.fromCharCode(...prk)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(authValue).not.toBe(prkB64);
    expect(authValue).not.toBe(secret);
    // 決定的である事(同じ秘密なら同じ値 = sign in が通る)も対で見る
    expect(await deriveAuthValue(await material())).toBe(authValue);
  });

  test("authValue を握った相手は包みを開けられない(server の立場を再現する)", async () => {
    const kp = await generateAccountKeyPair();
    const salt = newWrapSalt();
    const wrapped = await wrapPrivateKey(kp.privateJwk, await wrapKey(salt));
    // 陽性対照: 本人(秘密を知っている)は開く
    expect((await unwrapPrivateKey(wrapped, await wrapKey(salt))).d).toBe(kp.privateJwk.d);
    // 陰性対照 ①: server が持っているのは authValue だけ。そこから wrapKey を作り直しても開かない
    const authValue = await deriveAuthValue(await material());
    expect(unwrapPrivateKey(wrapped, await wrapKey(salt, authValue))).rejects.toThrow();
    // 陰性対照 ②(**一番効く手**): authValue の bytes をそのまま AES 鍵として使う ——
    // 2 つの導出を同じ salt / info に潰すと authValue と wrapKey が**同じ bytes**になり、
    // これが開いてしまう(実測: 潰す変異でこの行が赤くなる)
    const padded = authValue.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Uint8Array.from(
      atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );
    const asBytes = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
    expect(unwrapPrivateKey(wrapped, asBytes)).rejects.toThrow();
  });

  // PBI-0251 AC-1: 同じ password の 2 account でも、包みごとの乱数 salt で鍵が分かれる
  test("salt が違えば別の鍵になる(同じ password の 2 account で wrapKey が違う)", async () => {
    const kp = await generateAccountKeyPair();
    const a = newWrapSalt();
    const b = newWrapSalt();
    expect(a).not.toBe(b);
    const wrapped = await wrapPrivateKey(kp.privateJwk, await wrapKey(a));
    expect((await unwrapPrivateKey(wrapped, await wrapKey(a))).d).toBe(kp.privateJwk.d);
    // **同じ秘密**でも salt が違えば開かない
    expect(unwrapPrivateKey(wrapped, await wrapKey(b))).rejects.toThrow();
  });

  /**
   * PBI-0251 AC-X2 の**武装した負の対照**。DB を全部持った相手が現実に取る手は
   * 「よくある password → PRK(固定 salt)」の表を service 全体で 1 回作る事なので、
   * **その表から wrapKey が作れない**ことを測る。
   * v1 に戻す(= `deriveWrapKey` を authValue 側の PRK からの HKDF だけにする)と、
   * ここで組み立てる鍵が本物と一致して**この test が赤くなる**。
   */
  test("service 全体で 1 回作った表(固定 salt の PRK)から包みは開かない — 表が使い回せない", async () => {
    const kp = await generateAccountKeyPair();
    const salt = newWrapSalt();
    const wrapped = await wrapPrivateKey(kp.privateJwk, await wrapKey(salt));
    // 攻撃者の手元: 固定 salt の PRK(表の 1 行)。そこから v1 と同じ HKDF で鍵を作る
    const tablePrk = await deriveKeyMaterial(secret, ITER);
    const hk = await crypto.subtle.importKey("raw", tablePrk as BufferSource, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltBytes(salt) as BufferSource,
        info: new TextEncoder().encode("openroly/account-key/v1/wrap") as BufferSource,
      },
      hk,
      256,
    );
    const v1Key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
    await expect(unwrapPrivateKey(wrapped, v1Key)).rejects.toMatchObject({ reason: "wrong_secret" });
  });

  /**
   * 高価な段が**本当に包み側で走っている**か。反復回数を変えて鍵が変われば PBKDF2 が
   * wrap 経路に在る(HKDF だけなら回数は結果に効かない = 外した瞬間にここが赤くなる)。
   */
  test("包み側の反復回数が鍵に効く(高価な段が wrap 経路に在る)", async () => {
    const kp = await generateAccountKeyPair();
    const salt = newWrapSalt();
    const wrapped = await wrapPrivateKey(kp.privateJwk, await deriveWrapKey(secret, salt, 1000));
    expect((await unwrapPrivateKey(wrapped, await deriveWrapKey(secret, salt, 1000))).d).toBe(kp.privateJwk.d);
    expect(unwrapPrivateKey(wrapped, await deriveWrapKey(secret, salt, 2000))).rejects.toThrow();
  });

  // PBI-0251 AC-2 / AC-X1: 版が上がっている事と、古い版を**名乗って**落とす事
  test("kdf.alg は v2(包み側にも PBKDF2 が在る版)", () => {
    expect(KDF_ALG).toBe("PBKDF2-SHA256/HKDF-SHA256/v2");
  });

  test("v1 の包みは stale_kdf を名乗って落ちる(黙って wrong_secret にしない)", () => {
    expect(() => assertWrapAlg("PBKDF2-SHA256/HKDF-SHA256/v1")).toThrow(WrapOpenError);
    try {
      assertWrapAlg("PBKDF2-SHA256/HKDF-SHA256/v1");
      throw new Error("assertWrapAlg が v1 を素通りさせた");
    } catch (e) {
      expect(e).toBeInstanceOf(WrapOpenError);
      expect((e as WrapOpenError).reason).toBe("stale_kdf");
    }
    // alg が無い包み(v2 より前)も同じ扱い。今の版だけが素通りする
    expect(() => assertWrapAlg(undefined)).toThrow(WrapOpenError);
    expect(() => assertWrapAlg(KDF_ALG)).not.toThrow();
  });

  test("包みごとの salt は 16 byte の乱数(AC-2)", () => {
    const a = newWrapSalt();
    const b = newWrapSalt();
    expect(a).not.toBe(b);
    expect(saltBytes(a).length).toBe(16);
  });

  test("account 鍵の id は ack_ 接頭辞(device 鍵と機械で見分けられる)", async () => {
    const account = await generateAccountKeyPair();
    const device = await generateDeviceKeyPair();
    expect(account.keyId.startsWith("ack_")).toBe(true);
    expect(device.keyId.startsWith("dvk_")).toBe(true);
  });

  test("壊れた包みは wrong_secret と別の理由(malformed)を名乗る", async () => {
    const key = await wrapKey(newWrapSalt());
    await expect(unwrapPrivateKey("###not-base64###", key)).rejects.toMatchObject({ reason: "malformed" });
    await expect(unwrapPrivateKey("c2hvcnQ", key)).rejects.toMatchObject({ reason: "malformed" });
  });
});
