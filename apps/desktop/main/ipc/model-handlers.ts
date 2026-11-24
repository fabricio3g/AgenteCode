import type { IpcMain } from 'electron';

type ModelHandlerDeps = {
  ipcMain: IpcMain;
  getLocalModels: () => unknown;
  getGgufMetadata: (filePath: string) => unknown;
  deleteLocalModel: (path: string) => unknown;
  getModelsDirPath: () => unknown;
  getIndexedModels: () => unknown;
  refreshModelIndex: () => unknown;
  importLocalModel: (args: unknown) => unknown;
};

export function registerModelManagementHandlers({
  ipcMain,
  getLocalModels,
  getGgufMetadata,
  deleteLocalModel,
  getModelsDirPath,
  getIndexedModels,
  refreshModelIndex,
  importLocalModel,
}: ModelHandlerDeps): void {
  ipcMain.handle('get_local_models', () => getLocalModels());
  ipcMain.handle('get_gguf_metadata', (_e, { filePath }) => getGgufMetadata(filePath));
  ipcMain.handle('delete_local_model', (_e, args: { path?: unknown } = {}) => {
    if (typeof args?.path !== 'string' || !args.path.trim()) {
      throw new Error('Model path is required');
    }
    return deleteLocalModel(args.path);
  });
  ipcMain.handle('get_models_dir_path', () => getModelsDirPath());
  ipcMain.handle('get_indexed_models', () => getIndexedModels());
  ipcMain.handle('refresh_model_index', () => refreshModelIndex());
  ipcMain.handle('import_local_model', (_e, args) => importLocalModel(args));
}
