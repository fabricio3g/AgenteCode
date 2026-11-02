import type { AppConfig, ChatSession, ChatFolder, CharacterCard, CodeProject, RoleplayWorld, UserPersona } from '$lib/types/chat';
import { isElectron } from '$lib/services/bridge';
import { THEME_STORAGE_KEY } from '$shared/window-theme';
import { WriteQueue } from './write-queue';

const chatWrites = new WriteQueue<ChatSession>(async session => {
  const plain = JSON.parse(JSON.stringify(session));
  await window.electronAPI!.invoke('chat_db_save_session', { session: plain });
});
export const flushChatSaves = () => chatWrites.flush();

const APP_CONFIG_KEY = 'chatealm_app_config';
/** Chat navigation state. Exported so the dev harness can boot into a fixture. */
export const CHAT_STATE_KEY = 'chatealm_chat_state_v2';
const THEME_KEY = THEME_STORAGE_KEY;
const DB_MIGRATED_KEY = 'chatealm_db_migrated';
/** Set once the legacy localStorage backup's extra payloads were copied into SQLite. */
const DB_BACKFILLED_KEY = 'chatealm_db_backfilled';
const CHARACTERS_KEY = 'chatealm_characters_v1';
const PERSONAS_KEY = 'chatealm_personas_v1';
const WORLDS_KEY = 'chatealm_worlds_v1';

export function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeWhitespace(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function isElectronEnv(): boolean {
  // Single source of truth lives in services/bridge (flag + UA fallback).
  return isElectron();
}

function mergeDocumentPayloadsFromLocal(dbChats: ChatSession[], localChats: ChatSession[]): ChatSession[] {
  if (!dbChats.length || !localChats.length) return dbChats;

  const localChatById = new Map(localChats.map((chat) => [chat.id, chat]));

  return dbChats.map((chat) => {
    const localChat = localChatById.get(chat.id);
    if (!localChat?.messages?.length) return chat;

    const localMessageById = new Map(localChat.messages.map((message) => [message.id, message]));
    return {
      ...chat,
      messages: (chat.messages || []).map((message) => {
        const localMessage = localMessageById.get(message.id);
        if (!localMessage) return message;

        const merged = {
          ...message,
          metadata: message.metadata || localMessage.metadata,
          sources: message.sources?.length ? message.sources : (localMessage.sources || []),
          searchMeta: message.searchMeta || localMessage.searchMeta || null,
          agentSteps: message.agentSteps?.length ? message.agentSteps : (localMessage.agentSteps || []),
          ragDocuments: message.ragDocuments?.length ? message.ragDocuments : (localMessage.ragDocuments || []),
          slides: message.slides?.length ? message.slides : (localMessage.slides || []),
          workContext: message.workContext || localMessage.workContext || null,
          filesCreated: message.filesCreated?.length ? message.filesCreated : (localMessage.filesCreated || []),
          artifact: message.artifact || localMessage.artifact || null
        };

        if (message.attachments?.length && localMessage.attachments?.length) {
          const localAttachmentById = new Map(localMessage.attachments.map((attachment) => [attachment.id, attachment]));
          merged.attachments = message.attachments.map((attachment) => {
            const localAttachment = localAttachmentById.get(attachment.id);
            if (!localAttachment) return attachment;
            return {
              ...attachment,
              data: attachment.data || localAttachment.data,
              base64: attachment.base64 || localAttachment.base64,
              preview: attachment.preview || localAttachment.preview
            };
          });
        } else if (!message.attachments?.length && localMessage.attachments?.length) {
          merged.attachments = localMessage.attachments;
        }

        return merged;
      })
    };
  });
}

export async function loadAppConfig(): Promise<AppConfig> {
  // In Electron: load from main process (persisted to disk), fall back to localStorage
  if (isElectronEnv()) {
    try {
      const stored = await (window as any).electronAPI.invoke('get_config') as AppConfig;
      if (stored && typeof stored === 'object') {
        // IPC config has API keys redacted for security. Restore keys from
        // existing localStorage so that freshly saved keys survive the
        // refresh cycle (saveAppConfig → refreshModels → loadAppConfig).
        const prev = safeParse<AppConfig>(localStorage.getItem(APP_CONFIG_KEY), {} as AppConfig);
        const storedProviders = stored?.llm?.providers || {};
        const prevProviders = prev?.llm?.providers || {};
        // Copy API keys from localStorage into matching IPC providers that
        // main does not hold a key for yet (a stored one stays out of here)
        for (const name of Object.keys(storedProviders)) {
          const prevKey = prevProviders[name]?.api_key;
          if (prevKey && !storedProviders[name].api_key && !storedProviders[name].has_api_key) {
            storedProviders[name].api_key = prevKey;
            delete storedProviders[name].has_api_key;
          }
        }
        // Also copy providers that exist in localStorage but not yet in IPC config
        for (const name of Object.keys(prevProviders)) {
          if (!storedProviders[name] && prevProviders[name]?.api_key) {
            const llm = (stored as any).llm ?? ((stored as any).llm = {});
            const providers = llm.providers ?? (llm.providers = {});
            providers[name] = { ...prevProviders[name] };
          }
        }
        localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(stored));
        return stored;
      }
    } catch (err) {
      console.error('[loadAppConfig] IPC get_config failed:', err);
    }
  }
  return safeParse<AppConfig>(localStorage.getItem(APP_CONFIG_KEY), {} as AppConfig);
}

