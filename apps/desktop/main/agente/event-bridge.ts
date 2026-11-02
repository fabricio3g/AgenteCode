// ── Event bridge to the renderer ───────────────────────────────────────
import { BrowserWindow } from 'electron';
import type { CodeAgentEvent } from '../../shared/agente-protocol.ts';
import { notifyActivity } from '../notifications.ts';

let getMainWindow: (() => BrowserWindow | null) | null = null;

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  getMainWindow = fn;
}

export function getCodeMainWindow(): BrowserWindow | null {
  return getMainWindow?.() ?? null;
}

export function emitCodeAgentEvent(win: BrowserWindow | null, event: CodeAgentEvent): void {
  if (event.type === 'agent_end' && event.stopReason !== 'aborted') notifyActivity({ id: `code-${event.chatId}-${Date.now()}`, chatId: event.chatId, space: 'code', title: event.stopReason === 'error' ? 'Task failed' : 'Task finished', body: 'Open Code to review the result.' }, win?.webContents);
  if (event.type === 'approval_request') notifyActivity({ id: `approval-${event.requestId}`, chatId: event.chatId, space: 'code', title: 'Approval needed', body: 'An agent is waiting for your decision.' }, win?.webContents);
  const targets = new Set([...BrowserWindow.getAllWindows(), ...(win ? [win] : [])]);
  for (const target of targets) try {
    if (!target.isDestroyed()) target.webContents?.send('code_agent_event', event);
  } catch {
    // window may be closed
  }
}
