package ai.openroly.collector

import org.bouncycastle.crypto.hpke.HPKE
import org.bouncycastle.crypto.hpke.HPKEContextWithEncapsulation
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** envelope suite の正本。packages/crypto-envelope/src/index.ts の SUITE_ID と一致する事を
 * diagrams-check.sh が機械検査する(図44・byte 互換の契約) */
const val SUITE_ID = "hpke-p256-sha256-a128gcm"

private const val ENVELOPE_VERSION = 1

/**
 * L1 seal(EP-0013 W2b・図44): 平文をこの端末で 1 回だけ AEAD 暗号化し、content key を
 * account の device 公開鍵群(GET /v1/inbound/keys で受けた物)へ HPKE で wrap する。
 * server は envelope を素通しするだけで平文を一度も見ない。
 * 手順の正本は packages/crypto-envelope/src/index.ts の seal() — byte 互換は
 * apps/android-collector/interop/check-interop.sh が Java+BC 実装で機械検証する(AC-1)。
 */
object Crypto {
    private val random = SecureRandom()
    private val b64u = Base64.getUrlEncoder().withoutPadding()
    private val b64uDecode = Base64.getUrlDecoder()

    /**
     * recipients は GET /v1/inbound/keys の要素({id, public_key_jwk})の形。
     * device_key_id は server が返す id をそのまま載せる(端末側で再導出しない)。
     * recipients が空なら envelope が成立しない — 呼び出し側(keys cache が空の状態)で
     * capture を skip する事。空 envelope は server も 422 invalid_envelope で受ける。
     */
    fun seal(plaintext: ByteArray, recipients: List<JSONObject>): JSONObject {
        require(recipients.isNotEmpty()) { "no device keys to seal to" }

        val contentKey = ByteArray(16).also { random.nextBytes(it) }
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val aes = Cipher.getInstance("AES/GCM/NoPadding")
        aes.init(Cipher.ENCRYPT_MODE, SecretKeySpec(contentKey, "AES"), GCMParameterSpec(128, iv))
        val ciphertext = aes.doFinal(plaintext)

        val hpke = HPKE(
            HPKE.mode_base,
            HPKE.kem_P256_SHA256,
            HPKE.kdf_HKDF_SHA256,
            HPKE.aead_AES_GCM128,
        )
        val wrapped = JSONArray()
        for (device in recipients) {
            val jwk = device.getJSONObject("public_key_jwk")
            // JWK の x/y(base64url・32 byte)→ 0x04 || X || Y の 65-byte 非圧縮 point
            val x = b64uDecode.decode(jwk.getString("x"))
            val y = b64uDecode.decode(jwk.getString("y"))
            val pub65 = ByteArray(65)
            pub65[0] = 0x04
            x.copyInto(pub65, 1)
            y.copyInto(pub65, 33)

            val sender: HPKEContextWithEncapsulation = hpke.setupBaseS(
                hpke.deserializePublicKey(pub65),
                ByteArray(0), // info は空
            )
            val wrappedKey = sender.seal(ByteArray(0), contentKey) // aad 空・1 回呼び = seq 0
            wrapped.put(
                JSONObject()
                    .put("device_key_id", device.getString("id"))
                    .put("enc", b64u.encodeToString(sender.encapsulation))
                    .put("wrapped_key", b64u.encodeToString(wrappedKey)),
            )
        }

        return JSONObject()
            .put("v", ENVELOPE_VERSION)
            .put("suite", SUITE_ID)
            .put("recipients", wrapped)
            .put("iv", b64u.encodeToString(iv))
            .put("ciphertext", b64u.encodeToString(ciphertext))
    }
}
