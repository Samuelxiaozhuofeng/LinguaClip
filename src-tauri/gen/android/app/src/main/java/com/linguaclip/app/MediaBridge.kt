package com.linguaclip.app

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Native Android media pipeline using MediaExtractor / MediaMuxer / MediaCodec:
 * - Track probing with display name, size, default-track flag, and codec support detection
 * - Lossless audio-track extraction (AAC -> .m4a; Opus/Vorbis -> .webm on API 29+, AAC fallback on API 24-28; MP3 -> .mp3)
 * - Transcoding lossless audiobooks (FLAC/WAV) to compact 96kbps stereo AAC .m4a
 * - Unified 16kHz mono PCM WAV decoding (handles both downsampling >16kHz and linear upsampling <16kHz)
 * - Lossless/transcoded audio clip cutting for review cards (replaces desktop ffmpeg clips.rs)
 */
object MediaBridge {
  private val UNSUPPORTED_CODECS = setOf(
    "audio/ac3",
    "audio/eac3",
    "audio/eac3-joc",
    "audio/vnd.dts",
    "audio/vnd.dts.hd",
    "audio/true-hd",
    "audio/ac4",
  )

  private fun openExtractor(context: Context, input: String): MediaExtractor {
    val extractor = MediaExtractor()
    if (input.startsWith("content://")) {
      extractor.setDataSource(context, Uri.parse(input), null)
    } else if (input.startsWith("https://", ignoreCase = true)) {
      // Streamed starter / podcast episodes (review clips, AnkiDroid audio): HTTP range reads.
      extractor.setDataSource(input, emptyMap<String, String>())
    } else {
      FileInputStream(input).use { fis ->
        extractor.setDataSource(fis.fd)
      }
    }
    return extractor
  }

