package com.linguaclip.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground dataSync service protecting long-running media extraction, decoding, AAC compression,
 * and cloud transcription against Android background process kills.
 *
 * Owns its own single-thread executor (independent of LinguaBridge.io, which shuts down with Activity),
 * a bounded PARTIAL_WAKE_LOCK, per-job AtomicBoolean cancellation flags, and an ongoing notification
 * with a Cancel action button.
 */
class MediaProcessingService : Service() {
  data class JobState(
    val jobId: String,
    val title: String,
    val detail: String,
    val percent: Int,
  )

  companion object {
    const val CHANNEL_ID = "linguaclip_processing"
    const val NOTIF_ID = 4202
    const val ACTION_START = "com.linguaclip.app.ACTION_PROCESSING_START"
    const val ACTION_CANCEL_JOB = "com.linguaclip.app.ACTION_CANCEL_JOB"
    const val EXTRA_JOB_ID = "jobId"
    const val EXTRA_TITLE = "title"
    const val EXTRA_DETAIL = "detail"
    const val EXTRA_PERCENT = "percent"

    private const val WAKELOCK_TIMEOUT_MS = 30L * 60L * 1000L

    @Volatile
    var instance: MediaProcessingService? = null
      private set

    @Volatile
    var eventSink: ((String, JSONObject) -> Unit)? = null

    private val readyLock = Any()
    private val readyLatches = mutableListOf<CountDownLatch>()

    fun ensureStarted(
      context: Context,
      jobId: String? = null,
      title: String? = null,
      detail: String? = null,
      percent: Int = -1,
    ): MediaProcessingService {
      instance?.takeIf { !it.isStopping() }?.let { return it }
      val latch = CountDownLatch(1)
      synchronized(readyLock) {
        instance?.takeIf { !it.isStopping() }?.let { return it }
        readyLatches.add(latch)
      }
      val appCtx = context.applicationContext
      val intent = Intent(appCtx, MediaProcessingService::class.java).apply {
        action = ACTION_START
        if (!jobId.isNullOrBlank()) putExtra(EXTRA_JOB_ID, jobId)
        if (!title.isNullOrBlank()) putExtra(EXTRA_TITLE, title)
        if (!detail.isNullOrBlank()) putExtra(EXTRA_DETAIL, detail)
        putExtra(EXTRA_PERCENT, percent)
      }
      try {
        ContextCompat.startForegroundService(appCtx, intent)
      } catch (e: Exception) {
        synchronized(readyLock) { readyLatches.remove(latch) }
        throw IllegalStateException("interrupted", e)
      }
      latch.await(5, TimeUnit.SECONDS)
      return instance?.takeIf { !it.isStopping() }
        ?: throw IllegalStateException("processing:service_unavailable")
    }
  }

