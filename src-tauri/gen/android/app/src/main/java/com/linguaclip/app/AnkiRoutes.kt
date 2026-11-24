package com.linguaclip.app

import org.json.JSONArray
import org.json.JSONObject

/** Dispatches `anki.*` bridge methods to AnkiDroidBridge (M2.5). */
internal object AnkiRoutes {
  private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    val out = ArrayList<String>(length())
    for (i in 0 until length()) out.add(optString(i, ""))
    return out
  }

  fun dispatch(bridge: LinguaBridge, method: String, args: JSONObject): Any {
    val ctx = bridge.activity
    return when (method) {
      "anki.status" -> AnkiDroidBridge.status(ctx)
      "anki.requestPermission" -> AnkiDroidBridge.requestPermission(bridge)
      "anki.open" -> AnkiDroidBridge.open(bridge)
      "anki.decks" -> AnkiDroidBridge.decks(ctx)
      "anki.ensureDeck" -> AnkiDroidBridge.ensureDeck(ctx, args.getString("name"))
      "anki.ensureModel" -> AnkiDroidBridge.ensureModel(
        context = ctx,
        name = args.getString("name"),
        fields = args.optJSONArray("fields").toStringList(),
        front = args.getString("front"),
        back = args.getString("back"),
        css = args.optString("css", ""),
      )
      "anki.addMedia" -> AnkiDroidBridge.addMedia(
        context = ctx,
        path = args.getString("path"),
        preferredName = args.optString("preferredName", ""),
        kind = args.getString("kind"),
      )
      "anki.addNote" -> AnkiDroidBridge.addNote(
        context = ctx,
        modelId = args.getLong("modelId"),
        deckId = args.getLong("deckId"),
        fields = args.optJSONArray("fields").toStringList(),
        tags = args.optJSONArray("tags").toStringList(),
      )
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }
}
