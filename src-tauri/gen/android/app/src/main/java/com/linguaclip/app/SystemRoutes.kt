package com.linguaclip.app

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/** Dispatches `system.*` bridge methods (paths, device info, battery whitelist, share, network state). */
internal object SystemRoutes {
  fun dispatch(bridge: LinguaBridge, method: String, args: JSONObject): Any {
    val activity = bridge.activity
    return when (method) {
      "system.paths" -> JSONObject()
        .put("filesDir", activity.filesDir.absolutePath)
        .put("cacheDir", activity.cacheDir.absolutePath)
        .put("externalFilesDir", activity.getExternalFilesDir(null)?.absolutePath ?: "")
      "system.logVerify" -> {
        if (!bridge.isDebuggable()) throw SecurityException("debug only")
        android.util.Log.i("LinguaClipVerify", args.optString("payload", ""))
        JSONObject().put("ok", true)
      }
      "system.deviceInfo" -> {
        val androidId = Settings.Secure.getString(activity.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        val model = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        JSONObject().put("androidId", androidId).put("model", model).put("sdkInt", Build.VERSION.SDK_INT)
      }
      "system.networkState" -> {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork
        val caps = net?.let { cm.getNetworkCapabilities(it) }
        val connected = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val wifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true ||
          caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true
        val metered = cm.isActiveNetworkMetered
        JSONObject()
          .put("connected", connected)
          .put("wifi", wifi)
          .put("metered", metered)
      }
      "system.isIgnoringBatteryOptimizations" -> {
        val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        val ignoring = pm.isIgnoringBatteryOptimizations(activity.packageName)
        JSONObject().put("ignoring", ignoring)
      }
      "system.openBatterySettings" -> {
        bridge.onMainSync {
          val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
          activity.startActivity(intent)
          JSONObject().put("ok", true)
        }
      }
      "system.shareFile" -> {
        val path = args.getString("path")
        val mime = args.optString("mime", "application/octet-stream")
        bridge.onMainSync {
          val file = File(path)
          val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
          val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          activity.startActivity(Intent.createChooser(intent, args.optString("title", "导出")))
          JSONObject().put("ok", true)
        }
      }
      "system.getPendingShare" -> {
        val item = bridge.takePendingShare()
        JSONObject().put("share", item ?: JSONObject.NULL)
      }
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }
}
