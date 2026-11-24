package com.linguaclip.app

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File

class MainActivity : TauriActivity() {
  private var linguaBridge: LinguaBridge? = null
  private var queuedShare: JSONObject? = null
  private var queuedVerifyVideo: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val contentView = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    persistDeviceIdentity()
    captureShareIntent(intent)
    captureVerifyIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureShareIntent(intent)
    captureVerifyIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    if (isDebuggable()) WebView.setWebContentsDebuggingEnabled(true)
    val bridge = LinguaBridge(this, webView)
    linguaBridge = bridge
    webView.addJavascriptInterface(bridge, "LinguaAndroid")
    bridge.attach()
    installBackNavigation(webView)
    queuedShare?.let {
      bridge.setPendingShare(it)
      queuedShare = null
    }
    if (isDebuggable()) {
      queuedVerifyVideo?.let { path ->
        queuedVerifyVideo = null
        webView.postDelayed({ bridge.emit("runPhase0Verify", JSONObject().put("videoPath", path)) }, 1500L)
      }
    }
  }

  // System back = the page's own history (mobile/App.tsx pushes one entry per page: study page,
  // non-home tab, episodes); with nothing left to go back to, the system default (leave the app).
  // TauriActivity turns WryActivity's own handling off, so without this every back press quit the app.
  private fun installBackNavigation(webView: WebView) {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (webView.canGoBack()) {
          webView.goBack()
        } else {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        }
      }
    })
  }

  private fun isDebuggable(): Boolean =
    (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  private fun captureVerifyIntent(intent: Intent?) {
    if (!isDebuggable()) return
    val path = intent?.getStringExtra("verify_video") ?: return
    val bridge = linguaBridge
    if (bridge != null) {
      bridge.emit("runPhase0Verify", JSONObject().put("videoPath", path))
    } else {
      queuedVerifyVideo = path
    }
  }

  override fun onDestroy() {
    linguaBridge?.detach()
    linguaBridge = null
    super.onDestroy()
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    AnkiDroidBridge.onRequestPermissionsResult(requestCode, permissions, grantResults)
  }

  // Stable device id & model written into app_local_data_dir (filesDir) for Rust device.rs.
  private fun persistDeviceIdentity() {
    runCatching {
      val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
      if (androidId.length >= 8) {
        File(filesDir, ".android_device_id").writeText(androidId)
      }
      val name = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
      if (name.isNotEmpty()) {
        File(filesDir, ".android_device_name").writeText(name)
      }
    }
  }

  private fun captureShareIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    val mime = intent.type ?: ""
    val payload = JSONObject().put("mime", mime)
    if (mime.startsWith("text/", ignoreCase = true)) {
      val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
      payload.put("kind", "text").put("text", text)
    } else {
      @Suppress("DEPRECATION")
      val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
      payload.put("kind", "uri").put("uri", uri.toString())
    }
    val bridge = linguaBridge
    if (bridge != null) bridge.setPendingShare(payload) else queuedShare = payload
  }
}
