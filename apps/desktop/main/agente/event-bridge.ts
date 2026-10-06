// ── Event bridge to the renderer ───────────────────────────────────────
import { BrowserWindow } from 'electron';
import type { CodeAgentEvent } from '../../shared/agente-protocol.ts';

let getMainWindow: (() => BrowserWindow | null) | null = null;

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  getMainWindow = fn;
}

export function getCodeMainWindow(): BrowserWindow | null {
  return getMainWindow?.() ?? null;
}

export function emitCodeAgentEvent(win: BrowserWindow | null, event: CodeAgentEvent): void {
  const targets = new Set([...BrowserWindow.getAllWindows(), ...(win ? [win] : [])]);
  for (const target of targets) try {
    if (!target.isDestroyed()) target.webContents?.send('code_agent_event', event);
  } catch {
    // window may be closed
  }
}
