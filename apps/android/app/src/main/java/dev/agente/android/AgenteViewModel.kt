package dev.agente.android

import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.agente.android.data.Character
import dev.agente.android.data.ChatMessage
import dev.agente.android.data.Conversation
import dev.agente.android.data.ModelSelection
import dev.agente.android.data.SearchHit
import dev.agente.android.data.ThemeChoice
import dev.agente.android.runtime.NativeBridge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.collect
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class Space(val labelRes: Int, val wire: String) {
    Home(R.string.space_home, "home"),
    Code(R.string.space_code, "code"),
    Roleplay(R.string.space_roleplay, "roleplay")
}

/**
 * What the reader is told. App-level failures carry a resource id so they follow
 * the interface language; a provider or bridge failure arrives as text, because
 * its wording belongs to the layer that raised it.
 */
data class Notice(@StringRes val resource: Int = 0, val text: String? = null)

class AgenteViewModel(private val app: AgenteApplication) : ViewModel() {
    private val repository = app.repository
    var space by mutableStateOf(Space.Home); private set
    var theme by mutableStateOf(ThemeChoice.Auto); private set
    var chats by mutableStateOf(emptyList<Conversation>()); private set
    var characters by mutableStateOf(emptyList<Character>()); private set
    var messages by mutableStateOf(emptyList<ChatMessage>()); private set
    var activeChat by mutableStateOf<Conversation?>(null); private set
    var draft by mutableStateOf(""); private set
    var selection by mutableStateOf(ModelSelection()); private set
    var notice by mutableStateOf<Notice?>(null); private set
    var workingChatId by mutableStateOf<String?>(null); private set

    /** When the running turn started, for the live row's elapsed time. */
    var workingSince by mutableStateOf<Long?>(null); private set
    var pendingChanges by mutableStateOf(0); private set
    var settingsOpen by mutableStateOf(false)
    var characterEditorOpen by mutableStateOf(false)
    var characterEditing by mutableStateOf<Character?>(null); private set
    var discoveredModels by mutableStateOf(emptyList<String>()); private set
    var discoveredProvider by mutableStateOf(""); private set
    var discovering by mutableStateOf(false); private set

    /** The search modal: open, what was typed, and what the query returned. */
    var searchOpen by mutableStateOf(false); private set
    var searchQuery by mutableStateOf(""); private set
    var searchHits by mutableStateOf(emptyList<SearchHit>()); private set
    private var searchJob: Job? = null
    val providers = NativeBridge.providers()
    private var observer: Job? = null
    private var turn: Job? = null
    private var nativeTurn: String? = null
    private var draftSave: Job? = null
    private var navigationRevision = 0

    init {
        viewModelScope.launch { repository.dao.recoverInterrupted() }
        viewModelScope.launch { repository.dao.conversations().collect { chats = it } }
        viewModelScope.launch { repository.dao.characters().collect { characters = it } }
        viewModelScope.launch { repository.dao.pendingCount().collect { pendingChanges = it } }
        viewModelScope.launch { app.preferences.selection.collect { selection = it } }
        viewModelScope.launch { app.preferences.theme.collect { theme = it } }
        restoreDraft()
    }

    private fun restoreDraft() {
        val revision = navigationRevision
        val currentSpace = space.wire
        viewModelScope.launch {
            val saved = app.preferences.draft(currentSpace)
            if (navigationRevision == revision && activeChat == null) draft = saved
        }
    }

    fun switchSpace(next: Space) {
        if (next == space) return
        saveDraftNow()
        navigationRevision++
        observer?.cancel()
        space = next; activeChat = null; messages = emptyList(); draft = ""; notice = null
        restoreDraft()
    }

    fun newChat() {
        saveDraftNow()
        navigationRevision++
        observer?.cancel()
        activeChat = null; messages = emptyList(); draft = ""; notice = null
        viewModelScope.launch { app.preferences.saveDraft(space.wire, "") }
    }

    fun chooseTheme(choice: ThemeChoice) {
        theme = choice
        viewModelScope.launch { app.preferences.saveTheme(choice) }
    }

    private fun saveDraftNow() {
        draftSave?.cancel()
        val chatId = activeChat?.id
        val currentSpace = space.wire
        val text = draft
        viewModelScope.launch {
            if (chatId == null) app.preferences.saveDraft(currentSpace, text) else repository.dao.draft(chatId, text)
        }
    }

    fun updateDraft(text: String) {
        navigationRevision++
        draft = text
        draftSave?.cancel()
        val chatId = activeChat?.id
        val currentSpace = space.wire
        draftSave = viewModelScope.launch {
            delay(200)
            if (chatId == null) app.preferences.saveDraft(currentSpace, text) else repository.dao.draft(chatId, text)
        }
    }

