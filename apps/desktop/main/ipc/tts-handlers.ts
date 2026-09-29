import type { IpcMain, BrowserWindow } from 'electron';

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
  unloadTts: () => void | Promise<void>;
  checkEspeakData: (modelsDir: string) => unknown;
  listVoices: () => string[];
  onWorkerMessage: (handler: (msg: TtsWorkerMessage) => void) => void;
  logger?: (message: string, ...args: unknown[]) => void;
};

export function registerTtsHandlers({
  ipcMain,
  getMainWindow,
  initTts,
  generateTtsStream,
  cancelTtsStream,
  unloadTts,
  checkEspeakData,
  listVoices,
  onWorkerMessage,
  logger,
}: TtsHandlerDeps): void {
  const log = logger || (() => {});

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
    void Promise.resolve(generateTtsStream(request, null)).catch((error) => forwardTtsWorkerMessage({
      type: 'error', requestId: request?.requestId, message: error instanceof Error ? error.message : String(error)
    }));
    return { ok: true };
  });

  ipcMain.handle('cancel_tts_stream', () => {
    cancelTtsStream();
  });

  ipcMain.handle('unload_tts', () => unloadTts());
  ipcMain.handle('check_espeak_data', (_e, { modelsDir }) => checkEspeakData(modelsDir));
  ipcMain.handle('preload_tts', async () => initTts());
  ipcMain.handle('list_tts_voices', () => listVoices());
  ipcMain.handle('read_file_base64', async (_e, { filePath }: { filePath: string }) => {
    const fs = await import('node:fs');
    const data = await fs.promises.readFile(filePath);
    return data.toString('base64');
  });
}
