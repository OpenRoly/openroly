package ai.openroly.collector

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL

/** server 側の 4 inbound 経路(apps/server/src/app.ts)と一致させる。図44・
 * diagrams-check.sh が app 側と server 側の両方にこの文字列が在る事を機械検査する */
const val PATH_NOTIFICATION = "/v1/inbound/notification"
const val PATH_KEYS = "/v1/inbound/keys"
const val PATH_DISMISSALS = "/v1/inbound/dismissals"
const val PATH_SOURCE = "/v1/inbound/source"

/** HTTP の結果。Retry-After は 429 時の待ち時間の正本(REQ-68: queue の 429 時 Retry-After 待ち) */
class ApiResult(
    val status: Int,
    val body: JSONObject?,
    val retryAfterSec: Long,
    val rawBody: String,
) {
    val ok: Boolean get() = status in 200..299
}

class ApiException(message: String) : Exception(message)

/**
 * source token(pso_…)で呼ぶ server の 4 経路。依存を増やさない為 HttpURLConnection で書く。
 * 通知 burst と poll を想定した timeout 設定。例外は呼び出し側(queue / poll の loop)で
 * offline として扱う — ここでは握り潰さない。
 */
class Api(private val baseUrl: String, private val token: String) {

    /** account の active device 公開鍵群(bare array)。seal 先。空配列も正常応答(AC-X2) */
    fun getKeys(): List<JSONObject> {
        val res = request("GET", PATH_KEYS, null)
        if (!res.ok) throw ApiException("keys ${res.status}")
        // body は bare array — JSONObject で包まず JSONArray として読む
        val parsed = if (res.rawBody.isBlank()) JSONArray() else JSONArray(res.rawBody)
        return (0 until parsed.length()).map { parsed.getJSONObject(it) }
    }

    /** 既読 external_id 一覧({external_ids:[…]})。metadata のみ・本文は server に無い */
    fun getDismissals(sinceIso: String?): JSONObject {
        val path = if (sinceIso != null) "$PATH_DISMISSALS?since=" + encode(sinceIso) else PATH_DISMISSALS
        val res = request("GET", path, null)
        if (!res.ok) throw ApiException("dismissals ${res.status}")
        return res.body ?: JSONObject()
    }

    /** L1 capture。202 accepted / 200 duplicate。403 = source_paused・429 = rate limited */
    fun postNotification(body: JSONObject): ApiResult = request("POST", PATH_NOTIFICATION, body)

    /** 自 source の status 同期(paused ⇄ active)。revoke は token では不可(server が 422) */
    fun patchSourceStatus(status: String): String {
        val res = request("PATCH", PATH_SOURCE, JSONObject().put("status", status))
        if (!res.ok) throw ApiException("source ${res.status}")
        return res.body?.optString("status", status) ?: status
    }

    private fun encode(s: String): String = URLEncoder.encode(s, "UTF-8")

    private fun request(method: String, path: String, body: JSONObject?): ApiResult {
        val conn = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Content-Type", "application/json")
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return ApiResult(
                status,
                text.takeIf { it.startsWith("{") }?.let { runCatching { JSONObject(it) }.getOrNull() },
                conn.getHeaderField("Retry-After")?.toLongOrNull() ?: 0L,
                text,
            )
        } finally {
            conn.disconnect()
        }
    }
}
