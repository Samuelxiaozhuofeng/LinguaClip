package com.linguaclip.app

import org.json.JSONObject
import java.io.File

/** Dispatches `media.*` and `processing.*` bridge methods (owned by M1.2). */
internal object MediaRoutes {
  fun dispatch(bridge: LinguaBridge, method: String, args: JSONObject): Any {
    val activity = bridge.activity
    if (method.startsWith("processing.")) {
      MediaProcessingService.eventSink = { eventName, payload -> bridge.emit(eventName, payload) }
    }
    return when (method) {
      "media.probeTracks" -> MediaBridge.probeTracks(
        context = activity,
        input = args.getString("input"),
      )
      "media.extractAudio" -> MediaBridge.extractAudio(
        context = activity,
        input = args.getString("input"),
        outStemPath = args.getString("outStemPath"),
        requestedTrack = args.optInt("trackIndex", -1),
      )
      "media.decodeToWav16k" -> MediaBridge.decodeToWav16k(
        context = activity,
        input = args.getString("input"),
        outWavPath = args.getString("outWavPath"),
      )
      "media.compressPieceAac" -> MediaBridge.compressPieceAac(
        wavPath = args.getString("wavPath"),
        fromSample = args.getLong("fromSample"),
        toSample = args.getLong("toSample"),
        outM4aPath = args.getString("outM4aPath"),
        bitrate = args.optInt("bitrate", 32_000),
      )
      "media.cutAudioClip" -> MediaBridge.cutAudioClip(
        context = activity,
        input = args.getString("input"),
        startMs = args.getLong("startMs"),
        endMs = args.getLong("endMs"),
        outM4aPath = args.getString("outM4aPath"),
      )
      "media.copyUriToPath" -> MediaBridge.copyUriToPath(
        context = activity,
        uriStr = args.getString("uri"),
        destPath = args.getString("destPath"),
      )
      "media.fileInfo" -> {
        val f = File(args.getString("path"))
        val isZip = if (f.isFile && f.length() >= 2L) {
          runCatching {
            java.io.FileInputStream(f).use { fis ->
              fis.read() == 0x50 && fis.read() == 0x4B
            }
          }.getOrDefault(false)
        } else {
          false
        }
        JSONObject()
          .put("exists", f.isFile)
          .put("sizeBytes", if (f.isFile) f.length() else 0L)
          .put("isZip", isZip)
      }
      "media.removeFile" -> {
        val f = File(args.getString("path"))
        val own = activity.filesDir.canonicalFile
        val target = f.canonicalFile
        if (target.path != own.path && !target.path.startsWith(own.path + File.separator)) {
          throw SecurityException("outside app storage")
        }
        JSONObject().put("deleted", target.delete())
      }
      "processing.begin" -> {
        val jobId = args.getString("jobId")
        val title = args.optString("title", "")
        val detail = args.optString("detail", "")
        val percent = args.optInt("percent", -1)
        try {
          MediaProcessingService.ensureStarted(activity, jobId, title, detail, percent)
            .beginJob(jobId, title, detail, percent)
        } catch (e: IllegalStateException) {
          if (e.message == "processing:service_unavailable") {
            MediaProcessingService.ensureStarted(activity, jobId, title, detail, percent)
              .beginJob(jobId, title, detail, percent)
          } else {
            throw e
          }
        }
      }
      "processing.update" -> {
        val jobId = args.getString("jobId")
        val title = if (args.has("title") && !args.isNull("title")) args.optString("title") else null
        val detail = if (args.has("detail") && !args.isNull("detail")) args.optString("detail") else null
        val percent = if (args.has("percent") && !args.isNull("percent")) args.optInt("percent") else null
        val svc = MediaProcessingService.instance
        svc?.updateJob(jobId, title, detail, percent) ?: JSONObject().put("ok", false).put("ignored", true)
      }
      "processing.reconcile" -> {
        val arr = args.optJSONArray("keepIds")
        val keep = HashSet<String>()
        if (arr != null) {
          for (i in 0 until arr.length()) {
            val id = arr.optString(i, "")
            if (id.isNotEmpty()) keep.add(id)
          }
        }
        val svc = MediaProcessingService.instance
        svc?.reconcileJobs(keep) ?: JSONObject().put("ok", true).put("removed", 0)
      }
      "processing.end" -> {
        val jobId = args.getString("jobId")
        val svc = MediaProcessingService.instance
        svc?.endJob(jobId) ?: JSONObject().put("ok", true).put("jobId", jobId)
      }
      "processing.cancel" -> {
        val jobId = args.getString("jobId")
        val svc = MediaProcessingService.instance
        svc?.cancelJob(jobId, emitEvent = true) ?: JSONObject().put("ok", true).put("jobId", jobId)
      }
      "processing.runExtract" -> {
        val jobId = args.getString("jobId")
        val input = args.getString("input")
        val outStemPath = args.getString("outStemPath")
        val trackIndex = args.optInt("trackIndex", -1)
        val svc = MediaProcessingService.instance ?: throw IllegalStateException("cancelled")
        val appCtx = activity.applicationContext
        val tmpFiles = listOf("$outStemPath.m4a.tmp", "$outStemPath.webm.tmp", "$outStemPath.mp3.tmp")
        svc.runOnWorker(jobId, tmpFiles) { cancelled ->
          MediaBridge.extractAudio(appCtx, input, outStemPath, trackIndex, cancelled)
        }
      }
      "processing.runDecodeWav" -> {
        val jobId = args.getString("jobId")
        val input = args.getString("input")
        val outWavPath = args.getString("outWavPath")
        val svc = MediaProcessingService.instance ?: throw IllegalStateException("cancelled")
        val appCtx = activity.applicationContext
        svc.runOnWorker(jobId, listOf("$outWavPath.tmp")) { cancelled ->
          MediaBridge.decodeToWav16k(appCtx, input, outWavPath, cancelled)
        }
      }
      "processing.runCompressPiece" -> {
        val jobId = args.getString("jobId")
        val wavPath = args.getString("wavPath")
        val fromSample = args.getLong("fromSample")
        val toSample = args.getLong("toSample")
        val outM4aPath = args.getString("outM4aPath")
        val bitrate = args.optInt("bitrate", 32_000)
        val svc = MediaProcessingService.instance ?: throw IllegalStateException("cancelled")
        svc.runOnWorker(jobId, listOf("$outM4aPath.tmp")) { cancelled ->
          MediaBridge.compressPieceAac(wavPath, fromSample, toSample, outM4aPath, bitrate, cancelled)
        }
      }
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }
}
