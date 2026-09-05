package ai.paa.collector

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** per-app capture mode(図44・G1): 0=Off(既定・capture しない)/1=Title only(body を載せない)
 * /2=Full text(title+body を envelope 平文にする)。既定 Off は秘匿境界(REQ-67/71):
 * user が明示的に app を選ぶまで通知内容を一切 capture しない。 */
const val MODE_OFF = 0
const val MODE_TITLE_ONLY = 1
const val MODE_FULL_TEXT = 2

/**
 * 端末内の設定と keys cache の唯一の置き場所(SharedPreferences)。
 * 通知本文はここに置かない — queue も含めて平文保存はしない(REQ-68: keys cache が
 * 空なら capture しないので、平文が queue に溜まる状態が存在しない)。
 */
class Store(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("paa-collector", Context.MODE_PRIVATE)

    /** source token(pso_…)。空 = 未接続 */
    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    val hasToken: Boolean get() = token.startsWith("pso_")

    /** server の基点。既定は hosted deploy(pbi-0104 で出した URL) */
    var baseUrl: String
        get() = prefs.getString("base_url", DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        set(v) = prefs.edit().putString("base_url", v.trim().trimEnd('/')).apply()

    /** per-app capture mode。無い app は Off */
    fun modeFor(packageName: String): Int = prefs.getInt("mode:$packageName", MODE_OFF)

    /** 自 source の status の最終既知値(pause/resume PATCH の結果を反映)。
     * server が真だが、UI 表示と toggle の基点として端末に置く */
    var sourceStatus: String
        get() = prefs.getString("source_status", "active") ?: "active"
        set(v) = prefs.edit().putString("source_status", v).apply()

    fun setMode(packageName: String, mode: Int) =
        prefs.edit().putInt("mode:$packageName", mode).apply()

    fun modePackages(): List<String> =
        prefs.all.keys.filter { it.startsWith("mode:") }.map { it.removePrefix("mode:") }.sorted()

    // --- device keys cache(GET /v1/inbound/keys の 30 分 cache) ---

    /** cache 済み recipients。無効(未取得・30 分経過)は null — 呼び出し側は capture を skip */
    fun cachedKeys(maxAgeMs: Long = KEYS_TTL_MS): List<JSONObject>? {
        val at = prefs.getLong("keys_at", 0L)
        val raw = prefs.getString("keys_json", null) ?: return null
        if (System.currentTimeMillis() - at > maxAgeMs) return null
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.getJSONObject(it) }
        }.getOrNull()
    }

    fun saveKeys(keys: List<JSONObject>) {
        val arr = JSONArray()
        keys.forEach { arr.put(it) }
        prefs.edit().putString("keys_json", arr.toString())
            .putLong("keys_at", System.currentTimeMillis()).apply()
    }

    companion object {
        // 初回のみの既定(保存済みの base_url は上書きしない)。PBI-0186: hosted を Fly に移し
        // 旧 URL は 404 になった —— 入れた人が最初に叩く先が死んでいると、何も起きずに終わる
        const val DEFAULT_BASE_URL = "https://atn.shibubu.ai"
        const val KEYS_TTL_MS = 30 * 60 * 1000L
    }
}
