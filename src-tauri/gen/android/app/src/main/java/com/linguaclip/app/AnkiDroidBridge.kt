package com.linguaclip.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Direct FlashCardsContract ContentProvider bridge to AnkiDroid (`com.ichi2.anki`),
 * implementing the `mobile/platform/ankiDroid.ts` contract without extra Maven dependencies.
 */
object AnkiDroidBridge {
  private const val TAG = "AnkiDroidBridge"
  private const val ANKI_PACKAGE = "com.ichi2.anki"
  private const val AUTHORITY = "com.ichi2.anki.flashcards"
  private const val PERMISSION = "com.ichi2.anki.permission.READ_WRITE_DATABASE"
  private const val FIELD_SEP = "\u001f"
  private const val REQ_CODE_PERMISSION = 4201
  private const val PERMISSION_TIMEOUT_SEC = 60L

  private val AUTHORITY_URI: Uri = Uri.parse("content://$AUTHORITY")
  private val NOTES_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "notes")
  private val MODELS_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "models")
  private val DECKS_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "decks")
  private val MEDIA_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "media")

  private val permLock = Any()
  private var pendingPermLatch: CountDownLatch? = null
  private var pendingPermGranted = AtomicBoolean(false)

  private fun getPackageInfo(context: Context): PackageInfo? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getPackageInfo(ANKI_PACKAGE, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(ANKI_PACKAGE, 0)
      }
    } catch (_: PackageManager.NameNotFoundException) {
      null
    }
  }

  private fun hasProvider(context: Context): Boolean {
    return try {
      val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.resolveContentProvider(AUTHORITY, PackageManager.ComponentInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.resolveContentProvider(AUTHORITY, 0)
      }
      info != null
    } catch (_: Throwable) {
      false
    }
  }

  private fun isPermitted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, PERMISSION) == PackageManager.PERMISSION_GRANTED

  private fun probeApiAvailable(context: Context): Boolean {
    if (!hasProvider(context)) return false
    return try {
      context.contentResolver.query(DECKS_URI, arrayOf("deck_id"), null, null, null)?.use { true } ?: false
    } catch (e: Throwable) {
      Log.d(TAG, "probeApiAvailable false: ${e.javaClass.simpleName}: ${e.message}")
      false
    }
  }

  private fun requireReady(context: Context) {
    if (getPackageInfo(context) == null) throw IllegalStateException("anki:not_installed")
    if (!isPermitted(context)) throw IllegalStateException("anki:no_permission")
    if (!hasProvider(context)) throw IllegalStateException("anki:api_unavailable")
  }

  private fun mapProviderError(e: Throwable, fallback: String): Nothing {
    Log.w(TAG, "AnkiDroid provider error ($fallback): ${e.javaClass.simpleName}: ${e.message}")
    if (e is SecurityException) throw IllegalStateException("anki:no_permission")
    if (e is IllegalStateException && e.message?.startsWith("anki:") == true) throw e
    throw IllegalStateException(fallback)
  }

  fun status(context: Context): JSONObject {
    val pkg = getPackageInfo(context)
    val installed = pkg != null
    val permitted = installed && isPermitted(context)
    val apiAvailable = installed && permitted && probeApiAvailable(context)
    val out = JSONObject()
      .put("installed", installed)
      .put("permitted", permitted)
      .put("apiAvailable", apiAvailable)
    val ver = pkg?.versionName
    if (!ver.isNullOrEmpty()) out.put("version", ver)
    return out
  }

  fun requestPermission(bridge: LinguaBridge): JSONObject {
    val activity = bridge.activity
    if (getPackageInfo(activity) == null) throw IllegalStateException("anki:not_installed")
    if (isPermitted(activity)) return JSONObject().put("granted", true)

    // Asked before and Android no longer shows the prompt ("don't ask again" / denied twice):
    // the only way left is the app's own permission page, so open it instead of a silent no-op.
    val prefs = activity.getSharedPreferences("linguaclip_anki", Context.MODE_PRIVATE)
    if (prefs.getBoolean("perm_asked", false) &&
      !ActivityCompat.shouldShowRequestPermissionRationale(activity, PERMISSION)
    ) {
      bridge.onMainSync {
        activity.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
      return JSONObject().put("granted", false).put("settings", true)
    }
    prefs.edit().putBoolean("perm_asked", true).apply()

    val latch: CountDownLatch
    val grantedHolder: AtomicBoolean
    val shouldLaunch: Boolean
    synchronized(permLock) {
      val existing = pendingPermLatch
      if (existing != null && existing.count > 0) {
        latch = existing
        grantedHolder = pendingPermGranted
        shouldLaunch = false
      } else {
        latch = CountDownLatch(1)
        grantedHolder = AtomicBoolean(false)
        pendingPermLatch = latch
        pendingPermGranted = grantedHolder
        shouldLaunch = true
      }
    }

    if (shouldLaunch) {
      try {
        bridge.onMainSync {
          ActivityCompat.requestPermissions(activity, arrayOf(PERMISSION), REQ_CODE_PERMISSION)
        }
      } catch (e: Throwable) {
        synchronized(permLock) {
          if (pendingPermLatch === latch) pendingPermLatch = null
        }
        latch.countDown()
        throw e
      }
    }

    val completed = try {
      latch.await(PERMISSION_TIMEOUT_SEC, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    } finally {
      if (shouldLaunch) {
        synchronized(permLock) {
          if (pendingPermLatch === latch) pendingPermLatch = null
        }
      }
    }
    val granted = (completed && grantedHolder.get()) || isPermitted(activity)
    return JSONObject().put("granted", granted)
  }

  fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    if (requestCode != REQ_CODE_PERMISSION) return
    val idx = permissions.indexOf(PERMISSION)
    val granted = when {
      idx >= 0 && idx < grantResults.size -> grantResults[idx] == PackageManager.PERMISSION_GRANTED
      grantResults.isNotEmpty() -> grantResults[0] == PackageManager.PERMISSION_GRANTED
      else -> false
    }
    synchronized(permLock) {
      pendingPermGranted.set(granted)
      pendingPermLatch?.countDown()
      pendingPermLatch = null
    }
  }

  fun open(bridge: LinguaBridge): JSONObject {
    val activity = bridge.activity
    return bridge.onMainSync {
      if (getPackageInfo(activity) != null) {
        val launch = activity.packageManager.getLaunchIntentForPackage(ANKI_PACKAGE)
        if (launch != null) {
          launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          activity.startActivity(launch)
          return@onMainSync JSONObject().put("opened", "app")
        }
      }
      openStore(activity)
      JSONObject().put("opened", "store")
    }
  }

  private fun openStore(activity: Activity) {
    val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$ANKI_PACKAGE"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(market)
    } catch (_: ActivityNotFoundException) {
      val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$ANKI_PACKAGE"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(web)
    }
  }

  fun decks(context: Context): JSONObject {
    requireReady(context)
    val arr = JSONArray()
    try {
      val cursor = context.contentResolver.query(DECKS_URI, arrayOf("deck_id", "deck_name"), null, null, null)
        ?: throw IllegalStateException("anki:api_unavailable")
      cursor.use { c ->
        val idIdx = c.getColumnIndex("deck_id")
        val nameIdx = c.getColumnIndex("deck_name")
        while (c.moveToNext()) {
          if (idIdx < 0 || nameIdx < 0) continue
          arr.put(JSONObject().put("id", c.getLong(idIdx)).put("name", c.getString(nameIdx) ?: ""))
        }
      }
    } catch (e: Throwable) {
      mapProviderError(e, "anki:api_unavailable")
    }
    return JSONObject().put("decks", arr)
  }

  fun ensureDeck(context: Context, rawName: String): JSONObject {
    requireReady(context)
    val name = rawName.trim()
    if (name.isEmpty()) throw IllegalArgumentException("anki:invalid_deck")
    try {
      var ciMatch: Long? = null
      val cursor = context.contentResolver.query(DECKS_URI, arrayOf("deck_id", "deck_name"), null, null, null)
        ?: throw IllegalStateException("anki:api_unavailable")
      cursor.use { c ->
        val idIdx = c.getColumnIndex("deck_id")
        val nameIdx = c.getColumnIndex("deck_name")
        while (c.moveToNext()) {
          if (idIdx < 0 || nameIdx < 0) continue
          val existing = c.getString(nameIdx) ?: continue
          val id = c.getLong(idIdx)
          if (existing == name) return JSONObject().put("deckId", id)
          if (ciMatch == null && existing.equals(name, ignoreCase = true)) ciMatch = id
        }
      }
      if (ciMatch != null) return JSONObject().put("deckId", ciMatch)

      val cv = ContentValues().apply { put("deck_name", name) }
      val uri = context.contentResolver.insert(DECKS_URI, cv)
        ?: throw IllegalStateException("anki:api_unavailable")
      val deckId = uri.lastPathSegment?.toLongOrNull()
        ?: throw IllegalStateException("anki:api_unavailable")
      return JSONObject().put("deckId", deckId)
    } catch (e: Throwable) {
      mapProviderError(e, "anki:api_unavailable")
    }
  }

  fun ensureModel(
    context: Context,
    name: String,
    fields: List<String>,
    front: String,
    back: String,
    css: String,
  ): JSONObject {
    requireReady(context)
    if (name.isBlank() || fields.isEmpty()) throw IllegalArgumentException("anki:invalid_model")
    val cr = context.contentResolver
    try {
      var matchedId: Long? = null
      var matchedCss: String? = null
      val cursor = cr.query(MODELS_URI, arrayOf("_id", "name", "field_names", "css"), null, null, null)
        ?: throw IllegalStateException("anki:api_unavailable")
      cursor.use { c ->
        val idIdx = c.getColumnIndex("_id")
        val nameIdx = c.getColumnIndex("name")
        val fldsIdx = c.getColumnIndex("field_names")
        val cssIdx = c.getColumnIndex("css")
        while (c.moveToNext()) {
          if (idIdx < 0 || nameIdx < 0 || fldsIdx < 0) continue
          val rowName = c.getString(nameIdx) ?: continue
          if (rowName != name) continue
          val rowFields = (c.getString(fldsIdx) ?: "").split(FIELD_SEP)
          if (rowFields == fields) {
            matchedId = c.getLong(idIdx)
            matchedCss = if (cssIdx >= 0) c.getString(cssIdx) else null
            break
          }
        }
      }

      if (matchedId != null) {
        val modelUri = Uri.withAppendedPath(MODELS_URI, matchedId.toString())
        if (matchedCss != css) {
          cr.update(modelUri, ContentValues().apply { put("css", css) }, null, null)
        }
        val tplUri = Uri.withAppendedPath(modelUri, "templates/0")
        var curFront: String? = null
        var curBack: String? = null
        runCatching {
          cr.query(tplUri, arrayOf("question_format", "answer_format"), null, null, null)?.use { tc ->
            if (tc.moveToFirst()) {
              val qIdx = tc.getColumnIndex("question_format")
              val aIdx = tc.getColumnIndex("answer_format")
              if (qIdx >= 0) curFront = tc.getString(qIdx)
              if (aIdx >= 0) curBack = tc.getString(aIdx)
            }
          }
        }
        if (curFront != front || curBack != back) {
          val tplValues = ContentValues().apply {
            put("card_template_name", name)
            put("question_format", front)
            put("answer_format", back)
          }
          cr.update(tplUri, tplValues, null, null)
        }
        return JSONObject().put("modelId", matchedId)
      }

      val modelValues = ContentValues().apply {
        put("name", name)
        put("field_names", fields.joinToString(FIELD_SEP))
        put("num_cards", 1)
        put("css", css)
        put("sort_field_index", 0)
      }
      val modelUri = cr.insert(MODELS_URI, modelValues)
        ?: throw IllegalStateException("anki:api_unavailable")
      val modelId = modelUri.lastPathSegment?.toLongOrNull()
        ?: throw IllegalStateException("anki:api_unavailable")

      val tplUri = Uri.withAppendedPath(modelUri, "templates/0")
      val tplValues = ContentValues().apply {
        put("card_template_name", name)
        put("question_format", front)
        put("answer_format", back)
      }
      cr.update(tplUri, tplValues, null, null)
      return JSONObject().put("modelId", modelId)
    } catch (e: Throwable) {
      mapProviderError(e, "anki:api_unavailable")
    }
  }

  fun addMedia(context: Context, path: String, preferredName: String, kind: String): JSONObject {
    requireReady(context)
    if (kind != "audio" && kind != "image") throw IllegalArgumentException("anki:media_failed")

    val own = context.filesDir.canonicalFile
    val target = File(path).canonicalFile
    if (!target.isFile || !target.path.startsWith(own.path + File.separator)) {
      throw SecurityException("anki:media_failed")
    }

    // AnkiDroid CardContentProvider appends ".$ext" from MIME type and calls File.createTempFile(prefix + "_", ...),
    // which requires a prefix of at least 3 chars without path separators or extension.
    val baseName = preferredName
      .substringAfterLast('/')
      .substringAfterLast('\\')
      .replace(Regex("\\.[^.]+$"), "")
      .replace(Regex("[^A-Za-z0-9_-]"), "_")
      .trim('_')
      .take(120)
    val safePreferred = when {
      baseName.length >= 3 -> baseName
      baseName.isNotEmpty() -> "lc_$baseName"
      else -> "lc_media_${System.currentTimeMillis()}"
    }

    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
    context.grantUriPermission(ANKI_PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      val cv = ContentValues().apply {
        put("file_uri", uri.toString())
        put("preferred_name", safePreferred)
      }
      val returnUri = context.contentResolver.insert(MEDIA_URI, cv)
        ?: throw IllegalStateException("anki:media_failed")
      val fileName = (returnUri.path ?: "").removePrefix("/").ifBlank { returnUri.lastPathSegment ?: "" }
      if (fileName.isBlank()) throw IllegalStateException("anki:media_failed")
      val ref = if (kind == "audio") "[sound:$fileName]" else "<img src=\"$fileName\">"
      return JSONObject().put("ref", ref).put("fileName", fileName)
    } catch (e: Throwable) {
      mapProviderError(e, "anki:media_failed")
    } finally {
      runCatching { context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
  }

  fun addNote(
    context: Context,
    modelId: Long,
    deckId: Long,
    fields: List<String>,
    tags: List<String>,
  ): JSONObject {
    requireReady(context)
    if (fields.isEmpty()) throw IllegalArgumentException("anki:add_failed")
    val cr = context.contentResolver
    val cleanTags = tags.map { it.trim().replace(Regex("\\s+"), "_") }.filter { it.isNotEmpty() }
    val cv = ContentValues().apply {
      put("mid", modelId)
      put("flds", fields.joinToString(FIELD_SEP))
      if (cleanTags.isNotEmpty()) put("tags", cleanTags.joinToString(" "))
    }
    try {
      val newNoteUri = try {
        cr.insert(NOTES_URI, cv)
      } catch (e: IllegalArgumentException) {
        Log.w(TAG, "addNote refused by AnkiDroid: ${e.message}")
        return JSONObject().put("noteId", JSONObject.NULL)
      }
      if (newNoteUri == null) return JSONObject().put("noteId", JSONObject.NULL)

      // Move all generated cards for this note into deckId (same pattern as AnkiDroid AddContentApi).
      val cardsUri = Uri.withAppendedPath(newNoteUri, "cards")
      cr.query(cardsUri, arrayOf("ord"), null, null, null)?.use { c ->
        val ordIdx = c.getColumnIndex("ord")
        while (c.moveToNext()) {
          if (ordIdx < 0) continue
          val ord = c.getString(ordIdx) ?: continue
          val cardUri = Uri.withAppendedPath(cardsUri, ord)
          cr.update(cardUri, ContentValues().apply { put("deck_id", deckId) }, null, null)
        }
      }
      val noteId = newNoteUri.lastPathSegment?.toLongOrNull()
      return JSONObject().put("noteId", noteId ?: JSONObject.NULL)
    } catch (e: Throwable) {
      mapProviderError(e, "anki:add_failed")
    }
  }
}
