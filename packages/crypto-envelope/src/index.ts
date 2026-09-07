// Native OpenRoly E2EE の versioned envelope(アーキ §9-11)。
// 平文を random content key で 1 回だけ AEAD 暗号化し、content key を
// 宛先 device ごとに HPKE で wrap する。独自暗号は作らない:
// HPKE = RFC 9180(@hpke/core)、content AEAD = WebCrypto AES-GCM。
// private key は device の外に出さない(Cloud には public key のみ — アーキ §10)。

import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

export const SUITE_ID = "hpke-p256-sha256-a128gcm" as const;
export const ENVELOPE_VERSION = 1 as const;

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

export interface EnvelopeRecipient {
  /**
   * 開ける鍵の id。**v1 の wire 名は `device_key_id` のまま**(本番に v1 envelope が既に在る)だが、
   * 中身は `dvk_`(device 鍵・L1)か `ack_`(account 鍵・L2。PBI-0247)のどちらかである
   */
  device_key_id: string;
  /** HPKE encapsulated key (base64url) */
  enc: string;
  /** HPKE で wrap された content key (base64url) */
  wrapped_key: string;
}

export interface EncryptedEnvelope {
  v: typeof ENVELOPE_VERSION;
  suite: typeof SUITE_ID;
  recipients: EnvelopeRecipient[];
  /** content AEAD の IV (base64url) */
  iv: string;
  /** AES-GCM ciphertext (base64url) */
  ciphertext: string;
}

