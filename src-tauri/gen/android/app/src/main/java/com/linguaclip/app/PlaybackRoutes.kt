package com.linguaclip.app

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Dispatches `playback.*` bridge methods to PlaybackService (owned by M1.1). */
internal object PlaybackRoutes {
  private fun parseCues(arr: JSONArray?): List<PlaybackEventStore.Cue>? {
    if (arr == null) return null
    val cues = ArrayList<PlaybackEventStore.Cue>(arr.length())
    for (i in 0 until arr.length()) {
      val c = arr.getJSONObject(i)
      cues.add(
        PlaybackEventStore.Cue(
          startMs = c.getLong("startMs"),
          endMs = c.getLong("endMs"),
          text = c.optString("text", ""),
          id = c.optInt("id", -1),
        ),
      )
    }
    return cues
  }

  private fun parseLongList(arr: JSONArray?): List<Long>? {
    if (arr == null) return null
    val out = ArrayList<Long>(arr.length())
    for (i in 0 until arr.length()) {
      out.add(arr.getLong(i))
    }
    return out
  }

  private fun parseIntList(arr: JSONArray?): List<Int>? {
    if (arr == null) return null
    val out = ArrayList<Int>(arr.length())
    for (i in 0 until arr.length()) {
      out.add(arr.getInt(i))
    }
    return out
  }

  fun dispatch(bridge: LinguaBridge, method: String, args: JSONObject): Any {
    return when (method) {
      "playback.load" -> {
        val svc = bridge.requireService()
        val cues = parseCues(args.optJSONArray("cues"))
        val stopsMs = parseLongList(args.optJSONArray("stopsMs") ?: args.optJSONArray("stops"))
        val rate = if (args.has("rate") && !args.isNull("rate")) args.getDouble("rate").toFloat() else null
        val artworkUri = args.optString("artworkUri", "")
        bridge.onMainSync {
          svc.load(
            source = args.getString("source"),
            title = args.optString("title", "LinguaClip"),
            artist = args.optString("artist", ""),
            startMs = args.optLong("startMs", 0L),
            autoPlay = args.optBoolean("autoPlay", false),
            mediaId = args.optString("mediaId", ""),
            cues = cues,
            stopsMs = stopsMs,
            rate = rate,
            artworkUri = artworkUri,
          )
          svc.snapshot()
        }
      }
      "playback.play" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.play(); svc.snapshot() }
      }
      "playback.pause" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.pause(); svc.snapshot() }
      }
      "playback.seek" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.seek(args.getLong("positionMs")); svc.snapshot() }
      }
      "playback.setRate" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.setRate(args.getDouble("rate").toFloat()); svc.snapshot() }
      }
      "playback.setTimeline" -> {
        val svc = bridge.requireService()
        val cues = parseCues(args.optJSONArray("cues")) ?: emptyList()
        val sectionEnd = args.optLong("sectionEndMs", -1L)
        bridge.onMainSync { svc.setTimeline(cues, sectionEnd); svc.snapshot() }
      }
      "playback.setSectionEnd" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.setSectionEnd(args.optLong("sectionEndMs", -1L)); svc.snapshot() }
      }
      "playback.setStops" -> {
        val svc = bridge.requireService()
        val stopsMs = parseLongList(args.optJSONArray("stopsMs") ?: args.optJSONArray("stops")) ?: emptyList()
        bridge.onMainSync { svc.setStops(stopsMs); svc.snapshot() }
      }
      "playback.holdAt" -> {
        val svc = bridge.requireService()
        val endMs = if (args.has("endMs") && !args.isNull("endMs")) args.getLong("endMs") else null
        bridge.onMainSync { svc.holdAt(endMs); svc.snapshot() }
      }
      "playback.setNav" -> {
        val svc = bridge.requireService()
        val lineIds = if (args.has("lineIds") && !args.isNull("lineIds")) parseIntList(args.optJSONArray("lineIds")) else null
        bridge.onMainSync { svc.setNav(lineIds); svc.snapshot() }
      }
      "playback.setAutoPause" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.setAutoPause(args.optBoolean("enabled", false)); svc.snapshot() }
      }
      "playback.setLoop" -> {
        val svc = bridge.requireService()
        bridge.onMainSync {
          svc.setLoop(
            startMs = args.getLong("startMs"),
            endMs = args.getLong("endMs"),
            count = args.optInt("count", 3),
            gapMs = args.optLong("gapMs", 300L),
          )
          svc.snapshot()
        }
      }
      "playback.clearLoop" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.clearLoop(); svc.snapshot() }
      }
      "playback.getLastPos" -> {
        val svc = bridge.requireService()
        svc.getLastPos() ?: JSONObject()
      }
      "playback.clearLastPos" -> {
        val svc = bridge.requireService()
        svc.clearLastPos()
        JSONObject().put("ok", true)
      }
      "playback.playAux" -> {
        val svc = bridge.requireService()
        bridge.onMainSync {
          svc.playAux(args.getString("source"), args.optBoolean("pauseMain", true))
          svc.snapshot()
        }
      }
      "playback.playAuxBytes" -> {
        val svc = bridge.requireService()
        val rawB64 = args.getString("base64")
        // Reject oversized Base64 strings before decoding to avoid allocating >2MB in memory.
        if (rawB64.isEmpty() || rawB64.length > 2_800_000) {
          throw IllegalArgumentException("aux:bad_size")
        }
        val bytes = Base64.decode(rawB64, Base64.DEFAULT)
        val ext = args.optString("ext", "mp3")
        val pauseMain = args.optBoolean("pauseMain", false)
        bridge.onMainSync {
          svc.playAuxBytes(bytes, ext, pauseMain)
          svc.snapshot()
        }
      }
      "playback.stopAux" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.stopAux(); svc.snapshot() }
      }
      "playback.getState" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.snapshot() }
      }
      "playback.peekBgEvents" -> {
        val svc = bridge.requireService()
        JSONObject().put("events", svc.peekBgEvents())
      }
      "playback.ackBgEvents" -> {
        val svc = bridge.requireService()
        val arr = args.optJSONArray("ids") ?: JSONArray()
        val ids = HashSet<String>(arr.length())
        for (i in 0 until arr.length()) {
          val id = arr.optString(i, "")
          if (id.isNotEmpty()) ids.add(id)
        }
        JSONObject().put("removed", svc.ackBgEvents(ids))
      }
      "playback.triggerCustomAction" -> {
        val svc = bridge.requireService()
        bridge.onMainSync { svc.triggerCustomAction(args.getString("action")) }
      }
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }
}
