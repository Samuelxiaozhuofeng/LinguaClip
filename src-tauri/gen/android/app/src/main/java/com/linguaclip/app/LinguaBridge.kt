package com.linguaclip.app

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * JS <-> Android native bridge registered on Tauri's WebView as `window.LinguaAndroid`.
 * Delegates by method prefix to PlaybackRoutes, MediaRoutes, and SystemRoutes.
 */
class LinguaBridge(
  internal val activity: Activity,
  private val webView: WebView,
) {
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newCachedThreadPool()

  @Volatile
  private var service: PlaybackService? = null
  private var bound = false
  private val pendingBindLatches = mutableListOf<CountDownLatch>()
  private val bindLock = Any()

  @Volatile
  private var pendingShare: JSONObject? = null

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      val svc = (binder as? PlaybackService.LocalBinder)?.service() ?: return
      service = svc
      svc.eventSink = { eventName, payload -> emit(eventName, payload) }
      synchronized(bindLock) {
        pendingBindLatches.forEach { it.countDown() }
        pendingBindLatches.clear()
      }
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      service = null
      bound = false
    }
  }

  fun attach() {
    ensureServiceStartedAsync()
  }

  fun detach() {
    service?.eventSink = null
    if (bound) {
      runCatching { activity.unbindService(connection) }
      bound = false
    }
    io.shutdownNow()
  }

  fun setPendingShare(payload: JSONObject) {
    pendingShare = payload
    emit("shareReceived", payload)
  }

  internal fun takePendingShare(): JSONObject? {
    val item = pendingShare
    pendingShare = null
    return item
  }

  private fun ensureServiceStartedAsync() {
    if (service != null) return
    val intent = Intent(activity, PlaybackService::class.java)
    runCatching { activity.startService(intent) }
    if (!bound) {
      bound = activity.bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }
  }

  internal fun requireService(): PlaybackService {
    PlaybackService.instance?.let { inst ->
      if (service == null) {
        service = inst
        inst.eventSink = { eventName, payload -> emit(eventName, payload) }
      }
      return inst
    }
    val latch = CountDownLatch(1)
    synchronized(bindLock) {
      service?.let { return it }
      pendingBindLatches.add(latch)
    }
    main.post { ensureServiceStartedAsync() }
    latch.await(5, TimeUnit.SECONDS)
    return service ?: PlaybackService.instance
      ?: throw IllegalStateException("playback:service_unavailable")
  }

  internal fun <T> onMainSync(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val latch = CountDownLatch(1)
    var result: Result<T>? = null
    main.post {
      result = runCatching(block)
      latch.countDown()
    }
    if (!latch.await(10, TimeUnit.SECONDS)) throw IllegalStateException("main:timeout")
    return result!!.getOrThrow()
  }

  internal fun isDebuggable(): Boolean =
    (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  @JavascriptInterface
  fun isAvailable(): Boolean = true

  @JavascriptInterface
  fun isDebug(): Boolean = isDebuggable()

  @JavascriptInterface
  fun call(reqId: String, method: String, argsJson: String) {
    io.execute {
      try {
        val args = if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson)
        val res = dispatch(method, args)
        resolve(reqId, true, res.toString())
      } catch (e: Throwable) {
        val msg = e.message ?: e.javaClass.simpleName
        resolve(reqId, false, JSONObject().put("error", msg).toString())
      }
    }
  }

  private fun dispatch(method: String, args: JSONObject): Any {
    return when {
      method.startsWith("playback.") -> PlaybackRoutes.dispatch(this, method, args)
      method.startsWith("media.") || method.startsWith("processing.") -> MediaRoutes.dispatch(this, method, args)
      method.startsWith("system.") -> SystemRoutes.dispatch(this, method, args)
      method.startsWith("anki.") -> AnkiRoutes.dispatch(this, method, args)
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }

  private fun resolve(reqId: String, ok: Boolean, jsonPayload: String) {
    val js = "window.__lcAndroidResolve && window.__lcAndroidResolve(${JSONObject.quote(reqId)}, $ok, ${JSONObject.quote(jsonPayload)});"
    main.post { webView.evaluateJavascript(js, null) }
  }

  fun emit(eventName: String, payload: JSONObject) {
    val js = "window.__lcAndroidEmit && window.__lcAndroidEmit(${JSONObject.quote(eventName)}, ${JSONObject.quote(payload.toString())});"
    main.post { webView.evaluateJavascript(js, null) }
  }
}
