package ai.openroly.collector

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 通知 listener → seal → 送信の本体(EP-0013 W2b・図44)。
 *
 * capture の流れ: onNotificationPosted → 自身の通知は skip → per-app mode 判定(Off は
 * 即 return)→ external_id = sbn.key(server の dedupe 正本)→ 平文 JSON({title} or
 * {title, body})を 1 回だけ組み → Crypto.seal(平文は queue にも log にも残らない)→
 * queue push → flush kick。
 *
 * flush は worker loop が queue を 1 件/sec 以下で送る。202/200 で remove、429 は
 * Retry-After 待ち(REQ-68)、403 source_paused は送らず残す(pause 中も capture 自体は
 * 続け、resume で server 側の gate が開く — keys/dismissals は paused 中も 200 なので
 * 端末単独で resume 出来る)。例外・offline は queue に残って再試行される。
 *
 * dismissals loop は 10 秒間隔で server の既読を取り、一致する通知を cancelNotification
 * する(図40 の「既読で通知消失」)。
 */
class CollectorService : NotificationListenerService() {

    private lateinit var store: Store
    private lateinit var queue: Queue
    private val wake = Object()
    private val running = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        queue = Queue(this)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        startLoops()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName
        if (pkg == packageName) return // 自身の通知は capture しない

        val mode = store.modeFor(pkg)
        if (mode == MODE_OFF) return
        if (!store.hasToken) return

        val notification: Notification = sbn.notification ?: return
        val extras = notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        if (title.isNullOrBlank() && text.isNullOrBlank()) return

        // 平文は mode に応じて組み、seal した後は捨てる。Title only は body を載せない(G1)
        val plain = JSONObject()
        if (!title.isNullOrBlank()) plain.put("title", title)
        if (mode == MODE_FULL_TEXT && !text.isNullOrBlank()) plain.put("body", text)
        if (plain.length() == 0) return

        val recipients = store.cachedKeys() ?: return // keys 空なら capture しない(REQ-68)
        if (recipients.isEmpty()) return

        val envelope = try {
            Crypto.seal(plain.toString().toByteArray(Charsets.UTF_8), recipients)
        } catch (e: Exception) {
            return // seal 失敗時は平文をどこにも残さず捨てる
        }

        queue.push(
            JSONObject()
                .put("app_id", pkg)
                .put("app_display", appLabel(pkg) ?: pkg)
                .put("external_id", sbn.key ?: "$pkg:${sbn.postTime}")
                .put("envelope", envelope),
        )
        kick()
    }

    private fun appLabel(pkg: String): String? = try {
        val pm = packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) {
        null
    }

    private fun kick() {
        synchronized(wake) { wake.notifyAll() }
    }

    private fun startLoops() {
        if (!running.compareAndSet(false, true)) return
        Thread({
            flushLoop()
        }, "openroly-flush").apply { isDaemon = false; start() }
        Thread({
            dismissalsLoop()
        }, "openroly-dismissals").apply { isDaemon = false; start() }
    }

    /** queue drain。1 件/sec 以下(server の burst 規律)・429 は Retry-After 待ち */
    private fun flushLoop() {
        while (running.get()) {
            val entry = queue.peek()
            if (entry == null) {
                synchronized(wake) { wake.wait(60_000) } // 新着待ち(起きていれば kick で即再開)
                continue
            }
            val (name, item) = entry
            if (!store.hasToken) {
                synchronized(wake) { wake.wait(60_000) }
                continue
            }
            try {
                val res = Api(store.baseUrl, store.token).postNotification(item)
                when {
                    res.ok -> queue.remove(name) // 202 accepted / 200 duplicate
                    res.status == 403 -> waitQuiet(60_000) // source_paused — 残して pause 中は送らない
                    res.status == 429 -> waitQuiet((res.retryAfterSec.coerceIn(1, 300)) * 1000)
                    res.status in 500..599 -> waitQuiet(30_000) // server 側一時障害 — 残す
                    else -> queue.remove(name) // 4xx(422 等の恒久拒否)は再試行しても無駄なので捨てる
                }
            } catch (e: Exception) {
                waitQuiet(30_000) // offline / timeout — queue に残って再試行
                continue
            }
            waitQuiet(1_000) // 1 件/sec 以下
        }
    }

    /** server の既読 → 端末の通知 cancel(10 秒間隔) */
    private fun dismissalsLoop() {
        while (running.get()) {
            try {
                if (store.hasToken) {
                    // keys cache の再取得もこの loop が担う(期限切れの間だけ capture が止まる)。
                    // TTL 30 分なので実際の呼び出しは希 — 10 秒 poll にはならない
                    if (store.cachedKeys() == null) {
                        runCatching { store.saveKeys(Api(store.baseUrl, store.token).getKeys()) }
                    }
                    // since 無し = server 既定の直近 24h。毎回窓で取り直す(server に cursor 保持無し)
                    val res = Api(store.baseUrl, store.token).getDismissals(null)
                    val ids = res.optJSONArray("external_ids")
                    if (ids != null) {
                        for (i in 0 until ids.length()) {
                            val key = ids.optString(i)
                            // 存在しない/既に消えた key は例外 → 1 件で loop を止めない
                            if (key.isNotEmpty()) runCatching { cancelNotification(key) }
                        }
                    }
                }
            } catch (e: Exception) {
                // offline — 次の interval で再試行
            }
            waitQuiet(10_000)
        }
    }

    private fun waitQuiet(ms: Long) {
        synchronized(wake) { wake.wait(ms) }
    }
}
