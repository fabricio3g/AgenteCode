import type { IpcMain } from 'electron';

type ChatDbHandlerDeps = {
  ipcMain: IpcMain;
  saveChatSession: (session: unknown) => unknown;
  loadAllChats: () => unknown;
  searchChatContent: (query: string, limit?: number) => unknown;
  deleteChatFromDb: (chatId: string) => Promise<unknown>;
  clearRagDocuments: (chatId: string) => Promise<unknown>;
  migrateFromLocalStorage: (persistedState: unknown) => unknown;
  loadAllFolders: () => unknown;
  saveFolder: (folder: unknown) => unknown;
  deleteFolder: (folderId: string) => unknown;
  loadAllCodeProjects: () => unknown;
  saveCodeProject: (project: unknown) => unknown;
  deleteCodeProject: (projectId: string) => unknown;
  loadAllCharacters: () => unknown;
  saveCharacter: (character: unknown) => unknown;
  deleteCharacter: (characterId: string) => unknown;
  loadAllPersonas: () => unknown;
  savePersona: (persona: unknown) => unknown;
  deletePersona: (personaId: string) => unknown;
  loadAllWorlds: () => unknown;
  saveWorld: (world: unknown) => unknown;
  deleteWorld: (worldId: string) => unknown;
};

export function registerChatDbHandlers({
  ipcMain,
  saveChatSession,
  loadAllChats,
  searchChatContent,
  deleteChatFromDb,
  clearRagDocuments,
  migrateFromLocalStorage,
  loadAllFolders,
  saveFolder,
  deleteFolder,
  loadAllCodeProjects,
  saveCodeProject,
  deleteCodeProject,
  loadAllCharacters,
  saveCharacter,
  deleteCharacter,
  loadAllPersonas,
  savePersona,
  deletePersona,
  loadAllWorlds,
  saveWorld,
  deleteWorld,
}: ChatDbHandlerDeps): void {
  ipcMain.handle('chat_db_save_session', (_e, { session }) => saveChatSession(session));
  ipcMain.handle('chat_db_load_all', () => loadAllChats());
  ipcMain.handle('chat_db_search_content', (_e, { query, limit }) => searchChatContent(String(query ?? ''), Number(limit) || 30));
  ipcMain.handle('chat_db_delete', async (_e, { chatId }) => {
    await deleteChatFromDb(chatId);
    clearRagDocuments(chatId).catch(() => {});
  });
  ipcMain.handle('chat_db_migrate', (_e, { persistedState }) => migrateFromLocalStorage(persistedState));
  ipcMain.handle('chat_db_load_folders', () => loadAllFolders());
  ipcMain.handle('chat_db_save_folder', (_e, { folder }) => saveFolder(folder));
  ipcMain.handle('chat_db_delete_folder', (_e, { folderId }) => deleteFolder(folderId));
  ipcMain.handle('chat_db_load_code_projects', () => loadAllCodeProjects());
  ipcMain.handle('chat_db_save_code_project', (_e, { project }) => saveCodeProject(project));
  ipcMain.handle('chat_db_delete_code_project', (_e, { projectId }) => deleteCodeProject(projectId));
  ipcMain.handle('chat_db_load_characters', () => loadAllCharacters());
  ipcMain.handle('chat_db_save_character', (_e, { character }) => saveCharacter(character));
  ipcMain.handle('chat_db_delete_character', (_e, { characterId }) => deleteCharacter(characterId));
  ipcMain.handle('chat_db_load_personas', () => loadAllPersonas());
  ipcMain.handle('chat_db_save_persona', (_e, { persona }) => savePersona(persona));
  ipcMain.handle('chat_db_delete_persona', (_e, { personaId }) => deletePersona(personaId));
  ipcMain.handle('chat_db_load_worlds', () => loadAllWorlds());
  ipcMain.handle('chat_db_save_world', (_e, { world }) => saveWorld(world));
  ipcMain.handle('chat_db_delete_world', (_e, { worldId }) => deleteWorld(worldId));
}
