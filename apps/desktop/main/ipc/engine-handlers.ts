import type { IpcMain } from 'electron';
import { checkWhisperUpdate, cleanupEngines, getEngineOverview, openDataFolder, updateWhisperEngine } from '../engines.ts';

/** "On this computer": engines, updates and the data folder. */
export function registerEngineHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('get_engine_overview', () => getEngineOverview());
  ipcMain.handle('check_whisper_update', () => checkWhisperUpdate());
  ipcMain.handle('update_whisper_engine', () => updateWhisperEngine());
  ipcMain.handle('cleanup_engines', () => cleanupEngines());
  ipcMain.handle('open_data_folder', (_e, args?: { sub?: string }) => openDataFolder(String(args?.sub || '')));
}
