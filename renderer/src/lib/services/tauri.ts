// Electron IPC bridge – replaces the Tauri bridge
// The preload script exposes `window.electronAPI` via contextBridge

type ElectronAPI = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  once: (channel: string, callback: (...args: unknown[]) => void) => void;
  windowMinimize: () => Promise<void>;
  windowToggleMaximize: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  windowClose: () => Promise<void>;
  windowRequestClose: () => Promise<{ closed: boolean; prompted: boolean }>;
  windowSetActiveWork: (active: boolean, reasons?: string[]) => Promise<unknown>;
  platform: string;
  isElectron: boolean;
};

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  // Primary check: contextBridge-exposed flag
  if (window.electronAPI?.isElectron) return true;
  // Fallback: Electron injects its version into the user agent
  if (typeof navigator !== 'undefined' && navigator.userAgent?.includes('Electron')) return true;
  return false;
}

// Keep isTauri as an alias so existing code that checks isTauri() works
export function isTauri(): boolean {
  return isElectron();
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isElectron()) {
    throw new Error(`Electron IPC not available in browser mode: ${command}`);
  }
  return window.electronAPI!.invoke(command, args) as Promise<T>;
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isElectron()) {
    return () => {};
  }
  return window.electronAPI!.on(event, (payload: unknown) => handler(payload as T));
}
