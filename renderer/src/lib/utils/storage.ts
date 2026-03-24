import type { AppConfig } from '$lib/types/chat';

const APP_CONFIG_KEY = 'talamolm_app_config';
const CHAT_STATE_KEY = 'talamolm_chat_state_v2';
const THEME_KEY = 'talamolm_theme';

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

export function loadTheme(): 'light' | 'dark' | null {
  const value = localStorage.getItem(THEME_KEY);
  return value === 'light' || value === 'dark' ? value : null;
}

export function saveTheme(value: 'light' | 'dark'): void {
  localStorage.setItem(THEME_KEY, value);
}
