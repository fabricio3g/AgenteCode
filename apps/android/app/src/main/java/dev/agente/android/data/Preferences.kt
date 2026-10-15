package dev.agente.android.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.first
import java.util.UUID

private val Context.agentePreferences by preferencesDataStore("agente")
data class ModelSelection(val provider: String = "", val model: String = "", val persona: String = "You")

/** Light, dark, or whatever the system says — per device, never synchronized. */
enum class ThemeChoice(val wire: String) {
    Auto("auto"), Light("light"), Dark("dark");

    companion object {
        fun from(value: String?): ThemeChoice = entries.firstOrNull { it.wire == value } ?: Auto
    }
}

class Preferences(context: Context) {
    private val store = context.agentePreferences
    private val providerKey = stringPreferencesKey("provider")
    private val modelKey = stringPreferencesKey("model")
    private val personaKey = stringPreferencesKey("persona")
    private val themeKey = stringPreferencesKey("theme")
    val selection = store.data.map { ModelSelection(it[providerKey].orEmpty(), it[modelKey].orEmpty(), it[personaKey] ?: "You") }
    val theme = store.data.map { ThemeChoice.from(it[themeKey]) }

    suspend fun save(selection: ModelSelection) {
        store.edit { it[providerKey] = selection.provider; it[modelKey] = selection.model; it[personaKey] = selection.persona }
    }

    suspend fun saveTheme(choice: ThemeChoice) {
        store.edit { it[themeKey] = choice.wire }
    }

    suspend fun draft(space: String): String = store.data.first()[stringPreferencesKey("draft_$space")].orEmpty()
    suspend fun saveDraft(space: String, text: String) { store.edit { it[stringPreferencesKey("draft_$space")] = text } }

    // Identity is device-local, deliberately separate from synchronized data.
    val deviceId: String = context.getSharedPreferences("identity", Context.MODE_PRIVATE).let { prefs ->
        prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            check(prefs.edit().putString("device_id", it).commit()) { "Cannot save device identity" }
        }
    }
}
