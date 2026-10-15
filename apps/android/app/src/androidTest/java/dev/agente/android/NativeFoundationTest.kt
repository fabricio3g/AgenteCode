package dev.agente.android

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.agente.android.data.AgenteDatabase
import dev.agente.android.data.Character
import dev.agente.android.data.Repository
import dev.agente.android.runtime.NativeBridge
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NativeFoundationTest {
    @Test fun databaseJournalRoundTripsThroughTheRealNativeReducer() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AgenteDatabase::class.java).build()
        try {
            val repository = Repository(database, UUID.randomUUID().toString())
            val character = Character(UUID.randomUUID().toString(), "Mira", "A quiet astronomer", "Hi, {{user}}")
            repository.save(character)
            repository.save(character.copy(notes = "An adventurous astronomer"))
            val outbox = repository.dao.allRevisions()
            assertEquals(2, outbox.size)
            val body = JSONArray(outbox.map { JSONObject(it.body) }).toString()
            val first = NativeBridge.data(NativeBridge.nativeMergeSync("[]", body)) as JSONArray
            val repeated = NativeBridge.data(NativeBridge.nativeMergeSync(first.toString(), body)) as JSONArray
            assertEquals(2, repeated.length())
            assertEquals("Hi, {{user}}", repository.dao.character(character.id)?.greeting)
            assertTrue(outbox.all { it.pending })
        } finally { database.close() }
    }

    @Test fun nativeDirectoryUsesOnlyCloudProviders() {
        val providers = NativeBridge.providers()
        assertTrue(providers.isNotEmpty())
        assertFalse(providers.any { it.id == "llamacpp" || it.id == "ollama" })
    }
}
