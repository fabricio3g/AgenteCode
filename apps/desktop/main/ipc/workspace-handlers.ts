import type { IpcMain } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { readWorkspaceBinary } from '../filesystem.ts';
import { cloneProjectRepo, createProjectFolder, expandHome } from '../project-setup.ts';

/** Files that mark a folder as a project root in the folder browser. */
const PROJECT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'deno.json', 'composer.json', 'Gemfile'];

/**
 * One level of the in-app folder browser: the folder's subfolders (hidden ones
 * left out, project roots flagged), its parent, and the user's usual places.
 * Folders only, never file contents, so it reveals no more than a native
 * folder picker would.
 */
async function browseFolders(requested?: string) {
  const home = os.homedir();
  // A typed path may start with `~`.
  const target = requested ? expandHome(requested, home) : home;
  const entries = await fs.readdir(target, { withFileTypes: true });
  const folders = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(async (entry) => {
      const full = nodePath.join(target, entry.name);
      const inside = await fs.readdir(full).catch(() => [] as string[]);
      return { name: entry.name, path: full, isProject: inside.some((name) => PROJECT_MARKERS.includes(name)) };
    }));
  folders.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const candidates = ['Desktop', 'Documents', 'Downloads', 'Projects', 'projects', 'Code', 'code', 'src', 'dev', 'repos', 'workspace'];
  const places = [{ name: 'Home', path: home }];
  for (const name of candidates) {
    const full = nodePath.join(home, name);
    if (await fs.stat(full).then((stat) => stat.isDirectory(), () => false)) places.push({ name, path: full });
  }
  const parent = nodePath.dirname(target);
  return { path: target, parent: parent === target ? null : parent, home, sep: nodePath.sep, places, folders };
}

type WorkspaceHandlerDeps = {
  ipcMain: IpcMain;
  pathExists: (path: string) => unknown;
  listMmprojCandidates: (modelPath: string) => unknown;
  openModelsFolder: () => unknown;
  pickWorkspaceFolder: () => unknown;
  pickModelFile: () => unknown;
  pickMmprojFile: () => unknown;
  pickWhisperRuntimeFile: () => unknown;
  indexWorkspaceFolder: (path: string, chatId: string) => unknown;
  writeWorkspaceFile: (workspaceRoot: string, relativePath: string, content: string) => unknown;
  writeWorkspaceBinary: (workspaceRoot: string, relativePath: string, dataUrl: string) => unknown;
  readWorkspaceFile: (workspaceRoot: string, relativePath: string) => unknown;
  createWorkspaceDocument: (workspaceRoot: string, relativePath: string, docType: string, content: unknown) => unknown;
  renameWorkspaceFile: (workspaceRoot: string, oldPath: string, newPath: string) => unknown;
  deleteWorkspaceFile: (workspaceRoot: string, relativePath: string) => unknown;
  openWorkspaceFile: (absolutePath: string, workspaceRoot?: string) => unknown;
  createWorkspaceFolder: (workspaceRoot: string, relativePath: string) => unknown;
  workspaceExec: (payload: unknown) => unknown;
  writeTempFile: (name: string, data: unknown) => unknown;
};

export function registerWorkspaceHandlers({
  ipcMain,
  pathExists,
  listMmprojCandidates,
  openModelsFolder,
  pickWorkspaceFolder,
  pickModelFile,
  pickMmprojFile,
  pickWhisperRuntimeFile,
  indexWorkspaceFolder,
  writeWorkspaceFile, writeWorkspaceBinary,
  readWorkspaceFile,
  createWorkspaceDocument,
  renameWorkspaceFile,
  deleteWorkspaceFile,
  openWorkspaceFile,
  createWorkspaceFolder,
  workspaceExec,
  writeTempFile,
}: WorkspaceHandlerDeps): void {
  ipcMain.handle('path_exists', (_e, { path }) => pathExists(path));
  ipcMain.handle('list_mmproj_candidates', (_e, { modelPath }) => listMmprojCandidates(modelPath));
  ipcMain.handle('browse_folders', (_e, { path } = {}) => browseFolders(typeof path === 'string' ? path : undefined));
  ipcMain.handle('open_models_folder', () => openModelsFolder());
  ipcMain.handle('create_project_folder', (_e, { parent, name, git } = {}) =>
    createProjectFolder({ parent: String(parent ?? ''), name: String(name ?? ''), git: git !== false }));
  ipcMain.handle('clone_project_repo', (_e, { url, parent, name } = {}) =>
    cloneProjectRepo({ url: String(url ?? ''), parent: String(parent ?? ''), name: typeof name === 'string' ? name : undefined }));
  ipcMain.handle('pick_workspace_folder', () => pickWorkspaceFolder());
  ipcMain.handle('pick_model_file', () => pickModelFile());
  ipcMain.handle('pick_mmproj_file', () => pickMmprojFile());
  ipcMain.handle('pick_whisper_runtime_file', () => pickWhisperRuntimeFile());
  ipcMain.handle('index_workspace_folder', (_e, { path, chatId }) => indexWorkspaceFolder(path, chatId));
  ipcMain.handle('write_workspace_file', (_e, { workspaceRoot, relativePath, content }) => writeWorkspaceFile(workspaceRoot, relativePath, content));
  ipcMain.handle('write_workspace_binary', (_e, { workspaceRoot, relativePath, dataUrl }) => writeWorkspaceBinary(workspaceRoot, relativePath, dataUrl));
  ipcMain.handle('read_workspace_file', (_e, { workspaceRoot, relativePath }) => readWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('read_workspace_binary', (_e, { workspaceRoot, relativePath }) => readWorkspaceBinary(workspaceRoot, relativePath));
  ipcMain.handle('create_workspace_document', (_e, { workspaceRoot, relativePath, docType, content }) =>
    createWorkspaceDocument(workspaceRoot, relativePath, docType, content));
  ipcMain.handle('rename_workspace_file', (_e, { workspaceRoot, oldPath, newPath }) => renameWorkspaceFile(workspaceRoot, oldPath, newPath));
  ipcMain.handle('delete_workspace_file', (_e, { workspaceRoot, relativePath }) => deleteWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('open_workspace_file', (_e, { absolutePath, workspaceRoot }) => openWorkspaceFile(absolutePath, workspaceRoot));
  ipcMain.handle('create_workspace_folder', (_e, { workspaceRoot, relativePath }) => createWorkspaceFolder(workspaceRoot, relativePath));
  ipcMain.handle('workspace_exec', (_e, payload) => workspaceExec(payload));
  ipcMain.handle('write_temp_file', (_e, { name, data }) => writeTempFile(name, data));
}
