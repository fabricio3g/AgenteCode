package dev.agente.android.runtime

import org.json.JSONArray
import org.json.JSONObject

object NativeBridge {
    init { System.loadLibrary("agente_mobile") }
    @JvmStatic external fun nativeProviders(): String
    @JvmStatic external fun nativeStart(request: String): String
    @JvmStatic external fun nativePoll(turnId: String): String
    @JvmStatic external fun nativeCancel(turnId: String): String
    @JvmStatic external fun nativeDiscover(provider: String, key: String): String
    @JvmStatic external fun nativeMergeSync(local: String, incoming: String): String

    fun data(response: String): Any {
        val envelope = JSONObject(response)
        check(envelope.optBoolean("ok")) { envelope.optString("error", "Native request failed") }
        return envelope.get("data")
    }
    fun providers(): List<ProviderChoice> {
        val array = data(nativeProviders()) as JSONArray
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            val models = item.getJSONArray("models")
            ProviderChoice(item.getString("id"), item.getString("name"),
                (0 until models.length()).map(models::getString))
        }
    }
}

data class ProviderChoice(val id: String, val name: String, val models: List<String>)
