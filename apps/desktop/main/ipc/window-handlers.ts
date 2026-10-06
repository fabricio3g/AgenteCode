import { BrowserWindow, clipboard, type IpcMain } from 'electron';
import type { UnknownRecord } from './types.ts';
import { applyTitlebarOverlay, openConversationWindow } from '../window-manager.ts';

type WindowHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  requestMainWindowClose: (win?: BrowserWindow | null) => { closed: boolean; prompted: boolean } | Promise<{ closed: boolean; prompted: boolean }>;
  setActiveWorkState: (state?: UnknownRecord, win?: BrowserWindow | null) => unknown;
};

export function registerWindowHandlers({
  ipcMain,
  requestMainWindowClose,
  setActiveWorkState,
}: WindowHandlerDeps): void {
  ipcMain.handle('window:open-conversation', (_event, args) => openConversationWindow(args?.chatId));
  ipcMain.handle('clipboard_write', (_e, args: { text?: unknown }) => {
    if (typeof args?.text !== 'string') throw new Error('Clipboard text is required');
    clipboard.writeText(args.text);
    return { ok: true };
  });

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  // The caption overlay is coloured once at window creation, but the theme
  // flips live. Without this the OS buttons keep the old theme's colours and
  // the window visibly pops out of place on every switch.
  ipcMain.handle('window:set-titlebar-overlay', (_e, payload) => {
    return applyTitlebarOverlay(BrowserWindow.fromWebContents(_e.sender), payload);
  });

  ipcMain.handle('window:close', (event) => {
    return requestMainWindowClose(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle('window:request-close', (event) => {
    return requestMainWindowClose(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle('window:set-active-work', (_e, payload) => {
    return setActiveWorkState((payload || {}) as UnknownRecord, BrowserWindow.fromWebContents(_e.sender));
  });
}
