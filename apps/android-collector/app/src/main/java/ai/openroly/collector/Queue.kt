package ai.openroly.collector

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 未送信 capture の端末内 queue(filesDir・1 件 = 1 JSON file)。
 * envelope は平文を含まないので端末に置いて良い(REQ-68)。上限 1000 件 — 超えたら
 * 最古を捨てる(burst で server に届かない状態が長く続いた時の escape)。
 * 順序保持: file 名に連番を付けて昇順に読む。
 */
class Queue(context: Context) {

    private val dir = File(context.filesDir, "queue").apply { mkdirs() }
    private var seq = (dir.listFiles()?.maxOfOrNull { it.name.substringBefore('.').toLongOrNull() ?: 0L } ?: 0L)

    @Synchronized
    fun push(item: JSONObject) {
        seq += 1
        File(dir, "%012d.json".format(seq)).writeText(item.toString())
        trim()
    }

    /** 最古の 1 件。無ければ null */
    @Synchronized
    fun peek(): Pair<String, JSONObject>? {
        val file = dir.listFiles()?.minByOrNull { it.name } ?: return null
        val obj = runCatching { JSONObject(file.readText()) }.getOrNull() ?: run {
            file.delete() // 壊れた file は捨てて先に進む(queue 全体を止めない)
            return null
        }
        return file.name to obj
    }

    @Synchronized
    fun remove(name: String) {
        File(dir, name).delete()
    }

    @Synchronized
    fun size(): Int = dir.listFiles()?.size ?: 0

    /** 上限超過分の最古を捨てる */
    private fun trim() {
        val files = dir.listFiles()?.sortedBy { it.name } ?: return
        files.take(maxOf(0, files.size - MAX_ITEMS)).forEach { it.delete() }
    }

    companion object {
        const val MAX_ITEMS = 1000
    }
}
