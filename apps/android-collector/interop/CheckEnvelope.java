// PBI-0115 AC-1 の interop check(Android SDK 無し環境での byte 互換の証明)。
// app/src/main/java/ai/openroly/collector/Crypto.kt と同一手順(collector が通る seal の path)を
// Java + BouncyCastle で実行し、出した envelope を bun 側の @openroly/crypto-envelope の open で
// 開けられる事を check-interop.sh が検証する。手順は crypto-envelope/src/index.ts の seal と
// 1:1 に対応させる:
//   content key 16 byte → AES-128-GCM(IV 12 byte・AAD 無し・ct||tag)
//   各 recipient: HPKE base mode(DHKEM-P256 / HKDF-SHA256 / AES-128-GCM)で
//                 setupBaseS(pub, info=empty) → enc = encapsulation, wrapped = seal(aad=empty, contentKey)
//   deriveKeyId  = sha256(canonical JWK {"crv","kty","x","y"} の UTF-8)[0..16] → "dvk_" + base64url
// BouncyCastle の HPKE と @hpke/core は共に RFC 9180 準拠なので byte 互換のはず — それをここで機械で確かめる。
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.hpke.HPKE;
import org.bouncycastle.crypto.hpke.HPKEContext;
import org.bouncycastle.crypto.hpke.HPKEContextWithEncapsulation;
import org.bouncycastle.crypto.params.AsymmetricKeyParameter;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

public class CheckEnvelope {
  static String b64u(byte[] b) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  public static void main(String[] args) throws Exception {
    HPKE hpke = new HPKE(HPKE.mode_base, HPKE.kem_P256_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_AES_GCM128);

    // 1. recipient device 鍵ペア。BC の serializePublicKey は 0x04 || X(32) || Y(32) の
    //    非圧縮 point を返すので、JWK の x/y はそこから切り出す
    AsymmetricCipherKeyPair kp = hpke.generatePrivateKey();
    byte[] pub65 = hpke.serializePublicKey(kp.getPublic());
    byte[] x = Arrays.copyOfRange(pub65, 1, 33);
    byte[] y = Arrays.copyOfRange(pub65, 33, 65);
    byte[] d = to32(((ECPrivateKeyParameters) kp.getPrivate()).getD());

    String pubJwkJson =
        "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"" + b64u(x) + "\",\"y\":\"" + b64u(y) + "\"}";

    // 2. deriveKeyId(crypto-envelope の canonical JSON と同一文字列)
    MessageDigest sha = MessageDigest.getInstance("SHA-256");
    String keyId = "dvk_" + b64u(Arrays.copyOf(sha.digest(pubJwkJson.getBytes("UTF-8")), 16));

    // 3. plaintext(日本語を含む UTF-8 の round-trip も見る)
    byte[] plaintext = "interop: 端末から collector 経由で seal した平文".getBytes("UTF-8");

    // 4. content key + AES-128-GCM(IV 12 byte・AAD 無し。Java は ct||tag を返す = WebCrypto と同じ)
    SecureRandom rnd = new SecureRandom();
    byte[] contentKey = new byte[16];
    rnd.nextBytes(contentKey);
    byte[] iv = new byte[12];
    rnd.nextBytes(iv);
    Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
    aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(contentKey, "AES"), new GCMParameterSpec(128, iv));
    byte[] ciphertext = aes.doFinal(plaintext);

    // 5. HPKE seal(info 空・aad 空・1 回呼び = seq 0)
    AsymmetricKeyParameter pubParam = hpke.deserializePublicKey(pub65);
    HPKEContextWithEncapsulation sender = hpke.setupBaseS(pubParam, new byte[0]);
    byte[] enc = sender.getEncapsulation();
    byte[] wrappedKey = sender.seal(new byte[0], contentKey);

    // 6. Java 単体の round-trip(失敗した時、原因が BC 側か TS 側かを切り分けられる様に)
    HPKEContext receiver = hpke.setupBaseR(enc, kp, new byte[0]);
    if (!Arrays.equals(receiver.open(new byte[0], wrappedKey), contentKey)) {
      throw new AssertionError("BC round-trip failed (BC side is broken)");
    }

    // 7. TS 側の検査用に鍵ペアと envelope を JSON で出力
    System.out.println("{"
        + "\"keyId\":\"" + keyId + "\","
        + "\"publicJwk\":" + pubJwkJson + ","
        + "\"privateJwk\":{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"" + b64u(x)
            + "\",\"y\":\"" + b64u(y) + "\",\"d\":\"" + b64u(d) + "\"},"
        + "\"plaintext\":\"" + new String(plaintext, "UTF-8") + "\","
        + "\"envelope\":{\"v\":1,\"suite\":\"hpke-p256-sha256-a128gcm\","
        + "\"recipients\":[{\"device_key_id\":\"" + keyId
            + "\",\"enc\":\"" + b64u(enc) + "\",\"wrapped_key\":\"" + b64u(wrappedKey) + "\"}],"
        + "\"iv\":\"" + b64u(iv) + "\",\"ciphertext\":\"" + b64u(ciphertext) + "\"}}");
  }

  /** BigInteger の 2's complement を 32 byte の固定長符号無し scalar に揃える(JWK の d 相当) */
  static byte[] to32(BigInteger v) {
    byte[] raw = v.toByteArray();
    byte[] out = new byte[32];
    if (raw.length >= 32) System.arraycopy(raw, raw.length - 32, out, 0, 32);
    else System.arraycopy(raw, 0, out, 32 - raw.length, raw.length);
    return out;
  }
}
