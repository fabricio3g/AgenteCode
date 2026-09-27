import type { IpcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { UnknownRecord } from './types.ts';

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
