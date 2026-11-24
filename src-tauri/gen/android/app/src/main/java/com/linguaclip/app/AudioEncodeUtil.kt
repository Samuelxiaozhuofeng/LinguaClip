package com.linguaclip.app

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/**
 * Low-level AAC encoding, transcoding, and WAV chunk/header utilities used by MediaBridge.
 */
object AudioEncodeUtil {
  /**
   * Encodes [fromSample, toSample) from a 16kHz mono PCM16 WAV to 32kbps mono AAC .m4a.
   * 1 hour ~= 14.4 MB, safely below Groq's 25 MB limit and supported by Bailian + OpenAI APIs.
   */
  fun compressPieceAac(
    wavPath: String,
    fromSample: Long,
    toSample: Long,
    outM4aPath: String,
    bitrate: Int = 32_000,
    cancelled: (() -> Boolean)? = null,
  ): JSONObject {
    if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
    val (dataAt, totalSamples) = findWavDataChunk(File(wavPath))
    val start = fromSample.coerceIn(0L, totalSamples)
    val end = toSample.coerceIn(start, totalSamples)
    if (end <= start) throw IllegalStateException("audio:empty_piece")

    val dest = File(outM4aPath)
    dest.parentFile?.mkdirs()
    val tmp = File("${dest.absolutePath}.${System.nanoTime()}.tmp") // own name per call: concurrent cuts of one clip

    val encFmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 16000, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
    }
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    val muxer = MediaMuxer(tmp.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var muxerStarted = false
    var trackIdx = -1

    try {
      encoder.configure(encFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()

      RandomAccessFile(wavPath, "r").use { raf ->
        raf.seek(dataAt + start * 2L)
        var remainingBytes = (end - start) * 2L
        var samplesFed = 0L
        var inputDone = false
        var outputDone = false
        val info = MediaCodec.BufferInfo()
        val readBuf = ByteArray(8192)

        while (!outputDone) {
          if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
          var progressed = false
          if (!inputDone) {
            val inIdx = encoder.dequeueInputBuffer(0)
            if (inIdx >= 0) {
              progressed = true
              val inBuf = encoder.getInputBuffer(inIdx)!!
              inBuf.clear()
              if (remainingBytes <= 0L) {
                encoder.queueInputBuffer(inIdx, 0, 0, samplesFed * 1_000_000L / 16000L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                val want = min(min(inBuf.capacity().toLong(), readBuf.size.toLong()), remainingBytes).toInt()
                val n = raf.read(readBuf, 0, want)
                if (n <= 0) {
                  encoder.queueInputBuffer(inIdx, 0, 0, samplesFed * 1_000_000L / 16000L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                  inputDone = true
                } else {
                  inBuf.put(readBuf, 0, n)
                  val pts = samplesFed * 1_000_000L / 16000L
                  samplesFed += n / 2
                  remainingBytes -= n
                  encoder.queueInputBuffer(inIdx, 0, n, pts, 0)
                }
              }
            }
          }

          // Drain all ready AAC output frames non-blockingly so input queue never stalls on 10ms sleeps.
          while (!outputDone) {
            val outIdx = encoder.dequeueOutputBuffer(info, if (progressed) 0L else 2_000L)
            when {
              outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                progressed = true
                trackIdx = muxer.addTrack(encoder.outputFormat)
                muxer.start()
                muxerStarted = true
              }
              outIdx >= 0 -> {
                progressed = true
                val outBuf = encoder.getOutputBuffer(outIdx)
                if (outBuf != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && muxerStarted) {
                  outBuf.position(info.offset)
                  outBuf.limit(info.offset + info.size)
                  muxer.writeSampleData(trackIdx, outBuf, info)
                }
                encoder.releaseOutputBuffer(outIdx, false)
                if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
              }
              else -> break
            }
          }
        }
      }
      if (muxerStarted) {
        muxer.stop()
        muxerStarted = false
      }
      if (dest.exists()) dest.delete()
      if (!tmp.renameTo(dest)) throw IllegalStateException("audio:rename_failed")
    } catch (e: Exception) {
      if (muxerStarted) runCatching { muxer.stop() }
      tmp.delete()
      throw e
    } finally {
      runCatching { encoder.stop() }
      runCatching { encoder.release() }
      runCatching { muxer.release() }
    }

    val durationMs = (end - start) * 1000L / 16000L
    val sizeBytes = dest.length()
    val eqHourMb = if (durationMs > 0) (sizeBytes.toDouble() * 3_600_000.0 / durationMs) / (1024.0 * 1024.0) else 0.0
    return JSONObject()
      .put("path", dest.absolutePath)
      .put("sizeBytes", sizeBytes)
      .put("durationMs", durationMs)
      .put("equivalentHourMb", Math.round(eqHourMb * 100.0) / 100.0)
  }

  fun transcodeTrackToAac(
    extractor: MediaExtractor,
    trackIdx: Int,
    srcFmt: MediaFormat,
    destPath: String,
    bitrate: Int,
    forceMono16k: Boolean,
    startUs: Long = 0L,
    endUs: Long = Long.MAX_VALUE,
    cancelled: (() -> Boolean)? = null,
  ) {
    if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
    val mime = srcFmt.getString(MediaFormat.KEY_MIME)!!
    val sampleRate = if (forceMono16k) 16000 else srcFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    val channels = if (forceMono16k) 1 else srcFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceIn(1, 2)
    extractor.selectTrack(trackIdx)
    if (startUs > 0L) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

    val dest = File(destPath)
    dest.parentFile?.mkdirs()
    val tmp = File("${dest.absolutePath}.${System.nanoTime()}.tmp") // own name per call: concurrent cuts of one clip

    val decoder = MediaCodec.createDecoderByType(mime)
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    val muxer = MediaMuxer(tmp.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var muxerStarted = false
    var outTrack = -1
    try {
      decoder.configure(srcFmt, null, null, 0)
      val encFmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536)
      }
      encoder.configure(encFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      decoder.start()
      encoder.start()

      val decInfo = MediaCodec.BufferInfo()
      val encInfo = MediaCodec.BufferInfo()
      var decInDone = false
      var decOutDone = false
      var encOutDone = false
      var basePts = Long.MIN_VALUE

      while (!encOutDone) {
        if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
        var progressed = false
        if (!decInDone) {
          val inIdx = decoder.dequeueInputBuffer(0)
          if (inIdx >= 0) {
            progressed = true
            val buf = decoder.getInputBuffer(inIdx)!!
            val n = extractor.readSampleData(buf, 0)
            val pts = extractor.sampleTime
            if (n < 0 || (endUs != Long.MAX_VALUE && pts > endUs)) {
              decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              decInDone = true
            } else {
              decoder.queueInputBuffer(inIdx, 0, n, pts.coerceAtLeast(0L), 0)
              extractor.advance()
            }
          }
        }
        if (!decOutDone) {
          val outIdx = decoder.dequeueOutputBuffer(decInfo, if (progressed) 0L else 2_000L)
          if (outIdx >= 0) {
            progressed = true
            val pcm = decoder.getOutputBuffer(outIdx)
            val eos = (decInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
            if (pcm != null && decInfo.size > 0 && (startUs == 0L || decInfo.presentationTimeUs >= startUs)) {
              if (basePts == Long.MIN_VALUE) basePts = decInfo.presentationTimeUs
              pcm.position(decInfo.offset)
              pcm.limit(decInfo.offset + decInfo.size)
              var remaining = decInfo.size
              while (remaining > 0) {
                if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
                val encIn = encoder.dequeueInputBuffer(0)
                if (encIn >= 0) {
                  val eBuf = encoder.getInputBuffer(encIn)!!
                  eBuf.clear()
                  val chunk = min(eBuf.capacity(), remaining)
                  val oldLimit = pcm.limit()
                  pcm.limit(pcm.position() + chunk)
                  eBuf.put(pcm)
                  pcm.limit(oldLimit)
                  remaining -= chunk
                  encoder.queueInputBuffer(encIn, 0, chunk, (decInfo.presentationTimeUs - basePts).coerceAtLeast(0L), 0)
                } else {
                  drainEncoder(encoder, encInfo, muxer, { t -> outTrack = t; muxerStarted = true }, { outTrack }, { muxerStarted }, waitUs = 1_000L)
                }
              }
            }
            decoder.releaseOutputBuffer(outIdx, false)
            if (eos) {
              decOutDone = true
              while (true) {
                if (cancelled?.invoke() == true) throw IllegalStateException("cancelled")
                val encIn = encoder.dequeueInputBuffer(0)
                if (encIn >= 0) {
                  encoder.queueInputBuffer(encIn, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                  break
                }
                drainEncoder(encoder, encInfo, muxer, { t -> outTrack = t; muxerStarted = true }, { outTrack }, { muxerStarted }, waitUs = 1_000L)
              }
            }
          }
        }
        if (drainEncoder(encoder, encInfo, muxer, { t -> outTrack = t; muxerStarted = true }, { outTrack }, { muxerStarted }, waitUs = if (progressed) 0L else 2_000L)) {
          encOutDone = true
        }
      }
      if (muxerStarted) {
        muxer.stop()
        muxerStarted = false
      }
      if (dest.exists()) dest.delete()
      if (!tmp.renameTo(dest)) throw IllegalStateException("audio:rename_failed")
    } catch (e: Exception) {
      if (muxerStarted) runCatching { muxer.stop() }
      tmp.delete()
      throw e
    } finally {
      runCatching { decoder.stop() }
      runCatching { decoder.release() }
      runCatching { encoder.stop() }
      runCatching { encoder.release() }
      runCatching { muxer.release() }
    }
  }

  private fun drainEncoder(
    encoder: MediaCodec,
    encInfo: MediaCodec.BufferInfo,
    muxer: MediaMuxer,
    onStart: (Int) -> Unit,
    getTrack: () -> Int,
    isStarted: () -> Boolean,
    waitUs: Long = 0L,
  ): Boolean {
    var timeout = waitUs
    while (true) {
      val idx = encoder.dequeueOutputBuffer(encInfo, timeout)
      timeout = 0L
      when {
        idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val t = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          onStart(t)
        }
        idx >= 0 -> {
          val buf = encoder.getOutputBuffer(idx)
          if (buf != null && encInfo.size > 0 && (encInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && isStarted()) {
            buf.position(encInfo.offset)
            buf.limit(encInfo.offset + encInfo.size)
            muxer.writeSampleData(getTrack(), buf, encInfo)
          }
          encoder.releaseOutputBuffer(idx, false)
          if ((encInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return true
        }
        else -> return false
      }
    }
  }

  fun findWavDataChunk(file: File): Pair<Long, Long> {
    RandomAccessFile(file, "r").use { raf ->
      val head = ByteArray(12)
      raf.readFully(head)
      if (String(head, 0, 4) != "RIFF" || String(head, 8, 4) != "WAVE") {
        throw IllegalArgumentException("not a wav file")
      }
      var pos = 12L
      val ch = ByteArray(8)
      while (pos + 8 <= raf.length()) {
        raf.seek(pos)
        raf.readFully(ch)
        val tag = String(ch, 0, 4)
        val len = ByteBuffer.wrap(ch, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
        if (tag == "data") return (pos + 8L) to (len / 2L)
        pos += 8L + len + (len and 1L)
      }
      throw IllegalArgumentException("wav missing data chunk")
    }
  }

  fun patchWavHeader(file: File, samples: Long, rate: Int, channels: Int) {
    val dataBytes = samples * channels * 2L
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray())
    header.putInt((36L + dataBytes).toInt())
    header.put("WAVEfmt ".toByteArray())
    header.putInt(16)
    header.putShort(1) // PCM
    header.putShort(channels.toShort())
    header.putInt(rate)
    header.putInt(rate * channels * 2)
    header.putShort((channels * 2).toShort())
    header.putShort(16)
    header.put("data".toByteArray())
    header.putInt(dataBytes.toInt())
    RandomAccessFile(file, "rw").use { raf ->
      raf.seek(0)
      raf.write(header.array())
    }
  }
}
