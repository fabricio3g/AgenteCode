import type { IpcMain } from 'electron';
import { cleanupEngines, getEngineOverview, openDataFolder, updateWhisperEngine } from '../engines.ts';
import { listWhisperReleases } from '../voice-setup.ts';

/** "On this computer": engines, updates and the data folder. */
export function registerEngineHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('get_engine_overview', () => getEngineOverview());
  ipcMain.handle('update_whisper_engine', (_e, args?: { tag?: string }) => updateWhisperEngine(args?.tag ? String(args.tag) : undefined));
  ipcMain.handle('list_whisper_releases', () => listWhisperReleases());
  ipcMain.handle('cleanup_engines', () => cleanupEngines());
  ipcMain.handle('open_data_folder', (_e, args?: { sub?: string }) => openDataFolder(String(args?.sub || '')));
}