export async function saveAppConfig(next: AppConfig): Promise<void> {
  // Serialize to plain JSON to strip Svelte 5 reactive proxies — Electron's
  // structured-clone IPC cannot handle Proxy objects and would throw DataCloneError.
  const plain = JSON.parse(JSON.stringify(next)) as AppConfig;
  localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(plain));
  if (isElectronEnv()) {
    try {
      await (window as any).electronAPI.invoke('save_config', plain);
    } catch (err) {
      console.error('[saveAppConfig] IPC save_config failed:', err);
    }
  }
}

/**
 * Navigation state (current chat, space, …). In Electron that is the small
 * `.navigation` key alone: the legacy key under CHAT_STATE_KEY is a pre-SQLite
 * backup of every transcript — tens of MB on an old profile — and parsing it
 * on the UI thread is what made startup slow. It is read only to migrate or
 * backfill (`loadLegacyChats`), never on the startup path.
 */
export function loadChatState<T>(fallback: T): T {
  const navigation = isElectronEnv()
    ? safeParse<Record<string, unknown> | null>(localStorage.getItem(`${CHAT_STATE_KEY}.navigation`), null)
    : null;
  if (navigation) return { ...fallback, ...navigation };
  return safeParse<T>(localStorage.getItem(CHAT_STATE_KEY), fallback);
}

/** The pre-SQLite transcript backup, for migration and the one-time backfill only. */
function loadLegacyChats(): { chats: ChatSession[]; folders: ChatFolder[] } {
  const legacy = safeParse<{ chats?: ChatSession[]; folders?: ChatFolder[] }>(localStorage.getItem(CHAT_STATE_KEY), {});
  return { chats: Array.isArray(legacy.chats) ? legacy.chats : [], folders: Array.isArray(legacy.folders) ? legacy.folders : [] };
}

export function saveChatState<T>(value: T): void {
  if (isElectronEnv() && value && typeof value === 'object' && 'chats' in value) {
    // SQLite owns complete transcripts. Keep the old backup for migration, but
    // stop serializing attachments and every conversation on the UI thread.
    const { chats: _chats, ...navigation } = value as Record<string, unknown>;
    localStorage.setItem(`${CHAT_STATE_KEY}.navigation`, JSON.stringify(navigation));
  } else localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(value));
}

export async function loadChatStateFromDb(): Promise<{ chats: ChatSession[]; folders: ChatFolder[]; migrated: boolean } | null> {
  if (!isElectronEnv()) return null;
  try {
    const [chats, folders] = await Promise.all([
      (window as any).electronAPI.invoke('chat_db_load_all') as Promise<ChatSession[]>,
      (window as any).electronAPI.invoke('chat_db_load_folders') as Promise<ChatFolder[]>
    ]);

    // If DB is empty, try migration from localStorage
    if ((!chats || chats.length === 0) && !localStorage.getItem(DB_MIGRATED_KEY)) {
      const localState = loadLegacyChats();
      if (localState.chats.length > 0 || localState.folders.length > 0) {
        const migrated = await (window as any).electronAPI.invoke('chat_db_migrate', { persistedState: localState }) as number;
        console.log(`[chat-db] Migrated ${migrated} chats from localStorage to SQLite`);
        localStorage.setItem(DB_MIGRATED_KEY, '1');
        const migratedChats = await (window as any).electronAPI.invoke('chat_db_load_all') as ChatSession[];
        const migratedFolders = await (window as any).electronAPI.invoke('chat_db_load_folders') as ChatFolder[];
        return {
          chats: mergeDocumentPayloadsFromLocal(migratedChats || [], localState.chats || []),
          folders: migratedFolders || [],
          migrated: true
        };
      }
      localStorage.setItem(DB_MIGRATED_KEY, '1');
    }

    if (!chats || chats.length === 0) return null;
    return {
      chats: await backfillFromLegacy(chats),
      folders: folders || [],
      migrated: false
    };
  } catch (err) {
    console.error('[loadChatStateFromDb] Failed:', err);
    return null;
  }
}