/** 鍵 1 対の形。device 鍵(`dvk_`)と account 鍵(`ack_`)で共通 */
export interface KeyPair {
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

// Buffer(Node 専用)に依存しない実装。Bun / browser(apps/web の Vite bundle) 両方の
// atob/btoa + Uint8Array だけで完結させる(この package は 3 環境から呼ばれる)。
const b64u = {
  encode: (buf: ArrayBuffer | Uint8Array): string => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode: (s: string): Uint8Array => {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = atob(withPad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },
};

/**
 * public key JWK から決定的に key ID を導出(sha256 の先頭 16 byte)。
 * 接頭辞が鍵の種別を名乗る: `dvk_` = device 鍵(L1 collector / agent)、`ack_` = account 鍵
 * (L2 の seal 先。PBI-0247)。**seal 先が device に戻っていないか**を機械で見分けるのが接頭辞の役目
 */
export async function deriveKeyId(publicJwk: JsonWebKey, prefix = "dvk_"): Promise<string> {
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return prefix + b64u.encode(digest.slice(0, 16));
}

export async function generateDeviceKeyPair(): Promise<KeyPair> {
  const kp = (await suite.kem.generateKeyPair()) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { keyId: await deriveKeyId(publicJwk), publicJwk, privateJwk };
}

async function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

export async function seal(
  plaintext: Uint8Array,
  recipients: { keyId: string; publicJwk: JsonWebKey }[],
): Promise<EncryptedEnvelope> {
  if (recipients.length === 0) {
    throw new Error("envelope needs at least one recipient device");
  }
  const contentKeyRaw = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await crypto.subtle.importKey(
    "raw",
    contentKeyRaw,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    plaintext as BufferSource,
  );

  const wrapped: EnvelopeRecipient[] = [];
  for (const r of recipients) {
    const sender = await suite.createSenderContext({
      recipientPublicKey: await importPublic(r.publicJwk),
    });
    const wrappedKey = await sender.seal(contentKeyRaw as BufferSource);
    wrapped.push({
      device_key_id: r.keyId,
      enc: b64u.encode(sender.enc),
      wrapped_key: b64u.encode(wrappedKey),
    });
  }
  return {
    v: ENVELOPE_VERSION,
    suite: SUITE_ID,
    recipients: wrapped,
    iv: b64u.encode(iv),
    ciphertext: b64u.encode(ciphertext),
  };
}

export async function open(
  envelope: EncryptedEnvelope,
  device: { keyId: string; privateJwk: JsonWebKey },
): Promise<Uint8Array> {
  if (envelope.v !== ENVELOPE_VERSION || envelope.suite !== SUITE_ID) {
    throw new Error(`unsupported envelope version/suite: ${envelope.v}/${envelope.suite}`);
  }
  const mine = envelope.recipients.find((r) => r.device_key_id === device.keyId);
  if (!mine) throw new Error("this device is not a recipient of the envelope");

  const recipient = await suite.createRecipientContext({
    recipientKey: await importPrivate(device.privateJwk),
    enc: b64u.decode(mine.enc) as BufferSource,
  });
  const contentKeyRaw = await recipient.open(
    b64u.decode(mine.wrapped_key) as BufferSource,
  );
  const contentKey = await crypto.subtle.importKey(
    "raw",
    contentKeyRaw,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64u.decode(envelope.iv) as BufferSource },
    contentKey,
    b64u.decode(envelope.ciphertext) as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// ---------- 添付の実体(PBI-0074 / W13) ----------
// envelope の外に置く blob 用の 1 回鍵 AEAD。keyB64 は FileRef.key に入り、FileRef ごと
// envelope 平文に seal される — つまり内容鍵は宛先 device の HPKE の内側に入る。server は
// blob も keyB64 も平文で見ない(E2EE アーキ §9 を添付に貫く)。

export interface FileCrypt {
  ciphertext: Uint8Array;
  /** base64(key 32byte ‖ iv 12byte)。FileRef.key に入れる値 */
  keyB64: string;
}

export async function encryptFileBytes(bytes: Uint8Array): Promise<FileCrypt> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    bytes as BufferSource,
  );
  const combined = new Uint8Array(44);
  combined.set(raw, 0);
  combined.set(iv, 32);
  return { ciphertext: new Uint8Array(ciphertext), keyB64: b64u.encode(combined) };
}

export async function decryptFileBytes(
  ciphertext: Uint8Array,
  keyB64: string,
): Promise<Uint8Array> {
  const combined = b64u.decode(keyB64);
  if (combined.length !== 44) throw new Error("invalid file key length");
  const raw = combined.slice(0, 32);
  const iv = combined.slice(32);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// ---------- account 鍵(PBI-0247) ----------
// 封をする相手を device から **account** に移す。device 鍵は「その browser / その machine」に
// 縛られるので、後から増えた端末は過去を永久に読めない(2026-09-04 に owner が実測で踏んだ)。
// account 鍵は 1 対だけ在り、**秘密鍵は browser の中で包んでから**、包んだまま server に置く。
//
// 包みを開ける鍵は client 側で KDF から作る。**認証に送る値と包みを解く鍵は、同じ秘密から
// 別の salt / info で導く** —— server が受け取るのは authValue だけで、HKDF は一方向なので
// そこから PRK も wrapKey も戻らない(REQ-52: server の DB に包みを解く材料が 1 つも無い)。
//
//   PRK       = PBKDF2-SHA256(secret, KDF_AUTH_SALT, KDF_ITERATIONS)      ← server へ送る値の材料
//   authValue = HKDF(PRK,     salt=KDF_AUTH_SALT, info="…/auth")          ← server へ送る
//   wrapPRK   = PBKDF2-SHA256(secret, kdf.salt,   KDF_WRAP_ITERATIONS)    ← **包み側の高価な段**
//   wrapKey   = HKDF(wrapPRK, salt=kdf.salt,      info="…/wrap")          ← client に留まる
//
// **高価な段は 2 本ある**(PBI-0251)。1 本だった頃は 30 万回の PBKDF2 が全 account 共通の salt で
// 走っていたので、`account_key_wraps` を持ち出した相手は「よくある password → PRK」の表を
// **service 全体で 1 回**作れば、以後 1 account 1 推測あたり HKDF + AES-GCM だけ(マイクロ秒)で
// 試せた —— 乱数 salt が入るのが HKDF(安い)以降だったため、account ごとに効いていなかった。
// 包み側の PBKDF2 に **その包みの乱数 salt** を食わせると、表は 1 account 分にしか使えない。
// authValue 側の salt が固定のままなのは設計上の制約(sign in 前は account が分からない) ——
// そちらは保存される hash ではなく、server 側で Better Auth が per-user の乱数 salt で scrypt する。

/** account 鍵の key id 接頭辞。`dvk_`(device)と混ざらない = seal 先が機械で見分けられる */
export const ACCOUNT_KEY_PREFIX = "ack_" as const;
/**
 * KDF の版。DB の `kdf.alg` に入る(将来 Argon2 等へ動かす時の分岐点)。
 * **v2 = 包み側にも PBKDF2 が在る**(PBI-0251)。v1 の包みは今の実装では開かない —— 黙って
 * 今の KDF で試すと「開かない理由」が「秘密が違う」に化けるので、`assertWrapAlg` が名乗って落とす
 */
export const KDF_ALG = "PBKDF2-SHA256/HKDF-SHA256/v2" as const;
/**
 * PBKDF2 の反復回数。**実測(2026-09-04・M2 mac / bun)**: 100k=110ms・300k=205〜270ms・
 * 600k=600〜1400ms。PBI-0247 の予算「実機で 200〜500ms」に収まるのは 300k(600k は超える)
 */
export const KDF_ITERATIONS = 300_000 as const;
/**
 * **包み側**の反復回数(PBI-0251)。auth 側と独立に動かせるよう別の定数にしてある ——
 * 実機で合計が 500ms を超えたら**こちらだけ**下げる。auth 側は server に届く値の材料なので
 * 下げると意味が反転する(弱い値を server に預ける事になる)。
 */
export const KDF_WRAP_ITERATIONS = 300_000 as const;

/**
 * authValue 側の salt は **固定**(sign in 前は account がまだ分からないので引けない)。
 * 固定でよいのは、これが保存される hash ではないから —— server 側で Better Auth が
 * 改めて per-user の乱数 salt で scrypt する。包みの方は account ごとの乱数 salt を使う。
 */
const KDF_AUTH_SALT = "openroly/account-key/v1/auth-salt";
const KDF_INFO_AUTH = "openroly/account-key/v1/auth";
const KDF_INFO_WRAP = "openroly/account-key/v1/wrap";

/** 包みが開かなかった時の理由を名乗る(PBI-0247 AC-X5。黙って空にしない) */
export class WrapOpenError extends Error {
  constructor(readonly reason: "wrong_secret" | "malformed" | "stale_kdf") {
    super(
      reason === "wrong_secret"
        ? "wrong secret for this wrap"
        : reason === "stale_kdf"
          ? "this wrap was made by an older key derivation and can no longer be opened"
          : "malformed wrap",
    );
    this.name = "WrapOpenError";
  }
}

/**
 * 包みの `kdf.alg` が今の実装で開ける版かを見る(PBI-0251 AC-X1)。**知らない版は名乗って落とす** ——
 * 今の KDF で試してしまうと AES-GCM の tag 不一致になり、「秘密が違う」という**嘘の理由**が人に出る。
 * v2 より前の包みは 1 つも無い前提だが、有った時に黙って空にしないのがこの関数の役目。
 */
export function assertWrapAlg(alg: unknown): void {
  if (alg !== KDF_ALG) throw new WrapOpenError("stale_kdf");
}

export async function generateAccountKeyPair(): Promise<KeyPair> {
  const kp = (await suite.kem.generateKeyPair()) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { keyId: await deriveKeyId(publicJwk, ACCOUNT_KEY_PREFIX), publicJwk, privateJwk };
}

const AUTH_SALT_BYTES = new TextEncoder().encode(KDF_AUTH_SALT);

/**
 * 秘密(password / 復旧コード)から高価な材料を引く。**salt を引数に取る**(PBI-0251) ——
 * 認証側は固定 salt、包み側はその包みの乱数 salt を食わせる。呼び分けを 2 関数に増やさないのは、
 * 「高価な段はここ 1 つ」を機械でも人でも見失わない為(反復回数を動かす時に触る場所が 1 箇所)。
 */
export async function deriveKeyMaterial(
  secret: string,
  iterations: number = KDF_ITERATIONS,
  salt: Uint8Array = AUTH_SALT_BYTES,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function hkdf(prk: Uint8Array, salt: Uint8Array, info: string, bits: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", prk as BufferSource, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode(info) as BufferSource,
    },
    key,
    bits,
  );
}

/**
 * **認証に送る値**。password 欄にはこれが入り、生の password は server に届かない。
 * HKDF は一方向なので、これを受け取っても(DB に残っても)wrapKey は導けない。
 */
export async function deriveAuthValue(prk: Uint8Array): Promise<string> {
  const bits = await hkdf(prk, new TextEncoder().encode(KDF_AUTH_SALT), KDF_INFO_AUTH, 256);
  return b64u.encode(bits);
}

/**
 * 包みを解く鍵。**秘密から直に引く**(PBI-0251) —— 高価な段の salt がこの包みの乱数なので、
 * authValue 側の PRK からは作れない。それが狙いで、`account_key_wraps` を持ち出した相手は
 * service 全体で 1 回作った表を使い回せない(1 account 1 推測ごとに 30 万回を払う)。
 * salt も info も authValue 側と別なので、server が受け取る値からこの鍵は導けないまま(REQ-52)。
 */
export async function deriveWrapKey(
  secret: string,
  saltB64: string,
  iterations: number = KDF_WRAP_ITERATIONS,
): Promise<CryptoKey> {
  const salt = b64u.decode(saltB64);
  const wrapPrk = await deriveKeyMaterial(secret, iterations, salt);
  const bits = await hkdf(wrapPrk, salt, KDF_INFO_WRAP, 256);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 包みごとの乱数 salt(base64url・16 byte)。DB の `kdf.salt` に入る */
export function newWrapSalt(): string {
  return b64u.encode(crypto.getRandomValues(new Uint8Array(16)));
}

/** account 秘密鍵を包む。返り値は base64url(iv 12byte ‖ AES-GCM ciphertext) */
export async function wrapPrivateKey(privateJwk: JsonWebKey, wrapKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      wrapKey,
      new TextEncoder().encode(JSON.stringify(privateJwk)) as BufferSource,
    ),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return b64u.encode(combined);
}

/**
 * 包みを解く。**開かない理由を名乗る**(AC-X5)—— 秘密が違う(`wrong_secret`)と
 * そもそも形が違う(`malformed`)を混ぜると、人に出せる文言が 1 つに潰れる。
 */
export async function unwrapPrivateKey(wrapped: string, wrapKey: CryptoKey): Promise<JsonWebKey> {
  let combined: Uint8Array;
  try {
    combined = b64u.decode(wrapped);
  } catch {
    throw new WrapOpenError("malformed");
  }
  if (combined.length <= 12) throw new WrapOpenError("malformed");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) as BufferSource },
      wrapKey,
      combined.slice(12) as BufferSource,
    );
  } catch {
    // AES-GCM の tag 不一致 = 鍵が違う。**ここが投げない runtime では検査が何も測らない**ので
    // account-key.test.ts の陽性対照(正しい秘密なら開く)と対で見る
    throw new WrapOpenError("wrong_secret");
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as JsonWebKey;
  } catch {
    throw new WrapOpenError("malformed");
  }
}

