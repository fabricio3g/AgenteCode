import { clipboard, type IpcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { UnknownRecord } from './types.ts';
import { applyTitlebarOverlay } from '../window-manager.ts';

type WindowHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  requestMainWindowClose: () => { closed: boolean; prompted: boolean } | Promise<{ closed: boolean; prompted: boolean }>;
  setActiveWorkState: (state?: UnknownRecord) => unknown;
};

export function registerWindowHandlers({
  ipcMain,
  getMainWindow,
  requestMainWindowClose,
  setActiveWorkState,
}: WindowHandlerDeps): void {
  ipcMain.handle('clipboard_write', (_e, args: { text?: unknown }) => {
    if (typeof args?.text !== 'string') throw new Error('Clipboard text is required');
    clipboard.writeText(args.text);
    return { ok: true };
  });

  ipcMain.handle('window:minimize', () => {
    const win = getMainWindow();
    win?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', async () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle('window:is-maximized', () => {
    return getMainWindow()?.isMaximized() ?? false;
  });

  // The caption overlay is coloured once at window creation, but the theme
  // flips live. Without this the OS buttons keep the old theme's colours and
  // the window visibly pops out of place on every switch.
  ipcMain.handle('window:set-titlebar-overlay', (_e, payload) => {
    return applyTitlebarOverlay(getMainWindow(), payload);
  });

  ipcMain.handle('window:close', () => {
    return requestMainWindowClose();
  });

  ipcMain.handle('window:request-close', () => {
    return requestMainWindowClose();
  });

  ipcMain.handle('window:set-active-work', (_e, payload) => {
    return setActiveWorkState((payload || {}) as UnknownRecord);
  });
}
