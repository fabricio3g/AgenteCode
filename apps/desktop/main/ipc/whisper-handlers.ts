import type { IpcMain } from 'electron';
import { listWhisperBinaries, deleteWhisperBinary } from '../whisper-resolver.ts';

type WhisperHandlerDeps = {
  ipcMain: IpcMain;
};

export function registerWhisperHandlers({ ipcMain }: WhisperHandlerDeps): void {
  ipcMain.handle('get_whisper_runtimes', () => listWhisperBinaries());

  ipcMain.handle('delete_whisper_runtime', (_e, { path: binPath }: { path: string }) => {
    deleteWhisperBinary(binPath);
    return { success: true };
  });
}
