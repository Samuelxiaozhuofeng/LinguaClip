package com.linguaclip.app

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.math.abs

/**
 * Native Media3 ExoPlayer Foreground Service owning:
 * - Background & lockscreen audio playback with AudioFocus (CONTENT_TYPE_SPEECH) + noisy pause
 * - Edge-triggered 20ms boundary timer for single-sentence loop N times, holdAt replay,
 *   sentence-end autoPause, and multi-section stops
 * - Periodic 150ms playbackTick events & atomic 5s/pause/sectionEnd last-pos persistence
 * - Trusted-only MediaSession custom commands ("记难点", "单句循环") + headset/Bluetooth Prev/Next
 * - Secondary non-focus-stealing ExoPlayer for word pronunciation / Edge TTS
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  companion object {
    const val ACTION_MARK_MISSED = "com.linguaclip.app.ACTION_MARK_MISSED"
    const val ACTION_TOGGLE_LOOP = "com.linguaclip.app.ACTION_TOGGLE_LOOP"
    const val ACTION_NEXT_SENTENCE = "com.linguaclip.app.ACTION_NEXT_SENTENCE"
    const val ACTION_PREV_SENTENCE = "com.linguaclip.app.ACTION_PREV_SENTENCE"

    private const val TICK_INTERVAL_MS = 150L
    private const val LAST_POS_INTERVAL_MS = 5000L
    private const val PULLBACK_MS = 20L

    private val TRUSTED_SYSTEM_PACKAGES = setOf(
      "com.android.systemui",
      "android",
      "com.google.android.projection.gearhead",
      "com.google.android.wearable.app",
    )

    @Volatile
    var instance: PlaybackService? = null
      private set
  }

  inner class LocalBinder : Binder() {
    fun service(): PlaybackService = this@PlaybackService
  }

  private val binder = LocalBinder()
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var store: PlaybackEventStore

  private lateinit var mainPlayer: ExoPlayer
  private lateinit var auxPlayer: ExoPlayer
  private var mediaSession: MediaSession? = null

  private var currentGen: Int = 0
  private var timeline: List<PlaybackEventStore.Cue> = emptyList()
  private var stops: List<Long> = emptyList()
  private var sectionEndMs: Long = -1L
  private var sectionStopDriftMs: Long = -1L
  private var lastFiredStopMs: Long = -1L
  private var holdToMs: Long = -1L
  private var autoPause: Boolean = false
  private var autoPauseCueIdx: Int = -1
  private var loopState: PlaybackEventStore.LoopState? = null
  private var navIds: List<Int>? = null
  private var prevPosMs: Long = 0L
  private var pullbackTargetMs: Long = -1L
  private var lastTickEmitAtMs: Long = 0L
  private var lastPosWriteAtMs: Long = 0L

  private var currentTitle: String = "LinguaClip"
  private var currentArtist: String = ""
  private var currentArtworkUri: String = ""
  private var currentSource: String = ""
  private var currentMediaId: String = ""
  private var resumeMainAfterAux: Boolean = false

  var eventSink: ((String, JSONObject) -> Unit)? = null

  private val gapResumeRunnable = Runnable {
    val lp = loopState ?: return@Runnable
    if (!lp.waitingGap) return@Runnable
    lp.waitingGap = false
    restartFrom(lp.startMs)
    emitState("loop_restart")
  }

  private val pulse = object : Runnable {
    override fun run() {
      checkBoundaries(forceEnded = false)
      if (mainPlayer.isPlaying || (loopState?.waitingGap == true)) {
        handler.postDelayed(this, 20L)
      }
    }
  }

  private fun isTrustedController(session: MediaSession, controller: MediaSession.ControllerInfo): Boolean {
    return controller.packageName == packageName ||
      session.isMediaNotificationController(controller) ||
      controller.isTrusted ||
      controller.packageName in TRUSTED_SYSTEM_PACKAGES
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    store = PlaybackEventStore(filesDir)

    val speechAttrs = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
      .build()

    mainPlayer = ExoPlayer.Builder(this)
      .setAudioAttributes(speechAttrs, /* handleAudioFocus = */ true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_LOCAL)
      .build()

    // Secondary player for dictionary voice / Edge TTS: never steals AudioFocus or drops notification.
    auxPlayer = ExoPlayer.Builder(this)
      .setAudioAttributes(speechAttrs, /* handleAudioFocus = */ false)
      .build()

    mainPlayer.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        handler.removeCallbacks(pulse)
        if (isPlaying) {
          handler.post(pulse)
        } else if (currentMediaId.isNotBlank() && mainPlayer.currentPosition > 0L) {
          persistLastPosNow(mainPlayer.currentPosition)
        }
        emitState(if (isPlaying) "playing" else "paused")
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) {
          val handled = checkBoundaries(forceEnded = true)
          if (!handled) {
            emitState("ended")
          }
        } else if (playbackState == Player.STATE_READY) {
          emitState("ready")
        }
      }

      override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
        handler.removeCallbacks(pulse)
        handler.removeCallbacks(gapResumeRunnable)
        loopState = null
        emit(
          "playbackError",
          withMeta(
            JSONObject()
              .put("errorCode", error.errorCode)
              .put("message", error.message ?: "playback_error"),
          ),
        )
      }

      override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
      ) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
          val pos = newPosition.positionMs.coerceAtLeast(0L)
          if (pullbackTargetMs >= 0L && abs(pos - pullbackTargetMs) < 500L) {
            pullbackTargetMs = -1L
          } else {
            pullbackTargetMs = -1L
            autoPauseCueIdx = store.findNextPauseCueIndex(timeline, pos)
          }
          prevPosMs = pos
        }
      }
    })

    auxPlayer.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED || playbackState == Player.STATE_IDLE) {
          val shouldResume = resumeMainAfterAux
          resumeMainAfterAux = false
          emit("auxEnded", withMeta(JSONObject().put("resumeMain", shouldResume)))
        }
      }
    })

    val wrappedPlayer = object : ForwardingPlayer(mainPlayer) {
      override fun getAvailableCommands(): Player.Commands {
        return super.getAvailableCommands().buildUpon()
          .add(COMMAND_SEEK_TO_NEXT)
          .add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
          .add(COMMAND_SEEK_TO_PREVIOUS)
          .add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
          .build()
      }

      override fun isCommandAvailable(command: Int): Boolean {
        return when (command) {
          COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
          COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> true
          else -> super.isCommandAvailable(command)
        }
      }

      override fun seekToNext() = jumpSentence(+1)
      override fun seekToNextMediaItem() = jumpSentence(+1)
      override fun seekToPrevious() = jumpSentence(-1)
      override fun seekToPreviousMediaItem() = jumpSentence(-1)
    }

    val markCmd = SessionCommand(ACTION_MARK_MISSED, Bundle.EMPTY)
    val loopCmd = SessionCommand(ACTION_TOGGLE_LOOP, Bundle.EMPTY)

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val sessionActivity = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val sessionBuilder = MediaSession.Builder(this, wrappedPlayer)
      .setCallback(object : MediaSession.Callback {
        override fun onConnect(
          session: MediaSession,
          controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
          val builder = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
          if (isTrustedController(session, controller)) {
            builder.add(markCmd).add(loopCmd)
          }
          return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
            .setAvailableSessionCommands(builder.build())
            .build()
        }

        override fun onCustomCommand(
          session: MediaSession,
          controller: MediaSession.ControllerInfo,
          customCommand: SessionCommand,
          args: Bundle,
        ): ListenableFuture<SessionResult> {
          if (!isTrustedController(session, controller)) {
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_PERMISSION_DENIED))
          }
          when (customCommand.customAction) {
            ACTION_MARK_MISSED -> handleMarkMissed()
            ACTION_TOGGLE_LOOP -> handleToggleLoop()
          }
          return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        override fun onMediaButtonEvent(
          session: MediaSession,
          controllerInfo: MediaSession.ControllerInfo,
          intent: Intent,
        ): Boolean {
          if (!isTrustedController(session, controllerInfo)) {
            return false
          }
          @Suppress("DEPRECATION")
          val ev = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
          if (ev != null) {
            // Preserve Media3 default single/double-tap handling for HEADSETHOOK / MEDIA_PLAY_PAUSE
            // (double-tap routes to ForwardingPlayer.seekToNext() -> jumpSentence(+1)).
            when (ev.keyCode) {
              KeyEvent.KEYCODE_MEDIA_NEXT -> {
                if (ev.action == KeyEvent.ACTION_DOWN && ev.repeatCount == 0) {
                  jumpSentence(+1)
                }
                return true
              }
              KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                if (ev.action == KeyEvent.ACTION_DOWN && ev.repeatCount == 0) {
                  jumpSentence(-1)
                }
                return true
              }
            }
          }
          return super.onMediaButtonEvent(session, controllerInfo, intent)
        }
      })

    if (sessionActivity != null) sessionBuilder.setSessionActivity(sessionActivity)
    mediaSession = sessionBuilder.build()
    updateCustomLayout()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

  override fun onBind(intent: Intent?): IBinder? {
    return if (intent?.action == null) binder else super.onBind(intent)
  }

  override fun onDestroy() {
    if (currentMediaId.isNotBlank() && mainPlayer.currentPosition > 0L) {
      persistLastPosNow(mainPlayer.currentPosition)
    }
    handler.removeCallbacksAndMessages(null)
    mediaSession?.release()
    mediaSession = null
    auxPlayer.release()
    mainPlayer.release()
    store.shutdown()
    instance = null
    super.onDestroy()
  }

  private fun updateCustomLayout() {
    val session = mediaSession ?: return
    val markBtn = CommandButton.Builder()
      .setDisplayName("记难点")
      .setIconResId(R.drawable.ic_mark_missed)
      .setSessionCommand(SessionCommand(ACTION_MARK_MISSED, Bundle.EMPTY))
      .build()
    val loopBtn = CommandButton.Builder()
      .setDisplayName(if (loopState != null) "取消循环" else "单句循环")
      .setIconResId(R.drawable.ic_loop_sentence)
      .setSessionCommand(SessionCommand(ACTION_TOGGLE_LOOP, Bundle.EMPTY))
      .build()
    session.setCustomLayout(ImmutableList.of(markBtn, loopBtn))
  }

  private fun restartFrom(positionMs: Long) {
    val target = positionMs.coerceAtLeast(0L)
    if (mainPlayer.playbackState == Player.STATE_IDLE) mainPlayer.prepare()
    pullbackTargetMs = -1L
    prevPosMs = target
    mainPlayer.seekTo(target)
    mainPlayer.playWhenReady = true
    handler.removeCallbacks(pulse)
    handler.post(pulse)
  }

  private fun pullBackAndPause(targetMs: Long): Long {
    val clamped = targetMs.coerceAtLeast(0L)
    mainPlayer.playWhenReady = false
    pullbackTargetMs = clamped
    prevPosMs = clamped
    mainPlayer.seekTo(clamped)
    return clamped
  }

  private fun persistLastPosNow(posMs: Long) {
    if (currentMediaId.isBlank() || posMs < 0L) return
    lastPosWriteAtMs = SystemClock.elapsedRealtime()
    store.writeLastPos(currentMediaId, posMs)
  }

  fun load(
    source: String,
    title: String,
    artist: String,
    startMs: Long = 0L,
    autoPlay: Boolean = false,
    mediaId: String = "",
    cues: List<PlaybackEventStore.Cue>? = null,
    stopsMs: List<Long>? = null,
    rate: Float? = null,
    artworkUri: String = "",
  ) {
    handler.removeCallbacks(gapResumeRunnable)
    handler.removeCallbacks(pulse)
    currentGen++

    // Atomically clear all per-episode playback state to prevent cross-episode bleed.
    timeline = cues ?: emptyList()
    loopState = null
    stops = stopsMs?.filter { it > 0L }?.distinct()?.sorted() ?: emptyList()
    val clampedStart = startMs.coerceAtLeast(0L)
    sectionEndMs = stops.firstOrNull { it > clampedStart } ?: stops.lastOrNull() ?: -1L
    sectionStopDriftMs = -1L
    lastFiredStopMs = -1L
    holdToMs = -1L
    autoPause = false
    navIds = null
    pullbackTargetMs = -1L
    lastTickEmitAtMs = 0L
    lastPosWriteAtMs = 0L

    currentSource = source
    currentMediaId = mediaId.ifBlank { source }
    currentTitle = title.ifBlank { "LinguaClip" }
    currentArtist = artist
    currentArtworkUri = artworkUri

    val metaBuilder = MediaMetadata.Builder()
      .setTitle(currentTitle)
      .setArtist(currentArtist)
    if (artworkUri.isNotBlank()) {
      runCatching { Uri.parse(artworkUri) }.getOrNull()?.let { metaBuilder.setArtworkUri(it) }
    }

    val item = MediaItem.Builder()
      .setUri(toUri(source))
      .setMediaMetadata(metaBuilder.build())
      .build()
    mainPlayer.setMediaItem(item)
    mainPlayer.prepare()
    if (rate != null) {
      mainPlayer.setPlaybackSpeed(rate.coerceIn(0.5f, 2.5f))
    }
    if (clampedStart > 0L) mainPlayer.seekTo(clampedStart)
    prevPosMs = clampedStart
    autoPauseCueIdx = store.findNextPauseCueIndex(timeline, clampedStart)
    mainPlayer.playWhenReady = autoPlay
    updateCustomLayout()
    emitState("loaded")
  }

  fun play() {
    handler.removeCallbacks(gapResumeRunnable)
    loopState?.waitingGap = false
    if (mainPlayer.playbackState == Player.STATE_ENDED) {
      val restart = (loopState?.startMs ?: 0L).coerceAtLeast(0L)
      pullbackTargetMs = -1L
      prevPosMs = restart
      mainPlayer.seekTo(restart)
    }
    mainPlayer.playWhenReady = true
    handler.removeCallbacks(pulse)
    handler.post(pulse)
  }

  fun pause() {
    handler.removeCallbacks(gapResumeRunnable)
    loopState?.waitingGap = false
    mainPlayer.playWhenReady = false
    persistLastPosNow(mainPlayer.currentPosition)
  }

  fun seek(positionMs: Long) {
    handler.removeCallbacks(gapResumeRunnable)
    loopState?.waitingGap = false
    holdToMs = -1L
    lastFiredStopMs = -1L
    pullbackTargetMs = -1L
    val clamped = positionMs.coerceAtLeast(0L)
    prevPosMs = clamped
    mainPlayer.seekTo(clamped)
    autoPauseCueIdx = store.findNextPauseCueIndex(timeline, clamped)
    emitState("seeked")
  }

  fun setRate(rate: Float) {
    mainPlayer.setPlaybackSpeed(rate.coerceIn(0.5f, 2.5f))
    emitState("rate")
  }

  fun setTimeline(cues: List<PlaybackEventStore.Cue>, sectionEnd: Long = -1L) {
    timeline = cues
    sectionEndMs = sectionEnd
    stops = if (sectionEnd > 0L) listOf(sectionEnd) else emptyList()
    sectionStopDriftMs = -1L
    lastFiredStopMs = -1L
    autoPauseCueIdx = store.findNextPauseCueIndex(timeline, mainPlayer.currentPosition)
  }

  fun setSectionEnd(endMs: Long) {
    sectionEndMs = endMs
    stops = if (endMs > 0L) listOf(endMs) else emptyList()
    sectionStopDriftMs = -1L
    lastFiredStopMs = -1L
  }

  fun setStops(stopsMs: List<Long>) {
    stops = stopsMs.filter { it > 0L }.distinct().sorted()
    val pos = mainPlayer.currentPosition
    sectionEndMs = stops.firstOrNull { it > pos } ?: stops.lastOrNull() ?: -1L
    sectionStopDriftMs = -1L
    lastFiredStopMs = -1L
  }

  fun holdAt(endMs: Long?) {
    holdToMs = if (endMs != null && endMs > 0L) endMs else -1L
  }

  fun setNav(lineIds: List<Int>?) {
    navIds = lineIds?.takeIf { it.isNotEmpty() }
  }

  fun setAutoPause(enabled: Boolean) {
    autoPause = enabled
    pullbackTargetMs = -1L
    autoPauseCueIdx = store.findNextPauseCueIndex(timeline, mainPlayer.currentPosition)
  }

  fun setLoop(startMs: Long, endMs: Long, count: Int, gapMs: Long = 300L) {
    handler.removeCallbacks(gapResumeRunnable)
    holdToMs = -1L
    lastFiredStopMs = -1L
    pullbackTargetMs = -1L
    if (endMs <= startMs) {
      loopState = null
      updateCustomLayout()
      emitState("loop_cleared")
      return
    }
    val clampedStart = startMs.coerceAtLeast(0L)
    loopState = PlaybackEventStore.LoopState(
      startMs = clampedStart,
      endMs = endMs,
      remaining = if (count <= 0) -1 else (count - 1).coerceAtLeast(0),
      gapMs = gapMs.coerceIn(0L, 5000L),
      initialCount = if (count <= 0) 0 else count,
    )
    prevPosMs = clampedStart
    mainPlayer.seekTo(clampedStart)
    updateCustomLayout()
    emitState("loop_set")
  }

  fun clearLoop() {
    handler.removeCallbacks(gapResumeRunnable)
    loopState = null
    updateCustomLayout()
    emitState("loop_cleared")
  }

  fun getLastPos(): JSONObject? = store.readLastPos()

  fun clearLastPos() {
    store.clearLastPos()
  }

  fun playAux(source: String, pauseMain: Boolean = true) {
    if (!auxPlayer.isPlaying) {
      if (pauseMain && mainPlayer.isPlaying) {
        resumeMainAfterAux = true
        mainPlayer.playWhenReady = false
      } else {
        resumeMainAfterAux = false
      }
    }
    auxPlayer.setMediaItem(MediaItem.fromUri(toUri(source)))
    auxPlayer.prepare()
    auxPlayer.playWhenReady = true
    emit("auxStarted", withMeta(JSONObject().put("source", source)))
  }

  fun playAuxBytes(bytes: ByteArray, ext: String = "mp3", pauseMain: Boolean = false) {
    if (bytes.isEmpty() || bytes.size > 2 * 1024 * 1024) {
      throw IllegalArgumentException("aux:bad_size")
    }
    val safeExt = ext.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }.ifEmpty { "mp3" }
    auxPlayer.stop()
    val tmp = File(cacheDir, "aux_word.tmp")
    val dst = File(cacheDir, "aux_word.$safeExt")
    tmp.writeBytes(bytes)
    if (!tmp.renameTo(dst)) {
      tmp.delete()
      throw IllegalStateException("aux:rename_failed")
    }
    playAux(dst.absolutePath, pauseMain)
  }

  fun stopAux() {
    resumeMainAfterAux = false
    auxPlayer.stop()
  }

  fun triggerCustomAction(action: String): JSONObject {
    return when (action) {
      ACTION_MARK_MISSED, "mark_missed" -> handleMarkMissed()
      ACTION_TOGGLE_LOOP, "toggle_loop" -> {
        handleToggleLoop()
        snapshot()
      }
      ACTION_NEXT_SENTENCE, "next" -> {
        jumpSentence(+1)
        snapshot()
      }
      ACTION_PREV_SENTENCE, "prev" -> {
        jumpSentence(-1)
        snapshot()
      }
      else -> throw IllegalArgumentException("unknown action: $action")
    }
  }

  private fun checkBoundaries(forceEnded: Boolean): Boolean {
    if (!forceEnded && !mainPlayer.isPlaying) return false
    val pos = mainPlayer.currentPosition.coerceAtLeast(0L)
    val dur = mainPlayer.duration.takeIf { it > 0L } ?: pos
    val prev = prevPosMs

    // Reset lastFiredStopMs once playback has clearly moved away from the previous stop point.
    if (lastFiredStopMs > 0L && (pos > lastFiredStopMs + 100L || pos < lastFiredStopMs - 250L)) {
      lastFiredStopMs = -1L
    }

    // 1. One-shot holdAt ("listen again" inside "see this line")
    if (holdToMs > 0L) {
      val target = holdToMs
      val crossed = (prev < target && pos >= target) || (forceEnded && prev < target)
      if (crossed) {
        val effectiveEnd = if (forceEnded && target > dur) dur else target
        val drift = abs(pos - effectiveEnd)
        holdToMs = -1L
        val back = pullBackAndPause(effectiveEnd - PULLBACK_MS)
        emit(
          "holdEnded",
          withMeta(
            JSONObject()
              .put("positionMs", back)
              .put("holdToMs", target)
              .put("driftMs", drift),
          ),
        )
        return true
      }
    }

    // 2. Active single-sentence loop (drill or free-mode loop)
    val lp = loopState
    if (lp != null && !lp.waitingGap) {
      val crossed = (prev < lp.endMs && pos >= lp.endMs) || (forceEnded && dur >= lp.startMs && prev < lp.endMs)
      if (crossed) {
        val effectiveEnd = if (forceEnded && lp.endMs > dur) dur else lp.endMs
        val drift = abs(pos - effectiveEnd)
        lp.lastDriftMs = drift
        if (drift > lp.maxDriftMs) lp.maxDriftMs = drift
        lp.completedLoops++
        val back = (effectiveEnd - PULLBACK_MS).coerceAtLeast(lp.startMs)
        if (lp.remaining == 0) {
          pullBackAndPause(back)
          loopState = null
          updateCustomLayout()
          emit(
            "loopCompleted",
            withMeta(
              JSONObject()
                .put("completedLoops", lp.completedLoops)
                .put("maxDriftMs", lp.maxDriftMs)
                .put("lastDriftMs", lp.lastDriftMs)
                .put("positionMs", back),
            ),
          )
          return true
        }
        if (lp.remaining > 0) lp.remaining--
        if (lp.gapMs > 0L) {
          lp.waitingGap = true
          pullBackAndPause(back)
          handler.removeCallbacks(gapResumeRunnable)
          handler.postDelayed(gapResumeRunnable, lp.gapMs)
          emit(
            "loopTick",
            withMeta(
              JSONObject()
                .put("completedLoops", lp.completedLoops)
                .put("remaining", lp.remaining)
                .put("driftMs", drift)
                .put("maxDriftMs", lp.maxDriftMs)
                .put("positionMs", back),
            ),
          )
        } else {
          emit(
            "loopTick",
            withMeta(
              JSONObject()
                .put("completedLoops", lp.completedLoops)
                .put("remaining", lp.remaining)
                .put("driftMs", drift)
                .put("maxDriftMs", lp.maxDriftMs)
                .put("positionMs", back),
            ),
          )
          restartFrom(lp.startMs)
        }
        return true
      }
    }

    // 3. Section-end stops (edge-triggered; supports multiple section boundaries)
    if (stops.isNotEmpty()) {
      val hitStop = stops.firstOrNull { stop ->
        stop != lastFiredStopMs && (
          (prev < stop && pos >= stop) ||
            (forceEnded && prev < stop && stop <= dur + 500L)
          )
      }
      if (hitStop != null) {
        val effectiveEnd = if (forceEnded && hitStop > dur) dur else hitStop
        sectionEndMs = hitStop
        sectionStopDriftMs = abs(pos - effectiveEnd)
        lastFiredStopMs = hitStop
        val back = pullBackAndPause(effectiveEnd - PULLBACK_MS)
        persistLastPosNow(back)
        emit(
          "sectionEnded",
          withMeta(
            JSONObject()
              .put("positionMs", back)
              .put("sectionEndMs", hitStop)
              .put("driftMs", sectionStopDriftMs),
          ),
        )
        return true
      }
    }

    // 4. Sentence-end autoPause (edge-triggered)
    if (autoPause && timeline.isNotEmpty() && autoPauseCueIdx in timeline.indices) {
      val cue = timeline[autoPauseCueIdx]
      val crossed = (prev < cue.endMs && pos >= cue.endMs) || (forceEnded && prev < cue.endMs)
      if (crossed) {
        val pausedIdx = autoPauseCueIdx
        val effectiveEnd = if (forceEnded && cue.endMs > dur) dur else cue.endMs
        val drift = abs(pos - effectiveEnd)
        autoPauseCueIdx = if (pausedIdx + 1 < timeline.size) pausedIdx + 1 else -1
        val back = pullBackAndPause((effectiveEnd - PULLBACK_MS).coerceAtLeast(cue.startMs))
        emit(
          "sentencePaused",
          withMeta(
            JSONObject()
              .put("index", pausedIdx)
              .put("lineId", cue.id)
              .put("positionMs", back)
              .put("driftMs", drift),
          ),
        )
        return true
      }
    }

    prevPosMs = pos

    if (!forceEnded) {
      val nowElapsed = SystemClock.elapsedRealtime()
      if (nowElapsed - lastTickEmitAtMs >= TICK_INTERVAL_MS) {
        lastTickEmitAtMs = nowElapsed
        emit(
          "playbackTick",
          JSONObject()
            .put("mediaId", currentMediaId)
            .put("gen", currentGen)
            .put("positionMs", pos)
            .put("durationMs", dur.coerceAtLeast(0L))
            .put("playing", mainPlayer.isPlaying)
            .put("cueIndex", store.findCueIndex(timeline, pos)),
        )
      }
      if (nowElapsed - lastPosWriteAtMs >= LAST_POS_INTERVAL_MS && currentMediaId.isNotBlank() && pos > 0L) {
        persistLastPosNow(pos)
      }
    }
    return false
  }

  private fun jumpSentence(delta: Int) {
    if (timeline.isEmpty()) {
      seek((mainPlayer.currentPosition + delta * 5000L).coerceAtLeast(0L))
      return
    }
    val lp = loopState
    val wasActive = mainPlayer.isPlaying || mainPlayer.playWhenReady || (lp?.waitingGap == true)
    val next = store.findJumpIndex(timeline, mainPlayer.currentPosition, lp, navIds, delta)
    if (next !in timeline.indices) return
    val cue = timeline[next]
    if (lp != null) {
      setLoop(cue.startMs, cue.endMs, count = lp.initialCount, gapMs = lp.gapMs)
      if (wasActive) {
        mainPlayer.playWhenReady = true
        handler.removeCallbacks(pulse)
        handler.post(pulse)
      }
    } else {
      seek(cue.startMs)
      if (wasActive) {
        mainPlayer.playWhenReady = true
        handler.removeCallbacks(pulse)
        handler.post(pulse)
      }
    }
    emit(
      "sentenceJumped",
      withMeta(
        JSONObject()
          .put("index", next)
          .put("lineId", cue.id)
          .put("startMs", cue.startMs)
          .put("delta", delta),
      ),
    )
  }

  private fun handleMarkMissed(): JSONObject {
    val pos = mainPlayer.currentPosition.coerceAtLeast(0L)
    val idx = store.findMarkCueIndex(timeline, pos, loopState, mainPlayer.isPlaying)
    val cue = if (idx in timeline.indices) timeline[idx] else null
    val ev = withMeta(
      JSONObject()
        .put("id", UUID.randomUUID().toString())
        .put("type", "mark_missed")
        .put("source", currentSource)
        .put("index", idx)
        .put("lineId", cue?.id ?: -1)
        .put("startMs", cue?.startMs ?: pos)
        .put("endMs", cue?.endMs ?: (pos + 2000L))
        .put("positionMs", pos)
        .put("text", cue?.text ?: "")
        .put("ts", System.currentTimeMillis()),
    )
    store.appendEvent(ev)
    emit("bgEvent", ev)
    return ev
  }

  private fun handleToggleLoop() {
    if (loopState != null) {
      clearLoop()
      return
    }
    val idx = store.findCueIndex(timeline, mainPlayer.currentPosition)
    if (idx in timeline.indices) {
      val cue = timeline[idx]
      setLoop(cue.startMs, cue.endMs, count = 0, gapMs = 300L)
    }
  }

  fun peekBgEvents(): JSONArray = store.peekEvents()

  fun ackBgEvents(ids: Set<String>): Int = store.ackEvents(ids)

  fun snapshot(): JSONObject {
    val lp = loopState
    val obj = JSONObject()
      .put("playing", mainPlayer.isPlaying)
      .put("playbackState", mainPlayer.playbackState)
      .put("positionMs", mainPlayer.currentPosition.coerceAtLeast(0L))
      .put("durationMs", mainPlayer.duration.coerceAtLeast(0L))
      .put("rate", mainPlayer.playbackParameters.speed.toDouble())
      .put("mediaId", currentMediaId)
      .put("gen", currentGen)
      .put("source", currentSource)
      .put("cueIndex", store.findCueIndex(timeline, mainPlayer.currentPosition))
      .put("timelineSize", timeline.size)
      .put("sectionEndMs", sectionEndMs)
      .put("sectionStopDriftMs", sectionStopDriftMs)
      .put("holdToMs", holdToMs)
      .put("autoPause", autoPause)
      .put("autoPauseCueIdx", autoPauseCueIdx)
      .put("auxPlaying", auxPlayer.isPlaying)
      .put("hasMediaSession", mediaSession != null)
    if (lp != null) {
      obj.put(
        "loop",
        JSONObject()
          .put("startMs", lp.startMs)
          .put("endMs", lp.endMs)
          .put("remaining", lp.remaining)
          .put("completedLoops", lp.completedLoops)
          .put("maxDriftMs", lp.maxDriftMs)
          .put("lastDriftMs", lp.lastDriftMs)
          .put("waitingGap", lp.waitingGap),
      )
    }
    return obj
  }

  private fun toUri(source: String): Uri =
    if (source.startsWith("http://") || source.startsWith("https://") || source.startsWith("content://") || source.startsWith("file://")) {
      Uri.parse(source)
    } else {
      Uri.fromFile(File(source))
    }

  private fun withMeta(obj: JSONObject): JSONObject =
    obj.put("mediaId", currentMediaId).put("gen", currentGen)

  private fun emitState(reason: String) {
    emit("playbackState", snapshot().put("reason", reason))
  }

  private fun emit(name: String, payload: JSONObject) {
    eventSink?.invoke(name, payload)
  }
}
