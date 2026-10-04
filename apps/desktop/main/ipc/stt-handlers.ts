import { BrowserWindow, type IpcMain } from 'electron';
import { listSpeechModels, removeSpeechModel, setupVoice, useSpeechModel, voiceSetupPlan } from '../voice-setup.ts';
import type { UnknownRecord } from './types.ts';

type SttHandlerDeps = {
  ipcMain: IpcMain;
  transcribeAudio: (args?: UnknownRecord) => Promise<unknown>;
  getSttStatus: () => unknown;
  unloadWhisper: () => void;
  preloadWhisper: () => Promise<void>;
};

function normalizeIpcAudioArgs(args: UnknownRecord = {}): UnknownRecord {
  const normalized: UnknownRecord = { ...args };
  const audioBytes = args.audio_bytes;

  if (audioBytes && typeof audioBytes === 'object' && !Buffer.isBuffer(audioBytes)) {
    const src = audioBytes as Record<string, number> & { length?: number };
    const len = src.length !== undefined ? src.length : Object.keys(src).filter((k) => /^\d+$/.test(k)).length;
    const copy = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      copy[i] = src[i] ?? 0;
    }
    normalized.audio_bytes = copy;
  }

  return normalized;
}

export function registerSttHandlers({ ipcMain, transcribeAudio, getSttStatus, unloadWhisper, preloadWhisper }: SttHandlerDeps): void {
  ipcMain.handle('stt_transcribe', (_e, args) => {
    const normalizedArgs = normalizeIpcAudioArgs((args || {}) as UnknownRecord);
    return transcribeAudio(normalizedArgs);
  });

  ipcMain.handle('get_stt_status', () => getSttStatus());
  ipcMain.handle('preload_whisper', () => preloadWhisper());
  ipcMain.handle('unload_whisper', () => unloadWhisper());
  ipcMain.handle('voice_setup_plan', (_e, args?: { quality?: string }) => voiceSetupPlan(args?.quality));
  ipcMain.handle('setup_voice', (e, args?: { quality?: string }) => setupVoice(BrowserWindow.fromWebContents(e.sender), args?.quality));
  ipcMain.handle('list_speech_models', () => listSpeechModels());
  ipcMain.handle('use_speech_model', (_e, args: { quality: string }) => useSpeechModel(String(args?.quality || '')));
  ipcMain.handle('remove_speech_model', (_e, args: { quality: string }) => removeSpeechModel(String(args?.quality || '')));
}
