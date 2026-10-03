/** SQLite executes serially on one worker, away from Electron's UI/main thread. */
import { parentPort, workerData } from 'node:worker_threads';
import * as database from './chat-db';
database.setChatDbPath(workerData.databasePath);
const operations = {
  saveChatSession: database.saveChatSession, saveChatDraft: database.saveChatDraft,
  loadAllChats: database.loadAllChats, searchChatContent: database.searchChatContent,
  deleteChatFromDb: database.deleteChat, migrateFromLocalStorage: database.migrateFromLocalStorage,
  loadAllFolders: database.loadAllFolders, saveFolder: database.saveFolder, deleteFolder: database.deleteFolder,
  loadAllCodeProjects: database.loadAllCodeProjects, saveCodeProject: database.saveCodeProject, deleteCodeProject: database.deleteCodeProject,
  loadAllCharacters: database.loadAllCharacters, saveCharacter: database.saveCharacter, deleteCharacter: database.deleteCharacter,
  loadAllPersonas: database.loadAllPersonas, savePersona: database.savePersona, deletePersona: database.deletePersona,
  loadAllWorlds: database.loadAllWorlds, saveWorld: database.saveWorld, deleteWorld: database.deleteWorld,
  close: database.closeDb
};
parentPort!.on('message', ({ id, operation, args }) => {
  try {
    const handler = operations[operation as keyof typeof operations];
    if (!handler) throw new Error('Unknown database operation');
    const result = (handler as (...args: unknown[]) => unknown)(...args);
    parentPort!.postMessage({ id, result });
  } catch (cause) {
    parentPort!.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) });
  }
});
