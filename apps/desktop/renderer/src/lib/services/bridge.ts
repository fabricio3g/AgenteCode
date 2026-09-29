// Electron IPC bridge.
// The preload script exposes `window.electronAPI` via contextBridge.

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
  getZoomFactor?: () => number;
  setZoomFactor?: (factor: number) => void;
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
