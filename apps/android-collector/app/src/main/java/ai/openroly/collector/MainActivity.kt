package ai.openroly.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * setup + 状態表示(英語 UI・androidx 不使用で layout はコードで組む)。
 * 使い方の流れ(G1): 1) notification access を許可 2) token を paste 3) per-app で
 * mode を選ぶ(既定 Off)。pause/resume は token で自 source を PATCH 出来る(server は
 * paused 中も keys/dismissals を 200 で返すので端末単独で完結)。
 */
class MainActivity : Activity() {

    private lateinit var store: Store
    private lateinit var queue: Queue
    private lateinit var statusLine: TextView
    private lateinit var pauseBtn: Button
    private lateinit var appsBox: LinearLayout
    private var appsBuilt = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        queue = Queue(this)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    // --- UI 構築 ---

    private fun buildUi(): View {
        val pad = dp(16)
        val root = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        root.addView(col)

        col.addView(text("OpenRoly Collector", 22f, bold = true))

        // --- Connection ---
        col.addView(sectionLabel("Connection"))
        val urlInput = input(store.baseUrl).apply { hint = "Server URL" }
        col.addView(urlInput)
        val tokenInput = input(store.token).apply { hint = "Source token (pso_…)" }
        col.addView(tokenInput)
        col.addView(button("Save & connect").apply {
            setOnClickListener {
                store.baseUrl = urlInput.text.toString()
                store.token = tokenInput.text.toString()
                connect()
            }
        })

        // --- Notification access ---
        col.addView(sectionLabel("Notification access"))
        col.addView(button("Open notification access settings").apply {
            setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        })

        // --- Capture (pause/resume) ---
        col.addView(sectionLabel("Capture"))
        pauseBtn = button("Pause")
        col.addView(pauseBtn)
        pauseBtn.setOnClickListener {
            val next = if (store.sourceStatus == "paused") "active" else "paused"
            Thread {
                try {
                    store.sourceStatus = Api(store.baseUrl, store.token).patchSourceStatus(next)
                    runOnUiThread { refresh() }
                } catch (e: Exception) {
                    runOnUiThread { setStatus("Failed: ${e.message}") }
                }
            }.start()
        }

        // --- Per-app modes ---
        col.addView(sectionLabel("Apps"))
        col.addView(text("Tap an app to cycle: Off → Title only → Full text.", 12f, alpha = 0.7f))
        appsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(appsBox)

        // --- Status ---
        col.addView(sectionLabel("Status"))
        statusLine = text("", 15f)
        col.addView(statusLine)

        return root
    }

    private fun connect() {
        if (!store.hasToken) {
            setStatus("Token must start with pso_")
            return
        }
        Thread {
            try {
                val keys = Api(store.baseUrl, store.token).getKeys()
                store.saveKeys(keys)
                runOnUiThread {
                    setStatus("Connected. Device keys: ${keys.size}")
                    refresh()
                }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Connect failed: ${e.message}") }
            }
        }.start()
    }

    private fun refresh() {
        val listenerOn = isListenerEnabled()
        val keys = store.cachedKeys()
        setStatus(
            listOf(
                "Listener: " + if (listenerOn) "on" else "off",
                "Token: " + if (store.hasToken) "set" else "not set",
                "Device keys: ${keys?.size ?: 0}",
                "Source: ${store.sourceStatus}",
                "Queued captures: ${queue.size()}",
            ).joinToString("\n"),
        )
        pauseBtn.text = if (store.sourceStatus == "paused") "Resume" else "Pause"
        if (!appsBuilt) {
            appsBuilt = true
            buildAppRows()
        }
    }

    private fun buildAppRows() {
        appsBox.removeAllViews()
        val pm = packageManager
        val labels = linkedMapOf<String, String>()
        val launchables = pm.queryIntentActivities(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0,
        )
        for (ri in launchables) {
            val pkg = ri.activityInfo.packageName
            if (pkg == packageName) continue
            labels[pkg] = ri.loadLabel(pm)?.toString() ?: pkg
        }
        // 手動で mode を設定済みの app は一覧に必ず出す(既定 Off の app も見える様に)
        for (pkg in store.modePackages()) if (pkg !in labels) labels[pkg] = pkg

        labels.keys.sortedBy { labels[it]?.lowercase() ?: it }.forEach { pkg ->
            appsBox.addView(appRow(pkg, labels[pkg] ?: pkg))
        }
        if (labels.isEmpty()) {
            appsBox.addView(text("No launchable apps visible.", 12f, alpha = 0.7f))
        }
    }

    private fun appRow(pkg: String, label: String): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, dp(8))
        }
        val textCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        textCol.addView(text(label, 15f, bold = true))
        textCol.addView(text(pkg, 12f, alpha = 0.6f))
        row.addView(
            textCol,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )

        val modeBtn = button(modeLabel(store.modeFor(pkg)))
        modeBtn.setOnClickListener { view ->
            val next = (store.modeFor(pkg) + 1) % 3
            store.setMode(pkg, next)
            (view as Button).text = modeLabel(next)
        }
        row.addView(modeBtn)
        return row
    }

    private fun modeLabel(mode: Int) = when (mode) {
        MODE_FULL_TEXT -> "Full text"
        MODE_TITLE_ONLY -> "Title only"
        else -> "Off"
    }

    /** notification access の付与状態。androidx 無しで Settings.Secure を直接読む */
    private fun isListenerEnabled(): Boolean {
        val raw = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return raw.split(":").any { entry ->
            entry.substringBefore('/') == packageName
        }
    }

    private fun setStatus(text: String) {
        statusLine.text = text
    }

    // --- 小さな UI factory ---

    private fun text(value: String, sp: Float, bold: Boolean = false, alpha: Float = 1f) =
        TextView(this).apply {
            text = value
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            this.alpha = alpha
        }

    private fun sectionLabel(value: String) = text(value.uppercase(), 12f, bold = true, alpha = 0.6f).apply {
        setPadding(0, dp(16), 0, dp(4))
    }

    private fun input(value: String) = EditText(this).apply {
        setText(value)
        setSingleLine(true)
    }

    private fun button(label: String) = Button(this).apply { text = label }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
