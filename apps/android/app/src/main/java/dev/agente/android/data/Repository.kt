package dev.agente.android.data

import androidx.room.withTransaction
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class Repository(private val database: AgenteDatabase, private val deviceId: String) {
    val dao = database.dao()

    /**
     * What the search modal lists: recent conversations when the query is empty
     * (the desktop's `Recent`), otherwise title and message matches (its
     * `Matches`), each with the line that matched.
     */
    suspend fun search(query: String, limit: Int = 40): List<SearchHit> {
        val trimmed = query.trim()
        val chats = if (trimmed.isEmpty()) dao.recentConversations(limit)
        else dao.searchConversations(trimmed, limit)
        return chats.map { chat ->
            SearchHit(chat, if (trimmed.isEmpty()) null else dao.matchingSnippet(chat.id, trimmed)?.let(::snippetOf))
        }
    }

    /** The matched line, trimmed to something a row can show. */
    private fun snippetOf(content: String): String {
        val line = content.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        return if (line.length <= 120) line else line.take(117) + "\u2026"
    }

    private suspend fun revision(space: String, kind: String, id: String, content: JSONObject) {
        val previous = dao.revisions(id).map { JSONObject(it.body) }
        val parented = previous.flatMap { body ->
            val parents = body.getJSONArray("parents")
            (0 until parents.length()).map(parents::getString)
        }.toSet()
        val heads = previous.map { it.getString("id") }.filterNot(parented::contains).sorted()
        val revisionId = UUID.randomUUID().toString()
        val body = JSONObject().put("schema_version", 1).put("id", revisionId)
            .put("device_id", deviceId)
            .put("entity", JSONObject().put("space", space).put("kind", kind).put("id", id))
            .put("parents", JSONArray(heads)).put("content", content)
        dao.journal(SyncRevision(revisionId, id, body.toString()))
    }

    suspend fun save(chat: Conversation) = database.withTransaction {
        dao.save(chat)
        revision(chat.space, "conversation", chat.id, JSONObject()
            .put("id", chat.id).put("title", chat.title).put("character_id", chat.characterId ?: JSONObject.NULL))
    }

    /** Intermediate streamed text is a local checkpoint; final/incomplete
     * messages are journaled once, so sync doesn't record every token. */
    suspend fun save(message: ChatMessage, space: String, journal: Boolean = true) = database.withTransaction {
        dao.save(message)
        if (journal) revision(space, "message", message.id, JSONObject()
            .put("id", message.id).put("conversation_id", message.chatId).put("role", message.role)
            .put("content", message.content).put("thinking", message.thinking)
            .put("status", message.status).put("created_at", message.createdAt)
            .put("continuation", message.continuation?.let(::JSONObject) ?: JSONObject.NULL)
            .put("thinking_signature", message.thinkingSignature ?: JSONObject.NULL))
    }

    suspend fun save(character: Character) = database.withTransaction {
        dao.save(character)
        revision("roleplay", "character", character.id, JSONObject()
            .put("id", character.id).put("name", character.name).put("notes", character.notes)
            .put("greeting", character.greeting).put("created_at", character.createdAt))
    }
}
