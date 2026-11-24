import type { IpcMain, BrowserWindow } from 'electron';

type LlmRunnerHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  startLlama: (config: unknown, win: BrowserWindow | null) => unknown;
  stopLlama: (win: BrowserWindow | null) => unknown;
  getSupervisorStatus: () => unknown;
  getRuntimeTelemetry: () => unknown;
  getRecommendedSettings: (modelPath: string, userContext: unknown, userGpuLayers: unknown, runtimePath: string) => unknown;
  previewLocalModelCommand: (config: unknown) => unknown;
  getEmbeddingStatus: () => unknown;
};

export function registerLlmRunnerHandlers({
  ipcMain,
  getMainWindow,
  startLlama,
  stopLlama,
  getSupervisorStatus,
  getRuntimeTelemetry,
  getRecommendedSettings,
  previewLocalModelCommand,
  getEmbeddingStatus,
}: LlmRunnerHandlerDeps): void {
  ipcMain.handle('start_llama', (_e, { config }) => startLlama(config, getMainWindow()));
  ipcMain.handle('stop_llama', () => stopLlama(getMainWindow()));
  ipcMain.handle('get_supervisor_status', () => getSupervisorStatus());
  ipcMain.handle('get_runtime_telemetry', () => getRuntimeTelemetry());
  ipcMain.handle('get_recommended_settings', (_e, { modelPath, userContext, userGpuLayers, runtimePath }) =>
    getRecommendedSettings(modelPath, userContext, userGpuLayers, runtimePath));
  ipcMain.handle('preview_local_model_command', (_e, { config }) => previewLocalModelCommand(config));

  ipcMain.handle('get_embedding_status', () => getEmbeddingStatus());
}
