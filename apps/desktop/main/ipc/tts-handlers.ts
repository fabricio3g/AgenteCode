import type { IpcMain, BrowserWindow } from 'electron';
import { loadConfig } from '../config.ts';
import { apiVoices, synthesizeApi } from '../voice/speech-api.ts';
import { splitSentences } from '../voice/audiocpp-tts.ts';

type TtsWorkerMessage = {
  type: string;
  id?: number;
  total?: number;
  index?: number;
  base64?: string;
  requestId?: string;
  message?: string;
};

type TtsHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  initTts: () => Promise<string[]>;
  generateTtsStream: (request: unknown, win: BrowserWindow | null) => void | Promise<void>;
  cancelTtsStream: () => void;
  onWorkerMessage: (handler: (msg: TtsWorkerMessage) => void) => void;
  logger?: (message: string, ...args: unknown[]) => void;
};

export function registerTtsHandlers({
  ipcMain,
  getMainWindow,
  initTts,
  generateTtsStream,
  cancelTtsStream,
  onWorkerMessage,
  logger,
}: TtsHandlerDeps): void {
  const log = logger || (() => {});
  let apiSpeech: AbortController | null = null;

  const forwardTtsWorkerMessage = (msg: TtsWorkerMessage) => {
    const win = getMainWindow();
    if (msg.type === 'chunk' || msg.type === 'done' || msg.type === 'start') {
      log('Worker msg:', msg.type, 'id:', msg.id, 'index:', msg.index ?? '-', 'win:', !!win);
    }
    if (!win) return;

    if (msg.type === 'start' && typeof msg.id === 'number' && typeof msg.total === 'number') {
      win.webContents.send('tts-start', { seq: msg.id, requestId: msg.requestId, total: msg.total });
      return;
    }

    if (
      msg.type === 'chunk' &&
      typeof msg.id === 'number' &&
      typeof msg.index === 'number' &&
      typeof msg.total === 'number' &&
      typeof msg.base64 === 'string'
    ) {
      win.webContents.send('tts-chunk', { seq: msg.id, requestId: msg.requestId, index: msg.index, total: msg.total, base64: msg.base64 });
      return;
    }

    if (msg.type === 'done' && typeof msg.id === 'number' && typeof msg.total === 'number') {
      win.webContents.send('tts-done', { seq: msg.id, requestId: msg.requestId, total: msg.total });
      return;
    }
    if (msg.type === 'error') {
      win.webContents.send('tts-error', { seq: msg.id, requestId: msg.requestId, message: msg.message || 'Voice generation failed.' });
    }
  };

  onWorkerMessage(forwardTtsWorkerMessage);

  ipcMain.handle('generate_tts_stream', (_e, { request }) => {
    log('generate_tts_stream called');
    apiSpeech?.abort();
    const config = loadConfig();
    if ((request?.backend ?? config.tts?.backend_mode) === 'api') {
      cancelTtsStream();
      const controller = new AbortController();
      apiSpeech = controller;
      const run = async () => {
        const providerId = request.provider || config.tts.api_provider;
        const provider = config.tts.providers?.[providerId];
        if (!provider) throw new Error('Configure the speech provider in Settings → Voice.');
        const sentences = splitSentences(request.text || '');
        const send = (type: string, fields = {}) => {
          if (!controller.signal.aborted) getMainWindow()?.webContents.send(`tts-${type}`, { requestId: request.requestId, total: sentences.length, ...fields });
        };
        send('start');
        for (const [index, text] of sentences.entries()) {
          const pcm = await synthesizeApi(provider, { ...request, text }, controller.signal);
          const volume = Math.max(0, Math.min(2, request.volume ?? 1));
          if (volume !== 1) for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(at) * volume))), at);
          send('chunk', { index, base64: pcm.toString('base64') });
        }
        send('done');
      };
      void run().catch((error) => {
        if (!controller.signal.aborted) forwardTtsWorkerMessage({ type: 'error', requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
      });
      return { ok: true };
    }
    void Promise.resolve(generateTtsStream(request, null)).catch((error) => forwardTtsWorkerMessage({
      type: 'error', requestId: request?.requestId, message: error instanceof Error ? error.message : String(error)
    }));
    return { ok: true };
  });

  ipcMain.handle('cancel_tts_stream', () => {
    apiSpeech?.abort();
    cancelTtsStream();
  });

  ipcMain.handle('preload_tts', async () => initTts());
  ipcMain.handle('list_speech_voices', async (_e, { provider: id }) => {
    const provider = loadConfig().tts?.providers?.[id];
    return provider ? apiVoices(provider) : [];
  });
  ipcMain.handle('read_file_base64', async (_e, { filePath }: { filePath: string }) => {
    const fs = await import('node:fs');
    const data = await fs.promises.readFile(filePath);
    return data.toString('base64');
  });
}
