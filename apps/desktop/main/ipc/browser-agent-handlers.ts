// ── browser agent IPC ──────────────────────────────────────────────────
// Home's browser tools run in the renderer and reach the shared driver here;
// the panel UI uses the takeover and history channels.

import type { IpcMain } from 'electron';
import { runBrowserAction, type BrowserActionName } from '../browser-actions.ts';
import { panelHistory, panelSetTakeover, withBrowserScope } from '../browser-panel.ts';

export function registerBrowserAgentHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('browser_agent_action', (_e, { action, args, scope } = {}) =>
    withBrowserScope(scope, () => runBrowserAction(action as BrowserActionName, (args ?? {}) as Record<string, unknown>, scope))
  );
  ipcMain.handle('browser_takeover', (_e, { on, scope } = {}) => withBrowserScope(scope, () => panelSetTakeover(!!on)));
  ipcMain.handle('browser_history', (_e, { action, tabId, scope } = {}) =>
    withBrowserScope(scope, () => panelHistory(action === 'back' || action === 'forward' ? action : 'reload', tabId))
  );
}