/**
 * account 秘密鍵を **device の公開鍵へ**包む(人が承認した agent 用の grant。PBI-0247)。
 * 人の秘密(password / 復旧コード)は一度も通らないので、渡した相手は他の包みを開けない。
 * 中身は既存の envelope そのもの —— 「1 回鍵で本文を暗号化し、相手の公開鍵で鍵を wrap する」
 * 大きな部品を鍵の受け渡しにもそのまま使う(2 つ目の wrap 形式を作らない)。
 */
export async function wrapPrivateKeyForDevice(
  privateJwk: JsonWebKey,
  device: { keyId: string; publicJwk: JsonWebKey },
): Promise<string> {
  const envelope = await seal(
    new TextEncoder().encode(JSON.stringify(privateJwk)),
    [{ keyId: device.keyId, publicJwk: device.publicJwk }],
  );
  return b64u.encode(new TextEncoder().encode(JSON.stringify(envelope)));
}

export async function unwrapPrivateKeyFromDevice(
  wrapped: string,
  device: { keyId: string; privateJwk: JsonWebKey },
): Promise<JsonWebKey> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(b64u.decode(wrapped))) as EncryptedEnvelope;
  } catch {
    throw new WrapOpenError("malformed");
  }
  try {
    return JSON.parse(new TextDecoder().decode(await open(envelope, device))) as JsonWebKey;
  } catch {
    throw new WrapOpenError("wrong_secret");
  }
}
