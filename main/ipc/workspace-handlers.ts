import type { IpcMain } from 'electron';

type WorkspaceHandlerDeps = {
  ipcMain: IpcMain;
  pathExists: (path: string) => unknown;
  openModelsFolder: () => unknown;
  pickWorkspaceFolder: () => unknown;
  pickModelFile: () => unknown;
  pickMmprojFile: () => unknown;
  pickWhisperRuntimeFile: () => unknown;
  indexWorkspaceFolder: (path: string, chatId: string) => unknown;
  snapshotWorkspaceFiles: (workspaceRoot: string) => unknown;
  writeWorkspaceFile: (workspaceRoot: string, relativePath: string, content: string) => unknown;
  readWorkspaceFile: (workspaceRoot: string, relativePath: string) => unknown;
  createWorkspaceDocument: (workspaceRoot: string, relativePath: string, docType: string, content: unknown) => unknown;
  renameWorkspaceFile: (workspaceRoot: string, oldPath: string, newPath: string) => unknown;
  deleteWorkspaceFile: (workspaceRoot: string, relativePath: string) => unknown;
  openWorkspaceFile: (absolutePath: string) => unknown;
  createWorkspaceFolder: (workspaceRoot: string, relativePath: string) => unknown;
  workspaceExec: (payload: unknown) => unknown;
  writeTempFile: (name: string, data: unknown) => unknown;
  resetMediaPermissions: () => unknown;
};

export function registerWorkspaceHandlers({
  ipcMain,
  pathExists,
  openModelsFolder,
  pickWorkspaceFolder,
  pickModelFile,
  pickMmprojFile,
  pickWhisperRuntimeFile,
  indexWorkspaceFolder,
  snapshotWorkspaceFiles,
  writeWorkspaceFile,
  readWorkspaceFile,
  createWorkspaceDocument,
  renameWorkspaceFile,
  deleteWorkspaceFile,
  openWorkspaceFile,
  createWorkspaceFolder,
  workspaceExec,
  writeTempFile,
  resetMediaPermissions,
}: WorkspaceHandlerDeps): void {
  ipcMain.handle('path_exists', (_e, { path }) => pathExists(path));
  ipcMain.handle('open_models_folder', () => openModelsFolder());
  ipcMain.handle('pick_workspace_folder', () => pickWorkspaceFolder());
  ipcMain.handle('pick_model_file', () => pickModelFile());
  ipcMain.handle('pick_mmproj_file', () => pickMmprojFile());
  ipcMain.handle('pick_whisper_runtime_file', () => pickWhisperRuntimeFile());
  ipcMain.handle('index_workspace_folder', (_e, { path, chatId }) => indexWorkspaceFolder(path, chatId));
  ipcMain.handle('snapshot_workspace_files', (_e, { workspaceRoot }) => snapshotWorkspaceFiles(workspaceRoot));
  ipcMain.handle('write_workspace_file', (_e, { workspaceRoot, relativePath, content }) => writeWorkspaceFile(workspaceRoot, relativePath, content));
  ipcMain.handle('read_workspace_file', (_e, { workspaceRoot, relativePath }) => readWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('create_workspace_document', (_e, { workspaceRoot, relativePath, docType, content }) =>
    createWorkspaceDocument(workspaceRoot, relativePath, docType, content));
  ipcMain.handle('rename_workspace_file', (_e, { workspaceRoot, oldPath, newPath }) => renameWorkspaceFile(workspaceRoot, oldPath, newPath));
  ipcMain.handle('delete_workspace_file', (_e, { workspaceRoot, relativePath }) => deleteWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('open_workspace_file', (_e, { absolutePath }) => openWorkspaceFile(absolutePath));
  ipcMain.handle('create_workspace_folder', (_e, { workspaceRoot, relativePath }) => createWorkspaceFolder(workspaceRoot, relativePath));
  ipcMain.handle('workspace_exec', (_e, payload) => workspaceExec(payload));
  ipcMain.handle('write_temp_file', (_e, { name, data }) => writeTempFile(name, data));
  ipcMain.handle('reset_media_permissions', () => resetMediaPermissions());
}
