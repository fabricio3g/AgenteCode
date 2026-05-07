import type { IpcMain, BrowserWindow } from 'electron';

type LlmRunnerHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  startLlama: (config: unknown, win: BrowserWindow | null) => unknown;
  stopLlama: (win: BrowserWindow | null) => unknown;
  getSupervisorStatus: () => unknown;
  supervisorHealthCheck: () => unknown;
  getLoadedModels: () => unknown;
  unloadModel: (modelId: string, win: BrowserWindow | null) => unknown;
  getRecommendedSettings: (modelPath: string, userContext: unknown, userGpuLayers: unknown, runtimePath: string) => unknown;
  startEmbeddingServer: (config: unknown, win: BrowserWindow | null) => unknown;
  stopEmbeddingServer: () => unknown;
  getEmbeddingStatus: () => unknown;
};

export function registerLlmRunnerHandlers({
  ipcMain,
  getMainWindow,
  startLlama,
  stopLlama,
  getSupervisorStatus,
  supervisorHealthCheck,
  getLoadedModels,
  unloadModel,
  getRecommendedSettings,
  startEmbeddingServer,
  stopEmbeddingServer,
  getEmbeddingStatus,
}: LlmRunnerHandlerDeps): void {
  ipcMain.handle('start_llama', (_e, { config }) => startLlama(config, getMainWindow()));
  ipcMain.handle('stop_llama', () => stopLlama(getMainWindow()));
  ipcMain.handle('get_supervisor_status', () => getSupervisorStatus());
  ipcMain.handle('supervisor_health_check', () => supervisorHealthCheck());
  ipcMain.handle('get_loaded_models', () => getLoadedModels());
  ipcMain.handle('unload_model', (_e, { modelId }) => unloadModel(modelId, getMainWindow()));
  ipcMain.handle('get_recommended_settings', (_e, { modelPath, userContext, userGpuLayers, runtimePath }) =>
    getRecommendedSettings(modelPath, userContext, userGpuLayers, runtimePath));

  ipcMain.handle('start_embedding_server', (_e, { config }) => startEmbeddingServer(config, getMainWindow()));
  ipcMain.handle('stop_embedding_server', () => stopEmbeddingServer());
  ipcMain.handle('get_embedding_status', () => getEmbeddingStatus());
}
