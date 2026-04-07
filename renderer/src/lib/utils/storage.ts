import type { AppConfig, ChatSession, ChatFolder } from '$lib/types/chat';

const APP_CONFIG_KEY = 'talamolm_app_config';
const CHAT_STATE_KEY = 'talamolm_chat_state_v2';
const THEME_KEY = 'talamolm_theme';
const DB_MIGRATED_KEY = 'talamolm_db_migrated';

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isElectronEnv(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI;
}

export async function loadAppConfig(): Promise<AppConfig> {
  // In Electron: load from main process (persisted to disk), fall back to localStorage
  if (isElectronEnv()) {
    try {
      const stored = await (window as any).electronAPI.invoke('get_config') as AppConfig;
      if (stored && typeof stored === 'object') {
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

export function loadChatState<T>(fallback: T): T {
  return safeParse<T>(localStorage.getItem(CHAT_STATE_KEY), fallback);
}

export function saveChatState<T>(value: T): void {
  localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(value));
}

export async function loadChatStateFromDb(): Promise<{ chats: ChatSession[]; folders: ChatFolder[]; migrated: boolean } | null> {
  if (!isElectronEnv()) return null;
  try {
    const chats = await (window as any).electronAPI.invoke('chat_db_load_all') as ChatSession[];
    const folders = await (window as any).electronAPI.invoke('chat_db_load_folders') as ChatFolder[];

    // If DB is empty, try migration from localStorage
    if ((!chats || chats.length === 0) && !localStorage.getItem(DB_MIGRATED_KEY)) {
      const localState = loadChatState<{ chats: ChatSession[]; folders: ChatFolder[] }>({ chats: [], folders: [] });
      if (localState.chats?.length > 0 || localState.folders?.length > 0) {
        const migrated = await (window as any).electronAPI.invoke('chat_db_migrate', { persistedState: localState }) as number;
        console.log(`[chat-db] Migrated ${migrated} chats from localStorage to SQLite`);
        localStorage.setItem(DB_MIGRATED_KEY, '1');
        const migratedChats = await (window as any).electronAPI.invoke('chat_db_load_all') as ChatSession[];
        const migratedFolders = await (window as any).electronAPI.invoke('chat_db_load_folders') as ChatFolder[];
        return { chats: migratedChats || [], folders: migratedFolders || [], migrated: true };
      }
      localStorage.setItem(DB_MIGRATED_KEY, '1');
    }

    if (!chats || chats.length === 0) return null;
    return { chats, folders: folders || [], migrated: false };
  } catch (err) {
    console.error('[loadChatStateFromDb] Failed:', err);
    return null;
  }
}

export async function saveChatStateToDb(session: ChatSession): Promise<void> {
  if (!isElectronEnv()) return;
  try {
    const plain = JSON.parse(JSON.stringify(session));
    await (window as any).electronAPI.invoke('chat_db_save_session', { session: plain });
  } catch (err) {
    console.error('[saveChatStateToDb] Failed:', err);
  }
}

export async function deleteChatFromDb(chatId: string): Promise<void> {
  if (!isElectronEnv()) return;
  try {
    await (window as any).electronAPI.invoke('chat_db_delete', { chatId });
  } catch (err) {
    console.error('[deleteChatFromDb] Failed:', err);
  }
}

export function loadTheme(): 'light' | 'dark' | null {
  const value = localStorage.getItem(THEME_KEY);
  return value === 'light' || value === 'dark' ? value : null;
}

export function saveTheme(value: 'light' | 'dark'): void {
  localStorage.setItem(THEME_KEY, value);
}
