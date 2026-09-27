import type { IpcMain, BrowserWindow } from 'electron';
import { listWhisperBinaries, deleteWhisperBinary } from '../whisper-resolver.ts';
import { downloadWhisperRuntime } from '../whisper-download.ts';

type WhisperHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
};

export function registerWhisperHandlers({ ipcMain, getMainWindow }: WhisperHandlerDeps): void {
  ipcMain.handle('get_whisper_runtimes', () => listWhisperBinaries());

  ipcMain.handle('delete_whisper_runtime', (_e, { path: binPath }: { path: string }) => {
    deleteWhisperBinary(binPath);
    return { success: true };
  });

  ipcMain.handle('download_whisper_runtime', (_e, { payload }: { payload: { download_url: string; asset_name: string; release_tag: string } }) => {
    return downloadWhisperRuntime(payload, getMainWindow());
  });
}
