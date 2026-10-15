package dev.agente.android.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "conversations")
data class Conversation(
    @androidx.room.PrimaryKey val id: String,
    val space: String,
    val title: String,
    val characterId: String? = null,
    val draft: String = "",
    val updatedAt: Long = System.currentTimeMillis(),
)

@Entity(tableName = "messages", indices = [Index("chatId")])
data class ChatMessage(
    @androidx.room.PrimaryKey val id: String,
    val chatId: String,
    val role: String,
    val content: String,
    val thinking: String = "",
    val status: String = "complete",
    val continuation: String? = null,
    val thinkingSignature: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

@Entity(tableName = "characters")
data class Character(
    @androidx.room.PrimaryKey val id: String,
    val name: String,
    val notes: String,
    val greeting: String,
    val createdAt: Long = System.currentTimeMillis(),
)

/** The journal is durable, including tombstones. Network sync is a later host
 * adapter; an unsent revision is never presented as already synchronized. */
@Entity(tableName = "sync_revisions", indices = [Index("entityId")])
data class SyncRevision(
    @androidx.room.PrimaryKey val id: String,
    val entityId: String,
    val body: String,
    val pending: Boolean = true,
)

/** One conversation the search modal can show, with the line that matched. */
data class SearchHit(val chat: Conversation, val snippet: String?)

@Dao
interface AgenteDao {
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    fun conversations(): Flow<List<Conversation>>
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC LIMIT :limit")
    suspend fun recentConversations(limit: Int): List<Conversation>
    /** Titles and message bodies, the two things the desktop searches. */
    @Query(
        "SELECT * FROM conversations WHERE title LIKE '%' || :query || '%' " +
            "OR EXISTS (SELECT 1 FROM messages WHERE chatId = conversations.id AND content LIKE '%' || :query || '%') " +
            "ORDER BY updatedAt DESC LIMIT :limit"
    )
    suspend fun searchConversations(query: String, limit: Int): List<Conversation>
    @Query("SELECT content FROM messages WHERE chatId = :chatId AND content LIKE '%' || :query || '%' ORDER BY createdAt LIMIT 1")
    suspend fun matchingSnippet(chatId: String, query: String): String?
    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun conversation(id: String): Conversation?    @Query("SELECT * FROM messages WHERE chatId = :id ORDER BY createdAt, id")
    fun messages(id: String): Flow<List<ChatMessage>>
    @Query("SELECT * FROM messages WHERE chatId = :id ORDER BY createdAt, id")
    suspend fun history(id: String): List<ChatMessage>
    @Query("SELECT * FROM characters ORDER BY createdAt DESC")
    fun characters(): Flow<List<Character>>
    @Query("SELECT * FROM characters WHERE id = :id")
    suspend fun character(id: String): Character?
    @Query("SELECT * FROM sync_revisions WHERE entityId = :id")
    suspend fun revisions(id: String): List<SyncRevision>
    @Query("SELECT COUNT(*) FROM sync_revisions WHERE pending = 1")
    fun pendingCount(): Flow<Int>
    @Query("SELECT * FROM sync_revisions ORDER BY id")
    suspend fun allRevisions(): List<SyncRevision>
    @Query("UPDATE conversations SET draft = :draft WHERE id = :id")
    suspend fun draft(id: String, draft: String)
    @Query("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'")
    suspend fun recoverInterrupted()

    /** Regenerating drops the answer it replaces. Deletions need tombstones
     *  before sync is enabled, which is why this is only called on a re-run. */
    @Query("DELETE FROM messages WHERE id = :id")
    suspend fun deleteMessage(id: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(chat: Conversation)    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(message: ChatMessage)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(character: Character)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun journal(revision: SyncRevision)
}

@Database(entities = [Conversation::class, ChatMessage::class, Character::class, SyncRevision::class], version = 1, exportSchema = true)
abstract class AgenteDatabase : RoomDatabase() { abstract fun dao(): AgenteDao }
