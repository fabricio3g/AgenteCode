// Settings → Voice: which voice models are downloaded, fetching one (with
// the app's resumable downloader, so it shows in Downloads with progress)
// and removing one.

import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { getAppPaths } from '../paths.ts';
import { startDownloadHf } from '../model-download.ts';
import { voiceModel, voiceModelRelPath } from '../../shared/voice-models.ts';
import { availableSpeechBackends, hasEspeak, installedVoiceModels, modelPath, unloadTts } from './audiocpp-tts.ts';

export function registerVoiceModelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('voice_models_status', () => ({
    installed: installedVoiceModels().map((model) => model.id),
    espeak: hasEspeak(),
    backends: availableSpeechBackends()
  }));

  ipcMain.handle('voice_model_download', (_e, args: { id: string }) => {
    const model = voiceModel(args.id);
    if (!model) throw new Error(`Unknown voice model ${args.id}`);
    return startDownloadHf({
      repoId: model.repo,
      file: model.file,
      modelsDir: getAppPaths().voiceModelsRoot,
      destRel: voiceModelRelPath(model),
      loadWhenReady: false
    });
  });

  ipcMain.handle('voice_model_delete', async (_e, args: { id: string }) => {
    const model = voiceModel(args.id);
    if (!model) return { deleted: false };
    // The server may have the file open: stop it first; it restarts on the next speech.
    await unloadTts();
    fs.rmSync(path.dirname(modelPath(model)), { recursive: true, force: true });
    return { deleted: true };
  });
}