/**
 * Older SQLite rows can lack payloads (agent steps, sources, attachment data)
 * that only the legacy localStorage backup kept. They used to be merged back on
 * every startup, which meant parsing the whole backup every time. Now the merge
 * runs once: chats that had a twin in the backup are written back to SQLite,
 * then the backup itself is removed — SQLite holds everything it had, and
 * Chromium loads an origin's whole localStorage into memory on first use, so a
 * stale tens-of-MB value slows every launch even unread. Only reached with a
 * non-empty database, so a failed migration never loses the backup.
 */
async function backfillFromLegacy(chats: ChatSession[]): Promise<ChatSession[]> {
  if (localStorage.getItem(DB_BACKFILLED_KEY)) {
    localStorage.removeItem(CHAT_STATE_KEY);
    return chats;
  }
  const legacy = loadLegacyChats().chats;
  const merged = mergeDocumentPayloadsFromLocal(chats, legacy);
  const changed = merged.filter((chat, index) => chat !== chats[index]);
  let complete = true;
  for (const chat of changed) {
    try {
      await (window as any).electronAPI.invoke('chat_db_save_session', { session: JSON.parse(JSON.stringify(chat)) });
    } catch (err) {
      complete = false;
      console.error('[backfillFromLegacy] Failed:', err);
    }
  }
  // A failed write leaves the flag and the backup in place, so the next startup tries again.
  if (complete) {
    localStorage.setItem(DB_BACKFILLED_KEY, '1');
    localStorage.removeItem(CHAT_STATE_KEY);
  }
  return merged;
}

export async function saveChatDraftToDb(session: ChatSession): Promise<void> {
  if (!isElectronEnv()) return;
  await chatWrites.flush(session.id);
  const saved = await (window as any).electronAPI.invoke('chat_db_save_draft', {
    chatId: session.id, draft: session.draft, updatedAt: session.updatedAt,
    pendingPrompts: JSON.parse(JSON.stringify(session.pendingPrompts ?? [])),
    codeAgent: session.codeAgent ? JSON.parse(JSON.stringify(session.codeAgent)) : null
  });
  // Older/missing rows still receive the complete session once.
  if (!saved) await saveChatStateToDb(session);
}

export async function saveChatStateToDb(session: ChatSession): Promise<void> {
  if (!isElectronEnv()) return;
  try {
    await chatWrites.enqueue(session.id, session);
  } catch (err) {
    console.error('[saveChatStateToDb] Failed:', err);
  }
}

export async function deleteChatFromDb(chatId: string): Promise<void> {
  if (!isElectronEnv()) return;
  try {
    await chatWrites.flush(chatId);
    await (window as any).electronAPI.invoke('chat_db_delete', { chatId });
  } catch (err) {
    console.error('[deleteChatFromDb] Failed:', err);
  }
}

export async function loadCodeProjectsFromDb(): Promise<CodeProject[]> {
  if (!isElectronEnv()) return [];
  try {
    const projects = await (window as any).electronAPI.invoke('chat_db_load_code_projects') as CodeProject[];
    return projects || [];
  } catch (err) {
    console.error('[loadCodeProjectsFromDb] Failed:', err);
    return [];
  }
}

export async function saveCodeProjectToDb(project: CodeProject): Promise<void> {
  if (!isElectronEnv()) return;
  try {
    await (window as any).electronAPI.invoke('chat_db_save_code_project', { project });
  } catch (err) {
    console.error('[saveCodeProjectToDb] Failed:', err);
  }
}

export async function deleteCodeProjectFromDb(projectId: string): Promise<void> {
  if (!isElectronEnv()) return;
  try {
    await (window as any).electronAPI.invoke('chat_db_delete_code_project', { projectId });
  } catch (err) {
    console.error('[deleteCodeProjectFromDb] Failed:', err);
  }
}

// --- Roleplay: characters & personas ---
// Electron persists to SQLite; the browser dev fallback uses localStorage so
// the gallery still works in `npm run dev:renderer`.

export async function loadCharactersFromDb(): Promise<CharacterCard[]> {
  if (!isElectronEnv()) {
    return safeParse<CharacterCard[]>(localStorage.getItem(CHARACTERS_KEY), []);
  }
  try {
    const characters = await (window as any).electronAPI.invoke('chat_db_load_characters') as CharacterCard[];
    return Array.isArray(characters) ? characters : [];
  } catch (err) {
    console.error('[loadCharactersFromDb] Failed:', err);
    return [];
  }
}

