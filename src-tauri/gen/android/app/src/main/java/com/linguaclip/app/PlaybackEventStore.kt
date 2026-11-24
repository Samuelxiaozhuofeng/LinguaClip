package com.linguaclip.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * Subtitle cue timeline helper, durable JSONL background event store (<filesDir>/bg-events.jsonl),
 * and atomic last-position persistence (<filesDir>/last-pos.json).
 * Uses two-phase peek + ack(ids) so lockscreen marks are never lost if the WebView dies before commit.
 */
class PlaybackEventStore(private val filesDir: File) {
  data class Cue(
    val startMs: Long,
    val endMs: Long,
    val text: String,
    val id: Int = -1,
  )

  data class LoopState(
    val startMs: Long,
    val endMs: Long,
    var remaining: Int, // -1 = infinite, >0 = remaining repeats after current pass
    val gapMs: Long,
    val initialCount: Int = 0, // 0 = infinite, >0 = total pass count
    var waitingGap: Boolean = false,
    var completedLoops: Int = 0,
    var maxDriftMs: Long = 0L,
    var lastDriftMs: Long = 0L,
  )

  private val lock = Any()
  private val lastPosLock = Any()
  private val lastPosExecutor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "lc-last-pos").apply { isDaemon = true }
  }

  @Volatile
  private var cachedLastPos: JSONObject? = null

  fun findCueIndex(timeline: List<Cue>, posMs: Long): Int {
    if (timeline.isEmpty()) return -1
    for (i in timeline.indices) {
      if (posMs >= timeline[i].startMs && posMs <= timeline[i].endMs) return i
    }
    var best = 0
    for (i in timeline.indices) {
      if (timeline[i].startMs <= posMs) best = i else break
    }
    return best
  }

  /**
   * Resolves which cue a lockscreen "记难点" press refers to:
   * - Active loop / drill: the looped target cue.
   * - Normal playback: current cue, or the previous cue if playback only just stepped into a new cue
   *   (< 300ms and < 1/3 of cue duration) while actively playing, and always in-bounds.
   */
  fun findMarkCueIndex(timeline: List<Cue>, posMs: Long, loop: LoopState?, isPlaying: Boolean): Int {
    if (timeline.isEmpty()) return -1
    if (loop != null) {
      val mid = loop.startMs + ((loop.endMs - loop.startMs).coerceAtLeast(0L) / 2L)
      return findCueIndex(timeline, mid).coerceIn(0, timeline.lastIndex)
    }
    val idx = findCueIndex(timeline, posMs).coerceIn(0, timeline.lastIndex)
    if (isPlaying && idx > 0) {
      val cue = timeline[idx]
      val elapsed = posMs - cue.startMs
      val span = (cue.endMs - cue.startMs).coerceAtLeast(0L)
      val grace = minOf(300L, span / 3L)
      if (elapsed in 0L until grace && posMs < cue.endMs) {
        return idx - 1
      }
    }
    return idx
  }

  /**
   * Computes the next cue index for prev/next sentence navigation.
   * When `navIds` is non-empty (e.g. hard-line drill queue), jumps strictly within those cue IDs.
   */
  fun findJumpIndex(timeline: List<Cue>, curPosMs: Long, loop: LoopState?, navIds: List<Int>?, delta: Int): Int {
    if (timeline.isEmpty()) return -1
    val anchorPos = loop?.startMs ?: curPosMs
    val curIdx = findCueIndex(timeline, anchorPos).coerceAtLeast(0)
    if (!navIds.isNullOrEmpty()) {
      val navIndices = ArrayList<Int>(navIds.size)
      for (id in navIds) {
        val i = timeline.indexOfFirst { it.id == id }
        if (i >= 0) navIndices.add(i)
      }
      if (navIndices.isNotEmpty()) {
        val posInNav = navIndices.indexOf(curIdx)
        val nextNavPos = if (posInNav < 0) {
          if (delta > 0) 0 else navIndices.lastIndex
        } else {
          (posInNav + delta).coerceIn(0, navIndices.lastIndex)
        }
        return navIndices[nextNavPos]
      }
    }
    return (curIdx + delta).coerceIn(0, timeline.lastIndex)
  }

  /**
   * Returns the index of the next cue whose endMs is strictly ahead of posMs (+30ms tolerance),
   * or -1 once playback is past the last cue. Handles gap seeks and trailing audio cleanly.
   */
  fun findNextPauseCueIndex(timeline: List<Cue>, posMs: Long): Int {
    if (timeline.isEmpty()) return -1
    for (i in timeline.indices) {
      if (timeline[i].endMs > posMs + 30L) return i
    }
    return -1
  }

  private fun bgEventsFile(): File = File(filesDir, "bg-events.jsonl")

  private fun lastPosFile(): File = File(filesDir, "last-pos.json")

  fun writeLastPos(mediaId: String, posMs: Long) {
    if (mediaId.isBlank() || posMs < 0L) return
    val payload = JSONObject()
      .put("mediaId", mediaId)
      .put("posMs", posMs)
      .put("ts", System.currentTimeMillis())
    cachedLastPos = payload
    val text = payload.toString()
    runCatching {
      lastPosExecutor.execute {
        synchronized(lastPosLock) {
          runCatching {
            val f = lastPosFile()
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "${f.name}.tmp")
            FileOutputStream(tmp, false).use { fos ->
              fos.write(text.toByteArray(Charsets.UTF_8))
              fos.fd.sync()
            }
            if (!tmp.renameTo(f)) {
              tmp.delete()
            }
          }
        }
      }
    }
  }

  fun readLastPos(): JSONObject? {
    cachedLastPos?.let { return JSONObject(it.toString()) }
    synchronized(lastPosLock) {
      val f = lastPosFile()
      if (!f.exists()) return null
      val parsed = runCatching { JSONObject(f.readText(Charsets.UTF_8)) }.getOrNull()
      if (parsed != null) cachedLastPos = parsed
      return parsed?.let { JSONObject(it.toString()) }
    }
  }

  fun clearLastPos() {
    cachedLastPos = null
    runCatching {
      lastPosExecutor.execute {
        synchronized(lastPosLock) {
          runCatching { lastPosFile().delete() }
        }
      }
    }
    synchronized(lastPosLock) {
      runCatching { lastPosFile().delete() }
    }
  }

  fun shutdown() {
    lastPosExecutor.shutdown()
  }

  fun appendEvent(ev: JSONObject) {
    synchronized(lock) {
      val f = bgEventsFile()
      f.parentFile?.mkdirs()
      FileOutputStream(f, true).use { fos ->
        fos.write((ev.toString() + "\n").toByteArray(Charsets.UTF_8))
        fos.fd.sync()
      }
    }
  }

  /** Read-only peek of pending background events; never deletes until explicitly acknowledged. */
  fun peekEvents(): JSONArray {
    synchronized(lock) {
      val f = bgEventsFile()
      val arr = JSONArray()
      if (!f.exists()) return arr
      val lines = runCatching { f.readLines(Charsets.UTF_8) }.getOrDefault(emptyList())
      for (line in lines) {
        val trimmed = line.trim()
        if (trimmed.isNotEmpty()) {
          runCatching { JSONObject(trimmed) }.getOrNull()?.let { arr.put(it) }
        }
      }
      return arr
    }
  }

  /** Atomically removes only the event IDs confirmed persisted by the frontend. */
  fun ackEvents(ids: Set<String>): Int {
    if (ids.isEmpty()) return 0
    synchronized(lock) {
      val f = bgEventsFile()
      if (!f.exists()) return 0
      // Never swallow read errors as empty; leave the queue untouched if reading fails.
      val lines = f.readLines(Charsets.UTF_8)
      val kept = ArrayList<String>()
      var removed = 0
      for (line in lines) {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) continue
        val obj = runCatching { JSONObject(trimmed) }.getOrNull()
        val id = obj?.optString("id", "") ?: ""
        if (id.isNotEmpty() && id in ids) {
          removed++
        } else {
          kept.add(trimmed)
        }
      }
      if (kept.isEmpty()) {
        f.delete()
      } else {
        val tmp = File(f.parentFile, "${f.name}.tmp")
        FileOutputStream(tmp, false).use { fos ->
          for (l in kept) fos.write((l + "\n").toByteArray(Charsets.UTF_8))
          fos.fd.sync()
        }
        // POSIX rename on Android atomically replaces the target without pre-deleting it.
        if (!tmp.renameTo(f)) {
          tmp.delete()
          throw IllegalStateException("events:rename_failed")
        }
      }
      return removed
    }
  }
}
