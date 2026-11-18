import type { IpcMain } from 'electron';

type ChatDbHandlerDeps = {
  ipcMain: IpcMain;
  saveChatSession: (session: unknown) => unknown;
  saveChatDraft: (chatId: string, draft: string, codeAgent: unknown, updatedAt: number, pendingPrompts?: unknown) => boolean | Promise<unknown>;
  loadAllChats: () => unknown;
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

export function registerChatDbHandlers(deps: ChatDbHandlerDeps): void {
  deps.ipcMain.handle('chat_db_save_draft', (_e, { chatId, draft, codeAgent, updatedAt, pendingPrompts }) => deps.saveChatDraft(chatId, draft, codeAgent, updatedAt, pendingPrompts));
  deps.ipcMain.handle('chat_db_save_session', (_e, { session }) => deps.saveChatSession(session));
  deps.ipcMain.handle('chat_db_load_all', () => deps.loadAllChats());
  deps.ipcMain.handle('chat_db_delete', async (_e, { chatId }) => {
    await deps.deleteChatFromDb(chatId);
    deps.clearRagDocuments(chatId).catch(() => {});
  });
  deps.ipcMain.handle('chat_db_migrate', (_e, { persistedState }) => deps.migrateFromLocalStorage(persistedState));
  deps.ipcMain.handle('chat_db_load_folders', () => deps.loadAllFolders());
  deps.ipcMain.handle('chat_db_save_folder', (_e, { folder }) => deps.saveFolder(folder));
  deps.ipcMain.handle('chat_db_delete_folder', (_e, { folderId }) => deps.deleteFolder(folderId));
  deps.ipcMain.handle('chat_db_load_code_projects', () => deps.loadAllCodeProjects());
  deps.ipcMain.handle('chat_db_save_code_project', (_e, { project }) => deps.saveCodeProject(project));
  deps.ipcMain.handle('chat_db_delete_code_project', (_e, { projectId }) => deps.deleteCodeProject(projectId));
  deps.ipcMain.handle('chat_db_load_characters', () => deps.loadAllCharacters());
  deps.ipcMain.handle('chat_db_save_character', (_e, { character }) => deps.saveCharacter(character));
  deps.ipcMain.handle('chat_db_delete_character', (_e, { characterId }) => deps.deleteCharacter(characterId));
  deps.ipcMain.handle('chat_db_load_personas', () => deps.loadAllPersonas());
  deps.ipcMain.handle('chat_db_save_persona', (_e, { persona }) => deps.savePersona(persona));
  deps.ipcMain.handle('chat_db_delete_persona', (_e, { personaId }) => deps.deletePersona(personaId));
  deps.ipcMain.handle('chat_db_load_worlds', () => deps.loadAllWorlds());
  deps.ipcMain.handle('chat_db_save_world', (_e, { world }) => deps.saveWorld(world));
  deps.ipcMain.handle('chat_db_delete_world', (_e, { worldId }) => deps.deleteWorld(worldId));
}