export async function saveCharacterToDb(character: CharacterCard): Promise<void> {
  if (!isElectronEnv()) {
    const current = safeParse<CharacterCard[]>(localStorage.getItem(CHARACTERS_KEY), []);
    const next = [character, ...current.filter((entry) => entry.id !== character.id)];
    localStorage.setItem(CHARACTERS_KEY, JSON.stringify(next));
    return;
  }
  try {
    const plain = JSON.parse(JSON.stringify(character));
    await (window as any).electronAPI.invoke('chat_db_save_character', { character: plain });
  } catch (err) {
    console.error('[saveCharacterToDb] Failed:', err);
  }
}

export async function deleteCharacterFromDb(characterId: string): Promise<void> {
  if (!isElectronEnv()) {
    const current = safeParse<CharacterCard[]>(localStorage.getItem(CHARACTERS_KEY), []);
    localStorage.setItem(CHARACTERS_KEY, JSON.stringify(current.filter((entry) => entry.id !== characterId)));
    return;
  }
  try {
    await (window as any).electronAPI.invoke('chat_db_delete_character', { characterId });
  } catch (err) {
    console.error('[deleteCharacterFromDb] Failed:', err);
  }
}

export async function loadPersonasFromDb(): Promise<UserPersona[]> {
  if (!isElectronEnv()) {
    return safeParse<UserPersona[]>(localStorage.getItem(PERSONAS_KEY), []);
  }
  try {
    const personas = await (window as any).electronAPI.invoke('chat_db_load_personas') as UserPersona[];
    return Array.isArray(personas) ? personas : [];
  } catch (err) {
    console.error('[loadPersonasFromDb] Failed:', err);
    return [];
  }
}

export async function savePersonaToDb(persona: UserPersona): Promise<void> {
  if (!isElectronEnv()) {
    const current = safeParse<UserPersona[]>(localStorage.getItem(PERSONAS_KEY), []);
    const next = [persona, ...current.filter((entry) => entry.id !== persona.id)];
    localStorage.setItem(PERSONAS_KEY, JSON.stringify(next));
    return;
  }
  try {
    const plain = JSON.parse(JSON.stringify(persona));
    await (window as any).electronAPI.invoke('chat_db_save_persona', { persona: plain });
  } catch (err) {
    console.error('[savePersonaToDb] Failed:', err);
  }
}

export async function deletePersonaFromDb(personaId: string): Promise<void> {
  if (!isElectronEnv()) {
    const current = safeParse<UserPersona[]>(localStorage.getItem(PERSONAS_KEY), []);
    localStorage.setItem(PERSONAS_KEY, JSON.stringify(current.filter((entry) => entry.id !== personaId)));
    return;
  }
  try {
    await (window as any).electronAPI.invoke('chat_db_delete_persona', { personaId });
  } catch (err) {
    console.error('[deletePersonaFromDb] Failed:', err);
  }
}

export async function loadWorldsFromDb(): Promise<RoleplayWorld[]> {
  if (!isElectronEnv()) {
    return safeParse<RoleplayWorld[]>(localStorage.getItem(WORLDS_KEY), []);
  }
  try {
    const worlds = await (window as any).electronAPI.invoke('chat_db_load_worlds') as RoleplayWorld[];
    return Array.isArray(worlds) ? worlds : [];
  } catch (err) {
    console.error('[loadWorldsFromDb] Failed:', err);
    return [];
  }
}

export async function saveWorldToDb(world: RoleplayWorld): Promise<void> {
  if (!isElectronEnv()) {
    const current = safeParse<RoleplayWorld[]>(localStorage.getItem(WORLDS_KEY), []);
    const next = [world, ...current.filter((entry) => entry.id !== world.id)];
    localStorage.setItem(WORLDS_KEY, JSON.stringify(next));
    return;
  }
  try {
    const plain = JSON.parse(JSON.stringify(world));
    await (window as any).electronAPI.invoke('chat_db_save_world', { world: plain });
  } catch (err) {
    console.error('[saveWorldToDb] Failed:', err);
  }
}

export async function deleteWorldFromDb(worldId: string): Promise<void> {
  if (!isElectronEnv()) {
    const current = safeParse<RoleplayWorld[]>(localStorage.getItem(WORLDS_KEY), []);
    localStorage.setItem(WORLDS_KEY, JSON.stringify(current.filter((entry) => entry.id !== worldId)));
    return;
  }
  try {
    await (window as any).electronAPI.invoke('chat_db_delete_world', { worldId });
  } catch (err) {
    console.error('[deleteWorldFromDb] Failed:', err);
  }
}

export function loadTheme(): 'light' | 'dark' | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch { return null; }
}

export function saveTheme(value: 'light' | 'dark'): void {
  try { localStorage.setItem(THEME_KEY, value); } catch { /* Apply even when storage is unavailable. */ }
}
