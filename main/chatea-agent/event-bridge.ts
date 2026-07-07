import type { BrowserWindow } from 'electron';
import type { CodeAgentEvent } from './types.ts';

export function emitCodeAgentEvent(win: BrowserWindow | null, event: CodeAgentEvent): void {
  if (!win) return;
  try {
    win.webContents?.send('code_agent_event', event);
  } catch {
    // window may be closed
  }
}