  private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "lc-media-proc")
  }
  private val stateLock = Any()
  private val activeJobs = ConcurrentHashMap<String, JobState>()
  private val cancelledFlags = ConcurrentHashMap<String, AtomicBoolean>()
  private val jobTmpFiles = ConcurrentHashMap<String, MutableSet<String>>()
  private var wakeLock: PowerManager.WakeLock? = null
  private var inForeground = false
  @Volatile
  private var stopping = false

  fun isStopping(): Boolean = stopping

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    stopping = false
    instance = this
    synchronized(readyLock) {
      readyLatches.forEach { it.countDown() }
      readyLatches.clear()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CANCEL_JOB -> {
        val targetId = intent.getStringExtra(EXTRA_JOB_ID)
        if (!targetId.isNullOrBlank()) {
          cancelJob(targetId, emitEvent = true)
        } else {
          val ids = activeJobs.keys.toList()
          if (ids.isEmpty()) {
            stopServiceIfIdle()
          } else {
            ids.forEach { cancelJob(it, emitEvent = true) }
          }
        }
        return START_NOT_STICKY
      }
      else -> {
        val jobId = intent?.getStringExtra(EXTRA_JOB_ID)
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.app_name)
        val detail = intent?.getStringExtra(EXTRA_DETAIL) ?: ""
        val percent = intent?.getIntExtra(EXTRA_PERCENT, -1) ?: -1
        synchronized(stateLock) {
          val display = activeJobs.values.firstOrNull() ?: JobState(jobId ?: "", title, detail, percent)
          if (!startForegroundSafe(buildNotification(display))) {
            return START_NOT_STICKY
          }
          acquireWakeLockLocked()
        }
        return START_NOT_STICKY
      }
    }
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    val ids = activeJobs.keys.toList()
    val arr = JSONArray()
    for (id in ids) {
      arr.put(id)
      cancelledFlags.computeIfAbsent(id) { AtomicBoolean(false) }.set(true)
      cleanupJobTemps(id)
    }
    synchronized(stateLock) {
      activeJobs.clear()
      releaseWakeLockLocked()
      stopForegroundCompat()
      stopping = true
      if (instance === this) instance = null
    }
    emit("processingTimeout", JSONObject().put("fgsType", fgsType).put("jobIds", arr))
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app from Recents destroys the WebView that drives multi-step imports;
    // cancel active jobs and release foreground service + WakeLock so notifications never stick.
    val ids = activeJobs.keys.toList()
    for (id in ids) {
      cancelledFlags.computeIfAbsent(id) { AtomicBoolean(false) }.set(true)
      cleanupJobTemps(id)
    }
    synchronized(stateLock) {
      activeJobs.clear()
      releaseWakeLockLocked()
      stopForegroundCompat()
      stopping = true
      if (instance === this) instance = null
    }
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    synchronized(stateLock) {
      stopping = true
      activeJobs.keys.forEach { id ->
        cancelledFlags.computeIfAbsent(id) { AtomicBoolean(false) }.set(true)
      }
      activeJobs.clear()
      releaseWakeLockLocked()
      inForeground = false
    }
    if (instance === this) {
      instance = null
    }
    worker.shutdownNow()
    super.onDestroy()
  }

  fun beginJob(jobId: String, title: String, detail: String, percent: Int): JSONObject {
    synchronized(stateLock) {
      if (stopping) throw IllegalStateException("processing:service_unavailable")
      cancelledFlags[jobId] = AtomicBoolean(false)
      val state = JobState(jobId, title.ifBlank { getString(R.string.app_name) }, detail, percent)
      activeJobs[jobId] = state
      if (!startForegroundSafe(buildNotification(state))) {
        throw IllegalStateException("interrupted")
      }
      acquireWakeLockLocked()
    }
    return JSONObject().put("ok", true).put("jobId", jobId)
  }

  fun updateJob(jobId: String, title: String?, detail: String?, percent: Int?): JSONObject {
    synchronized(stateLock) {
      // Never resurrect a cancelled or finished job from a late async progress callback.
      val prev = activeJobs[jobId] ?: return JSONObject().put("ok", false).put("ignored", true)
      val next = JobState(
        jobId = jobId,
        title = title?.takeIf { it.isNotBlank() } ?: prev.title,
        detail = detail ?: prev.detail,
        percent = percent ?: prev.percent,
      )
      activeJobs[jobId] = next
      val notif = buildNotification(next)
      if (!inForeground) {
        if (!startForegroundSafe(notif)) {
          return JSONObject().put("ok", false).put("ignored", true)
        }
      } else {
        notifyManager().notify(NOTIF_ID, notif)
      }
      acquireWakeLockLocked()
    }
    return JSONObject().put("ok", true).put("jobId", jobId)
  }

  fun reconcileJobs(keepIds: Set<String>): JSONObject {
    var removed = 0
    synchronized(stateLock) {
      val stale = activeJobs.keys.filter { it !in keepIds }
      for (id in stale) {
        cancelledFlags.computeIfAbsent(id) { AtomicBoolean(false) }.set(true)
        cleanupJobTemps(id)
        activeJobs.remove(id)
        removed++
      }
      if (stale.isNotEmpty() || activeJobs.isEmpty()) {
        refreshOrStopLocked()
      }
    }
    return JSONObject().put("ok", true).put("removed", removed)
  }

  fun endJob(jobId: String): JSONObject {
    synchronized(stateLock) {
      activeJobs.remove(jobId)
      cancelledFlags.remove(jobId)
      jobTmpFiles.remove(jobId)
      refreshOrStopLocked()
    }
    return JSONObject().put("ok", true).put("jobId", jobId)
  }

  fun cancelJob(jobId: String, emitEvent: Boolean = true): JSONObject {
    cancelledFlags.computeIfAbsent(jobId) { AtomicBoolean(false) }.set(true)
    cleanupJobTemps(jobId)
    synchronized(stateLock) {
      activeJobs.remove(jobId)
      refreshOrStopLocked()
    }
    if (emitEvent) {
      emit("processingCancelled", JSONObject().put("jobId", jobId))
    }
    return JSONObject().put("ok", true).put("jobId", jobId)
  }

  fun isCancelled(jobId: String): Boolean = cancelledFlags[jobId]?.get() == true

  fun runOnWorker(
    jobId: String,
    tempCandidates: List<String>,
    task: (isCancelled: () -> Boolean) -> JSONObject,
  ): JSONObject {
    if (!activeJobs.containsKey(jobId) || isCancelled(jobId)) throw IllegalStateException("cancelled")
    val set = jobTmpFiles.computeIfAbsent(jobId) { ConcurrentHashMap.newKeySet() }
    set.addAll(tempCandidates)
    val future = try {
      worker.submit<JSONObject> {
        val check: () -> Boolean = { isCancelled(jobId) }
        if (check()) throw IllegalStateException("cancelled")
        try {
          task(check)
        } catch (e: Throwable) {
          if (check() || e.message == "cancelled") {
            cleanupFiles(tempCandidates)
          }
          throw e
        } finally {
          jobTmpFiles[jobId]?.removeAll(tempCandidates.toSet())
        }
      }
    } catch (e: java.util.concurrent.RejectedExecutionException) {
      throw IllegalStateException("interrupted", e)
    }
    return try {
      future.get()
    } catch (e: ExecutionException) {
      throw (e.cause ?: e)
    } catch (e: InterruptedException) {
      // Do NOT cancel the background worker if the Activity/LinguaBridge thread was interrupted.
      Thread.currentThread().interrupt()
      throw IllegalStateException("interrupted")
    }
  }

  private fun cleanupJobTemps(jobId: String) {
    val paths = jobTmpFiles.remove(jobId) ?: return
    cleanupFiles(paths)
  }

  private fun cleanupFiles(paths: Collection<String>) {
    val ownRoot = runCatching { filesDir.canonicalFile.path }.getOrNull() ?: return
    for (p in paths) {
      runCatching {
        val f = File(p).canonicalFile
        if (f.path.startsWith(ownRoot + File.separator) && f.isFile) {
          f.delete()
        }
      }
    }
  }

  private fun refreshOrStopLocked() {
    val next = activeJobs.values.firstOrNull()
    if (next == null) {
      releaseWakeLockLocked()
      stopForegroundCompat()
      stopping = true
      if (instance === this) instance = null
      stopSelf()
    } else {
      notifyManager().notify(NOTIF_ID, buildNotification(next))
    }
  }

  private fun stopServiceIfIdle() {
    synchronized(stateLock) {
      if (activeJobs.isEmpty()) {
        releaseWakeLockLocked()
        stopForegroundCompat()
        stopping = true
        if (instance === this) instance = null
        stopSelf()
      }
    }
  }

  private fun startForegroundSafe(notification: Notification): Boolean {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIF_ID, notification)
      }
      inForeground = true
      true
    } catch (e: Exception) {
      // Android 15+ dataSync FGS quota exhaustion throws ForegroundServiceStartNotAllowedException.
      val ids = activeJobs.keys.toList()
      val arr = JSONArray()
      ids.forEach {
        arr.put(it)
        cancelledFlags.computeIfAbsent(it) { AtomicBoolean(false) }.set(true)
        cleanupJobTemps(it)
      }
      activeJobs.clear()
      releaseWakeLockLocked()
      inForeground = false
      stopping = true
      if (instance === this) instance = null
      emit("processingTimeout", JSONObject().put("error", e.message ?: "fgs_not_allowed").put("jobIds", arr))
      stopSelf()
      false
    }
  }

  private fun stopForegroundCompat() {
    if (!inForeground) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    inForeground = false
  }

  private fun acquireWakeLockLocked() {
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
      wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "linguaclip:media-processing")?.apply {
        setReferenceCounted(false)
      }
    }
    runCatching { wakeLock?.acquire(WAKELOCK_TIMEOUT_MS) }
  }

  private fun releaseWakeLockLocked() {
    val wl = wakeLock ?: return
    if (wl.isHeld) {
      runCatching { wl.release() }
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = notifyManager()
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val ch = NotificationChannel(
      CHANNEL_ID,
      "Media Import & Transcription",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setShowBadge(false)
      enableLights(false)
      enableVibration(false)
    }
    nm.createNotificationChannel(ch)
  }

  private fun buildNotification(state: JobState): Notification {
    val openIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val openPi = PendingIntent.getActivity(
      this,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val cancelIntent = Intent(this, MediaProcessingService::class.java).apply {
      action = ACTION_CANCEL_JOB
      putExtra(EXTRA_JOB_ID, state.jobId)
    }
    val cancelPi = PendingIntent.getService(
      this,
      1,
      cancelIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(state.title)
      .setContentText(state.detail)
      .setContentIntent(openPi)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消", cancelPi)

    if (state.percent in 0..100) {
      builder.setProgress(100, state.percent, false)
    } else {
      builder.setProgress(0, 0, true)
    }
    return builder.build()
  }

  private fun notifyManager(): NotificationManager =
    getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun emit(eventName: String, payload: JSONObject) {
    runCatching { eventSink?.invoke(eventName, payload) }
  }
}
