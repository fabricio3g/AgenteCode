// Settings → Voice: the voice model catalog, which models are downloaded,
// fetching one (every file, with the app's resumable downloader, so it shows
// in Downloads with progress) and removing one.

import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { getAppPaths } from '../paths.ts';
import { startDownloadHf } from '../model-download.ts';
import { voiceFileRelPath, voiceModelFiles } from '../../shared/voice-models.ts';
import { speechEngineStatus, unloadTts } from './audiocpp-tts.ts';
import { findVoiceModel, voiceCatalogWithSizes } from './voice-catalog.ts';

function referencesDir(): string {
  return path.join(getAppPaths().voiceModelsRoot, 'references');
}

export function registerVoiceModelHandlers(ipcMain: IpcMain): void {
  // Voice cloning: keep the reference clip (a 24 kHz mono WAV made in the renderer).
  ipcMain.handle('voice_clone_save', (_e, args: { name: string; wavBase64: string; transcript?: string; seconds?: number }) => {
    const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const dir = referencesDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.wav`);
    fs.writeFileSync(file, Buffer.from(args.wavBase64, 'base64'));
    const name = String(args.name || '').trim().slice(0, 60) || 'Voice';
    const transcript = args.transcript?.trim();
    return { id, name, file, ...(transcript ? { transcript } : {}), ...(args.seconds ? { seconds: args.seconds } : {}) };
  });
  ipcMain.handle('voice_clone_delete', (_e, args: { file: string }) => {
    const dir = path.resolve(referencesDir());
    const target = path.resolve(String(args.file || ''));
    if (path.dirname(target) !== dir) return false;
    fs.rmSync(target, { force: true });
    return true;
  });

  // The engine and its models in one answer: Settings → Voice and
  // Settings → On this computer both read it.
  ipcMain.handle('voice_models_status', () => speechEngineStatus());

  // Every text-to-speech model the bundled engine can run.
  ipcMain.handle('voice_catalog', () => voiceCatalogWithSizes());

  // Apply a backend or thread change now rather than on the next reply.
  ipcMain.handle('voice_engine_restart', () => unloadTts());

  ipcMain.handle('voice_model_download', async (_e, args: { id: string }) => {
    const model = findVoiceModel(args.id);
    if (!model) throw new Error(`Unknown voice model ${args.id}`);
    const jobs: string[] = [];
    for (const file of voiceModelFiles(model)) {
      jobs.push(await startDownloadHf({
        repoId: model.repo,
        file,
        modelsDir: getAppPaths().voiceModelsRoot,
        destRel: voiceFileRelPath(model, file),
        loadWhenReady: false
      }));
    }
    return jobs;
  });

  ipcMain.handle('voice_model_delete', async (_e, args: { id: string }) => {
    const model = findVoiceModel(args.id);
    if (!model) return { deleted: false };
    // The server may have the files open: stop it first; it restarts on the next speech.
    await unloadTts();
    fs.rmSync(path.join(getAppPaths().voiceModelsRoot, 'audiocpp', model.id), { recursive: true, force: true });
    return { deleted: true };
  });
}
