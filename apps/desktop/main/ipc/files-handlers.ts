import type { IpcMain } from 'electron';
import { storedPathIn } from '../attachment-store.ts';

type StoredFileRow = { hash: string; storedPath?: string | null; name?: string } | null;

type FilesHandlerDeps = {
  ipcMain: IpcMain;
  listFiles: () => unknown;
  getFile: (hash: string) => Promise<StoredFileRow> | StoredFileRow;
  setFilePinned: (hash: string, pinned: boolean) => unknown;
  deleteFile: (hash: string) => Promise<unknown> | unknown;
  /** Electron's `shell.trashItem`: the OS trash, never a hard delete. */
  trashItem: (path: string) => Promise<void>;
};

export function registerFilesHandlers({
  ipcMain,
  listFiles,
  getFile,
  setFilePinned,
  deleteFile,
  trashItem,
}: FilesHandlerDeps): void {
  ipcMain.handle('files_list', () => listFiles());
  ipcMain.handle('files_pin', (_e, { hash, pinned }) => setFilePinned(hash, !!pinned));

  /**
   * Moves a stored file to the OS trash and forgets its registry row. Only paths
   * inside the attachment store are trashed; a row pointing anywhere else (a
   * generated document, say) just leaves the registry, because that file belongs
   * to its project and is deleted from there.
   */
  ipcMain.handle('files_trash', async (_e, { hash }) => {
    const file = await getFile(hash);
    if (!file) return { ok: false, error: 'unknown file' };
    const stored = storedPathIn(String(file.storedPath || ''));
    if (stored) {
      try {
        await trashItem(stored);
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    await deleteFile(hash);
    return { ok: true };
  });
}
