import type { IpcMain } from 'electron';
import type { BrowserWindow } from 'electron';

type RuntimeHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getInstalledRuntimes: () => unknown;
  deleteRuntimeBinary: (path: string) => unknown;
  downloadRuntime: (payload: unknown, win: BrowserWindow | null) => unknown;
};

export function registerRuntimeHandlers({
  ipcMain,
  getMainWindow,
  getInstalledRuntimes,
  deleteRuntimeBinary,
  downloadRuntime,
}: RuntimeHandlerDeps): void {
  ipcMain.handle('get_installed_runtimes', () => getInstalledRuntimes());
  ipcMain.handle('delete_runtime_binary', (_e, { path }) => deleteRuntimeBinary(path));
  ipcMain.handle('download_runtime', (_e, { payload }) => downloadRuntime(payload, getMainWindow()));
}