    fun openChat(chat: Conversation) {
        saveDraftNow()
        navigationRevision++
        observer?.cancel()
        activeChat = chat; space = Space.entries.first { it.wire == chat.space }
        draft = chat.draft; messages = emptyList(); notice = null
        observer = viewModelScope.launch { repository.dao.messages(chat.id).collect { messages = it } }
    }

    fun openSearch() {
        searchOpen = true
        search(searchQuery)
    }

    fun closeSearch() {
        searchOpen = false
    }

    /** Every keystroke replaces the query; the previous lookup is cancelled. */
    fun search(query: String) {
        searchQuery = query
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            val hits = withContext(Dispatchers.IO) { repository.search(query) }
            searchHits = hits
        }
    }

    fun editCharacter(character: Character? = null) {
        characterEditing = character; characterEditorOpen = true
    }

    fun saveCharacter(name: String, notes: String, greeting: String) {
        if (name.isBlank()) { notice = Notice(R.string.character_name_required); return }
        viewModelScope.launch {
            runCatching {
                repository.save(Character(characterEditing?.id ?: UUID.randomUUID().toString(),
                    name.trim(), notes.trim(), greeting.trim(), characterEditing?.createdAt ?: System.currentTimeMillis()))
            }.onSuccess { characterEditorOpen = false }.onFailure { notice = Notice(R.string.character_save_failed) }
        }
    }

    fun startScene(character: Character) {
        viewModelScope.launch {
            val chat = Conversation(UUID.randomUUID().toString(), "roleplay", character.name, character.id)
            repository.save(chat)
            if (character.greeting.isNotBlank()) repository.save(ChatMessage(UUID.randomUUID().toString(), chat.id,
                "assistant", character.greeting), "roleplay")
            openChat(chat)
        }
    }

    /** Whether the selected provider already has a key in the vault. */
    var hasKey by mutableStateOf(false); private set

    fun refreshVaultState() {
        val provider = selection.provider
        viewModelScope.launch {
            hasKey = if (provider.isBlank()) false
            else withContext(Dispatchers.IO) { app.vault.has(provider) }
        }
    }

    fun saveProviderKey(provider: String, key: String) {
        if (provider.isBlank() || key.isBlank()) { notice = Notice(R.string.providers_needs_key); return }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { app.vault.save(provider, key) } }
                .onSuccess { hasKey = true; notice = null }
                .onFailure { notice = Notice(R.string.settings_save_failed) }
        }
    }

    fun saveModel(provider: String, model: String, persona: String) {
        if (model.isBlank()) { notice = Notice(R.string.model_configure_provider); return }
        viewModelScope.launch {
            app.preferences.save(ModelSelection(provider, model.trim(), persona.trim().ifEmpty { "You" }))
            notice = null
            refreshVaultState()
        }
    }

    fun savePersona(persona: String) {
        val current = selection
        viewModelScope.launch {
            app.preferences.save(current.copy(persona = persona.trim().ifEmpty { "You" }))
        }
    }

    fun discoverModels(provider: String, enteredKey: String) {
        if (discovering) return
        discovering = true
        viewModelScope.launch {
            try {
                val models = withContext(Dispatchers.IO) {
                    val key = enteredKey.trim().ifEmpty { app.vault.read(provider).orEmpty() }
                    val items = NativeBridge.data(NativeBridge.nativeDiscover(provider, key)) as JSONArray
                    (0 until items.length()).map { items.getJSONObject(it).getString("id") }
                }
                discoveredProvider = provider; discoveredModels = models.sorted(); notice = null
            } catch (failure: Exception) {
                notice = Notice(R.string.models_failed, failure.message)
            } finally { discovering = false }
        }
    }

    fun send() {
        if (workingChatId != null) { notice = Notice(R.string.reply_running); return }
        if (space == Space.Code || (space == Space.Roleplay && activeChat == null)) return
        val text = draft.trim()
        if (text.isEmpty()) return
        val selected = selection
        if (selected.provider.isEmpty() || selected.model.isEmpty()) { settingsOpen = true; return }
        val chat = activeChat ?: Conversation(UUID.randomUUID().toString(), space.wire, text.take(64))
        startTurn(chat, text, appendUser = true)
    }

    /**
     * Ask again: the answer being replaced is dropped and the same user turn runs
     * once more, so a retry never stacks two user messages into the history.
     */
    fun regenerate(answerId: String) {
        if (workingChatId != null) { notice = Notice(R.string.reply_running); return }
        val chat = activeChat ?: return
        val lastUser = messages.lastOrNull { it.role == "user" } ?: return
        if (lastUser.id == answerId) return
        viewModelScope.launch {
            repository.dao.deleteMessage(answerId)
            startTurn(chat, lastUser.content, appendUser = false)
        }
    }

    private fun startTurn(chat: Conversation, text: String, appendUser: Boolean) {
        val selected = selection
        val currentSpace = space.wire
        val openingRevision = navigationRevision
        // Mark working synchronously so repeated taps cannot start two turns.
        workingChatId = chat.id
        workingSince = System.currentTimeMillis()
        turn = viewModelScope.launch {
            var assistant: ChatMessage? = null
            try {
                val key = withContext(Dispatchers.IO) { app.vault.read(selected.provider) }
                if (key.isNullOrBlank()) { notice = Notice(R.string.providers_needs_key); return@launch }
                draftSave?.cancel()
                repository.save(chat.copy(draft = "", updatedAt = System.currentTimeMillis()))
                if (appendUser) {
                    app.preferences.saveDraft(currentSpace, "")
                    if (navigationRevision == openingRevision) { draft = ""; openChat(chat.copy(draft = "")) }
                }
                val history = repository.dao.history(chat.id)
                val user = if (appendUser) ChatMessage(UUID.randomUUID().toString(), chat.id, "user", text) else null
                if (user != null) repository.save(user, currentSpace)
                val anchor = user?.createdAt ?: history.lastOrNull()?.createdAt ?: System.currentTimeMillis()
                assistant = ChatMessage(UUID.randomUUID().toString(), chat.id, "assistant", "", status = "streaming", createdAt = anchor + 1)
                repository.save(assistant, currentSpace, journal = false)
                val wire = JSONArray()
                val character = chat.characterId?.let { repository.dao.character(it) }
                val prompt = if (character == null) "You are Agente, a helpful personal assistant. Answer clearly and directly."
                    else "You are ${character.name}. Stay in character in this fictional scene. The participant is ${selected.persona}.\n${resolveNames(character.notes, character.name, selected.persona)}"
                wire.put(JSONObject().put("role", "system").put("content", prompt))
                for (message in history.filter { it.status == "complete" || it.role == "user" }) {
                    val body = JSONObject().put("role", message.role)
                        .put("content", resolveNames(message.content, character?.name.orEmpty(), selected.persona))
                    if (message.thinking.isNotBlank()) body.put("thinking", message.thinking)
                    message.continuation?.let { body.put("continuation", JSONObject(it)) }
                    message.thinkingSignature?.let { body.put("thinking_signature", it) }
                    wire.put(body)
                }
                if (appendUser) wire.put(JSONObject().put("role", "user").put("content", text))
                val request = JSONObject().put("session_id", chat.id).put("provider", selected.provider)
                    .put("model", selected.model).put("api_key", key).put("messages", wire)
                nativeTurn = withContext(Dispatchers.IO) { NativeBridge.data(NativeBridge.nativeStart(request.toString())) as String }
                var settled = false
                var checkpoint = 0L
                while (!settled) {
                    delay(32)
                    val events = withContext(Dispatchers.IO) { NativeBridge.data(NativeBridge.nativePoll(nativeTurn!!)) as JSONArray }
                    for (index in 0 until events.length()) {
                        val event = events.getJSONObject(index)
                        val current = requireNotNull(assistant)
                        when (event.getString("type")) {
                            "text" -> assistant = current.copy(content = current.content + event.getString("text"))
                            "reasoning" -> assistant = current.copy(thinking = current.thinking + event.getString("text"))
                            "error" -> { notice = Notice(text = event.getString("message")); assistant = current.copy(status = "interrupted"); settled = true }
                            "done" -> {
                                assistant = current.copy(status = if (event.getBoolean("complete")) "complete" else "interrupted",
                                    continuation = event.optJSONObject("continuation")?.toString(),
                                    thinkingSignature = if (event.isNull("thinking_signature")) null else event.getString("thinking_signature"))
                                if (!event.getBoolean("complete")) notice = Notice(R.string.reply_interrupted)
                                settled = true
                            }
                        }
                    }
                    if (settled || System.currentTimeMillis() - checkpoint >= 150) {
                        repository.save(requireNotNull(assistant), currentSpace, journal = settled)
                        checkpoint = System.currentTimeMillis()
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                notice = Notice(R.string.thread_generation_failed, failure.message)
            } finally {
                nativeTurn?.let(NativeBridge::nativeCancel); nativeTurn = null
                val unfinished = assistant?.takeIf { it.status == "streaming" }
                if (unfinished != null) withContext(NonCancellable) {
                    repository.save(unfinished.copy(status = "interrupted"), currentSpace)
                }
                workingChatId = null; workingSince = null; turn = null
            }
        }
    }

    fun stop() { nativeTurn?.let(NativeBridge::nativeCancel); turn?.cancel() }
    fun dismissNotice() { notice = null }
    fun backgrounded() { saveDraftNow(); stop() }

    override fun onCleared() { nativeTurn?.let(NativeBridge::nativeCancel) }
}

/** Stored roleplay text remains raw; this initial scene UI resolves name macros
 * only. The complete desktop macro language is a subsequent parity milestone. */
fun resolveNames(raw: String, character: String, persona: String): String =
    raw.replace("{{char}}", character).replace("{{user}}", persona)