  private fun queryFileMeta(context: Context, input: String): Triple<String, Long, String> {
    if (input.startsWith("content://")) {
      val uri = Uri.parse(input)
      var name = uri.lastPathSegment?.substringAfterLast('/') ?: "audio"
      var size = 0L
      val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull() ?: ""
      runCatching {
        context.contentResolver.query(
          uri,
          arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
          null,
          null,
          null,
        )?.use { cursor ->
          if (cursor.moveToFirst()) {
            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
              val n = cursor.getString(nameIdx)
              if (!n.isNullOrBlank()) name = n
            }
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
              size = cursor.getLong(sizeIdx).coerceAtLeast(0L)
            }
          }
        }
      }
      return Triple(name, size, mime)
    }
    val f = File(input)
    return Triple(f.name.ifBlank { "audio" }, if (f.isFile) f.length() else 0L, "")
  }

  private fun isTrackDefault(fmt: MediaFormat): Boolean {
    if (fmt.containsKey(MediaFormat.KEY_IS_DEFAULT)) {
      if (runCatching { fmt.getInteger(MediaFormat.KEY_IS_DEFAULT) }.getOrDefault(0) != 0) {
        return true
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && fmt.containsKey("selection-flags")) {
      val flags = runCatching { fmt.getInteger("selection-flags") }.getOrDefault(0)
      if ((flags and 1) != 0) return true
    }
    return false
  }

  fun probeTracks(context: Context, input: String): JSONObject {
    val (displayName, sizeBytes, resolverMime) = queryFileMeta(context, input)
    val extractor = openExtractor(context, input)
    try {
      val trackArr = JSONArray()
      var firstDefaultSupported = -1
      var firstSupported = -1
      var firstMime = ""
      var audioIdx = 0
      for (i in 0 until extractor.trackCount) {
        val fmt = extractor.getTrackFormat(i)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
        if (!mime.startsWith("audio/")) continue
        if (firstMime.isEmpty()) firstMime = mime
        val isDef = isTrackDefault(fmt)
        val supported = mime !in UNSUPPORTED_CODECS
        if (supported && firstSupported < 0) firstSupported = audioIdx
        if (isDef && supported && firstDefaultSupported < 0) firstDefaultSupported = audioIdx
        trackArr.put(
          JSONObject()
            .put("index", audioIdx)
            .put("mime", mime)
            .put("language", if (fmt.containsKey(MediaFormat.KEY_LANGUAGE)) fmt.getString(MediaFormat.KEY_LANGUAGE) ?: "" else "")
            .put("sampleRate", if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 0)
            .put("channels", if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 0)
            .put("isDefault", isDef)
            .put("supported", supported),
        )
        audioIdx++
      }
      val defaultTrackIndex = if (firstDefaultSupported >= 0) firstDefaultSupported else firstSupported
      return JSONObject()
        .put("displayName", displayName)
        .put("sizeBytes", sizeBytes)
        .put("mime", resolverMime.ifBlank { firstMime })
        .put("tracks", trackArr)
        .put("defaultTrackIndex", defaultTrackIndex)
    } finally {
      extractor.release()
    }
  }

  fun copyUriToPath(
    context: Context,
    uriStr: String,
    destPath: String,
    cancelled: (() -> Boolean)? = null,
  ): JSONObject {
    if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
    val dest = File(destPath)
    dest.parentFile?.mkdirs()
    val tmp = File("${dest.absolutePath}.tmp")
    val stream = if (uriStr.startsWith("content://")) {
      context.contentResolver.openInputStream(Uri.parse(uriStr))
        ?: throw IllegalStateException("file:unreadable")
    } else {
      FileInputStream(uriStr)
    }
    var total = 0L
    try {
      stream.use { input ->
        BufferedOutputStream(FileOutputStream(tmp)).use { out ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
            val n = input.read(buf)
            if (n <= 0) break
            out.write(buf, 0, n)
            total += n
          }
          out.flush()
        }
      }
      if (dest.exists()) dest.delete()
      if (!tmp.renameTo(dest)) throw IllegalStateException("file:rename_failed")
    } catch (e: Exception) {
      tmp.delete()
      throw e
    }
    return JSONObject().put("path", dest.absolutePath).put("sizeBytes", total)
  }

  fun extractAudio(
    context: Context,
    input: String,
    outStemPath: String,
    requestedTrack: Int = -1,
    cancelled: (() -> Boolean)? = null,
  ): JSONObject {
    if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
    val (displayName, _, _) = queryFileMeta(context, input)
    val extractor = openExtractor(context, input)
    try {
      val tracks = mutableListOf<Pair<Int, MediaFormat>>()
      var hasVideoTrack = false
      for (i in 0 until extractor.trackCount) {
        val fmt = extractor.getTrackFormat(i)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/")) {
          hasVideoTrack = true
        } else if (mime.startsWith("audio/")) {
          tracks.add(i to fmt)
        }
      }
      if (tracks.isEmpty()) throw IllegalStateException("audio:no_track")

      val trackArr = JSONArray()
      var firstDefaultSupported = -1
      var firstSupported = -1
      tracks.forEachIndexed { idx, (_, fmt) ->
        val m = fmt.getString(MediaFormat.KEY_MIME) ?: ""
        val isDef = isTrackDefault(fmt)
        val supported = m !in UNSUPPORTED_CODECS
        if (supported && firstSupported < 0) firstSupported = idx
        if (isDef && supported && firstDefaultSupported < 0) firstDefaultSupported = idx
        trackArr.put(
          JSONObject()
            .put("index", idx)
            .put("mime", m)
            .put("language", if (fmt.containsKey(MediaFormat.KEY_LANGUAGE)) fmt.getString(MediaFormat.KEY_LANGUAGE) ?: "" else "")
            .put("sampleRate", if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 0)
            .put("channels", if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 0)
            .put("isDefault", isDef)
            .put("supported", supported),
        )
      }

      val chosenIdx = when {
        requestedTrack in tracks.indices -> requestedTrack
        firstDefaultSupported >= 0 -> firstDefaultSupported
        firstSupported >= 0 -> firstSupported
        else -> 0
      }
      val chosenPair = tracks[chosenIdx]
      val trackIdx = chosenPair.first
      val fmt = chosenPair.second
      val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
      if (mime in UNSUPPORTED_CODECS) {
        throw IllegalStateException("audio:unsupported_codec:$mime")
      }
      val durationUs = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION) else 0L

      val canWebmMux = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
      val isStandaloneMp3 = mime == MediaFormat.MIMETYPE_AUDIO_MPEG && (
        input.lowercase().endsWith(".mp3") ||
          displayName.lowercase().endsWith(".mp3") ||
          (!hasVideoTrack && tracks.size == 1)
        )
      val (outPath, lossless) = when {
        mime == MediaFormat.MIMETYPE_AUDIO_AAC -> {
          val dest = "$outStemPath.m4a"
          remuxTrack(extractor, trackIdx, fmt, dest, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4, cancelled = cancelled)
          dest to true
        }
        (mime == MediaFormat.MIMETYPE_AUDIO_OPUS || mime == MediaFormat.MIMETYPE_AUDIO_VORBIS) && canWebmMux -> {
          val dest = "$outStemPath.webm"
          remuxTrack(extractor, trackIdx, fmt, dest, MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM, cancelled = cancelled)
          dest to true
        }
        isStandaloneMp3 -> {
          val dest = "$outStemPath.mp3"
          copyUriToPath(context, input, dest, cancelled)
          dest to true
        }
        else -> {
          // Lossless audiobooks (FLAC/WAV), API 24-28 Opus/Vorbis, or non-remuxable tracks -> 96kbps stereo AAC (~43MB/hr)
          val dest = "$outStemPath.m4a"
          AudioEncodeUtil.transcodeTrackToAac(
            extractor,
            trackIdx,
            fmt,
            dest,
            bitrate = 96_000,
            forceMono16k = false,
            cancelled = cancelled,
          )
          dest to false
        }
      }

      val outFile = File(outPath)
      return JSONObject()
        .put("path", outFile.absolutePath)
        .put("mime", mime)
        .put("lossless", lossless)
        .put("durationMs", durationUs / 1000L)
        .put("sizeBytes", outFile.length())
        .put("tracks", trackArr)
    } finally {
      extractor.release()
    }
  }

  private fun remuxTrack(
    extractor: MediaExtractor,
    trackIdx: Int,
    fmt: MediaFormat,
    destPath: String,
    muxerFormat: Int,
    startUs: Long = 0L,
    endUs: Long = Long.MAX_VALUE,
    cancelled: (() -> Boolean)? = null,
  ) {
    if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
    val dest = File(destPath)
    dest.parentFile?.mkdirs()
    val tmp = File("${dest.absolutePath}.${System.nanoTime()}.tmp")  // own name per call: two cuts of one clip must not share it
    val muxer = MediaMuxer(tmp.absolutePath, muxerFormat)
    var started = false
    try {
      extractor.selectTrack(trackIdx)
      if (startUs > 0L) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
      val outTrack = muxer.addTrack(fmt)
      muxer.start()
      started = true

      val maxSize = if (fmt.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        fmt.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE).coerceAtLeast(256 * 1024)
      } else {
        256 * 1024
      }
      val buf = ByteBuffer.allocate(maxSize)
      val info = MediaCodec.BufferInfo()
      var basePts = Long.MIN_VALUE
      var written = 0

      while (true) {
        if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
        buf.clear()
        val sampleSize = extractor.readSampleData(buf, 0)
        if (sampleSize < 0) break
        val pts = extractor.sampleTime
        if (endUs != Long.MAX_VALUE && pts > endUs) break
        if (startUs == 0L || pts >= startUs || basePts != Long.MIN_VALUE) {
          if (basePts == Long.MIN_VALUE) basePts = pts
          buf.position(0)
          buf.limit(sampleSize)
          info.offset = 0
          info.size = sampleSize
          info.presentationTimeUs = (pts - basePts).coerceAtLeast(0L)
          info.flags = if ((extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
            MediaCodec.BUFFER_FLAG_KEY_FRAME
          } else {
            0
          }
          muxer.writeSampleData(outTrack, buf, info)
          written++
        }
        extractor.advance()
      }
      if (written == 0) throw IllegalStateException("audio:empty_remux")
      muxer.stop()
      started = false
      if (dest.exists()) dest.delete()
      if (!tmp.renameTo(dest)) throw IllegalStateException("audio:rename_failed")
    } catch (e: Exception) {
      if (started) runCatching { muxer.stop() }
      tmp.delete()
      throw e
    } finally {
      runCatching { muxer.release() }
    }
  }

  fun decodeToWav16k(
    context: Context,
    input: String,
    outWavPath: String,
    cancelled: (() -> Boolean)? = null,
  ): JSONObject {
    if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
    val extractor = openExtractor(context, input)
    try {
      var trackIdx = -1
      var fmt: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val f = extractor.getTrackFormat(i)
        val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) {
          if (mime in UNSUPPORTED_CODECS) throw IllegalStateException("audio:unsupported_codec:$mime")
          trackIdx = i
          fmt = f
          break
        }
      }
      if (trackIdx < 0 || fmt == null) throw IllegalStateException("audio:no_track")
      val mime = fmt.getString(MediaFormat.KEY_MIME)!!
      extractor.selectTrack(trackIdx)

      val dest = File(outWavPath)
      dest.parentFile?.mkdirs()
      val tmp = File("${dest.absolutePath}.tmp")
      val codec = MediaCodec.createDecoderByType(mime)
      var totalOutSamples = 0L
      var outStream: BufferedOutputStream? = null
      try {
        codec.configure(fmt, null, null, 0)
        codec.start()

        var srcRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var srcCh = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
        outStream = BufferedOutputStream(FileOutputStream(tmp))
        outStream.write(ByteArray(44))

        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false
        var acc = 0.0
        var accCount = 0
        var stepPos = 0.0
        var hasPrev = false
        var prevMono = 0.0
        var upPhase = 0.0
        var ratio = srcRate.toDouble() / 16000.0
        val shortBuf = ByteBuffer.allocate(8192).order(ByteOrder.LITTLE_ENDIAN)

        fun emitSample(v: Double) {
          shortBuf.putShort(v.toInt().coerceIn(-32768, 32767).toShort())
          totalOutSamples++
          if (shortBuf.remaining() < 2) {
            outStream!!.write(shortBuf.array(), 0, shortBuf.position())
            shortBuf.clear()
          }
        }

        while (!outputDone) {
          if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
          var progressed = false
          if (!inputDone) {
            val inIdx = codec.dequeueInputBuffer(0)
            if (inIdx >= 0) {
              progressed = true
              val inBuf = codec.getInputBuffer(inIdx)!!
              val n = extractor.readSampleData(inBuf, 0)
              if (n < 0) {
                codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                codec.queueInputBuffer(inIdx, 0, n, extractor.sampleTime.coerceAtLeast(0L), 0)
                extractor.advance()
              }
            }
          }
          while (!outputDone) {
            val outIdx = codec.dequeueOutputBuffer(info, if (progressed) 0L else 2_000L)
            when {
              outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                progressed = true
                val of = codec.outputFormat
                if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                  srcRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                  ratio = srcRate.toDouble() / 16000.0
                }
                if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                  srcCh = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
                }
              }
              outIdx >= 0 -> {
                progressed = true
                val outBuf = codec.getOutputBuffer(outIdx)
                if (outBuf != null && info.size > 0) {
                  outBuf.position(info.offset)
                  outBuf.limit(info.offset + info.size)
                  val shorts = outBuf.slice().order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                  val frames = shorts.remaining() / srcCh
                  for (f in 0 until frames) {
                    var sum = 0
                    for (c in 0 until srcCh) sum += shorts.get().toInt()
                    val mono = sum.toDouble() / srcCh
                    when {
                      srcRate == 16000 -> emitSample(mono)
                      ratio < 1.0 -> {
                        // Linear interpolation upsampling (e.g. 8kHz / 11.025kHz -> 16kHz)
                        if (!hasPrev) {
                          prevMono = mono
                          hasPrev = true
                        } else {
                          while (upPhase < 1.0) {
                            emitSample(prevMono + (mono - prevMono) * upPhase)
                            upPhase += ratio
                          }
                          upPhase -= 1.0
                          prevMono = mono
                        }
                      }
                      else -> {
                        // Averaging downsampler (>16kHz -> 16kHz)
                        acc += mono
                        accCount++
                        stepPos += 1.0
                        if (stepPos >= ratio) {
                          stepPos -= ratio
                          emitSample(acc / accCount)
                          acc = 0.0
                          accCount = 0
                        }
                      }
                    }
                  }
                }
                codec.releaseOutputBuffer(outIdx, false)
                if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
              }
              else -> break
            }
          }
        }
        if (ratio < 1.0 && hasPrev) {
          emitSample(prevMono)
        }
        if (shortBuf.position() > 0) {
          outStream.write(shortBuf.array(), 0, shortBuf.position())
        }
        outStream.flush()
        outStream.close()
        outStream = null
        AudioEncodeUtil.patchWavHeader(tmp, totalOutSamples, 16000, 1)
        if (dest.exists()) dest.delete()
        if (!tmp.renameTo(dest)) throw IllegalStateException("audio:rename_failed")
      } catch (e: Exception) {
        runCatching { outStream?.close() }
        tmp.delete()
        throw e
      } finally {
        runCatching { codec.stop() }
        runCatching { codec.release() }
      }
      return JSONObject()
        .put("wavPath", dest.absolutePath)
        .put("samples", totalOutSamples)
        .put("durationMs", totalOutSamples * 1000L / 16000L)
        .put("sizeBytes", dest.length())
    } finally {
      extractor.release()
    }
  }

  fun compressPieceAac(
    wavPath: String,
    fromSample: Long,
    toSample: Long,
    outM4aPath: String,
    bitrate: Int = 32_000,
    cancelled: (() -> Boolean)? = null,
  ): JSONObject = AudioEncodeUtil.compressPieceAac(wavPath, fromSample, toSample, outM4aPath, bitrate, cancelled)

  fun cutAudioClip(context: Context, input: String, startMs: Long, endMs: Long, outM4aPath: String): JSONObject {
    val extractor = openExtractor(context, input)
    try {
      var trackIdx = -1
      var fmt: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val f = extractor.getTrackFormat(i)
        val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) {
          trackIdx = i
          fmt = f
          break
        }
      }
      if (trackIdx < 0 || fmt == null) throw IllegalStateException("audio:no_track")
      val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
      val sUs = (startMs * 1000L).coerceAtLeast(0L)
      val eUs = (endMs * 1000L).coerceAtLeast(sUs + 100_000L)
      if (mime == MediaFormat.MIMETYPE_AUDIO_AAC) {
        remuxTrack(extractor, trackIdx, fmt, outM4aPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4, sUs, eUs)
      } else {
        AudioEncodeUtil.transcodeTrackToAac(extractor, trackIdx, fmt, outM4aPath, bitrate = 96_000, forceMono16k = false, startUs = sUs, endUs = eUs)
      }
      val outFile = File(outM4aPath)
      return JSONObject()
        .put("path", outFile.absolutePath)
        .put("sizeBytes", outFile.length())
        .put("durationMs", (eUs - sUs) / 1000L)
    } finally {
      extractor.release()
    }
  }
}
