import type { IpcMain } from 'electron';

type ChatDbHandlerDeps = {
  ipcMain: IpcMain;
  saveChatSession: (session: unknown) => unknown;
  loadAllChats: () => unknown;
  deleteChatFromDb: (chatId: string) => Promise<unknown>;
  clearRagDocuments: (chatId: string) => Promise<unknown>;
  migrateFromLocalStorage: (persistedState: unknown) => unknown;
  loadAllFolders: () => unknown;
  saveFolder: (folder: unknown) => unknown;
  deleteFolder: (folderId: string) => unknown;
  loadRoleplayState: () => unknown;
  saveRoleplayState: (state: unknown) => unknown;
};

export function registerChatDbHandlers({
  ipcMain,
  saveChatSession,
  loadAllChats,
  deleteChatFromDb,
  clearRagDocuments,
  migrateFromLocalStorage,
  loadAllFolders,
  saveFolder,
  deleteFolder,
  loadRoleplayState,
  saveRoleplayState,
}: ChatDbHandlerDeps): void {
  ipcMain.handle('chat_db_save_session', (_e, { session }) => saveChatSession(session));
  ipcMain.handle('chat_db_load_all', () => loadAllChats());
  ipcMain.handle('chat_db_delete', async (_e, { chatId }) => {
    await deleteChatFromDb(chatId);
    clearRagDocuments(chatId).catch(() => {});
  });
  ipcMain.handle('chat_db_migrate', (_e, { persistedState }) => migrateFromLocalStorage(persistedState));
  ipcMain.handle('chat_db_load_folders', () => loadAllFolders());
  ipcMain.handle('chat_db_save_folder', (_e, { folder }) => saveFolder(folder));
  ipcMain.handle('chat_db_delete_folder', (_e, { folderId }) => deleteFolder(folderId));
  ipcMain.handle('roleplay_db_load_state', () => loadRoleplayState());
  ipcMain.handle('roleplay_db_save_state', (_e, { state }) => saveRoleplayState(state));
}
