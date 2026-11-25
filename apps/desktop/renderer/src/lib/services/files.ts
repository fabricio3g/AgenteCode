import type { LocalModel, StoredFile, WorkspaceIndexResult } from '$lib/types/bridge';
import { invoke } from './bridge';

export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>('path_exists', { path });
}

export async function listMmprojCandidates(modelPath: string): Promise<string[]> {
  return invoke<string[]>('list_mmproj_candidates', { modelPath });
}

export async function openModelsFolder(): Promise<void> {
  await invoke<void>('open_models_folder');
}

export async function getInstalledRuntimes(): Promise<{ runtimes: LocalModel[] }> {
  return invoke<{ runtimes: LocalModel[] }>('get_installed_runtimes');
}

export async function deleteRuntimeBinary(path: string): Promise<void> {
  await invoke<void>('delete_runtime_binary', { path });
}

export async function downloadRuntime(payload: {
  download_url: string;
  asset_name: string;
  release_tag: string;
  /** Extra archives extracted alongside the runtime, e.g. Windows CUDA `cudart-*`. */
  companions?: { asset_name: string; download_url: string }[];
}): Promise<{ success: boolean; runtime_id: string; path: string }> {
  return invoke<{ success: boolean; runtime_id: string; path: string }>('download_runtime', { payload });
}

export async function writeTempFile(name: string, data: Uint8Array): Promise<string> {
  return invoke<string>('write_temp_file', { name, data });
}

export type FolderListing = {
  path: string;
  parent: string | null;
  home: string;
  sep: string;
  places: Array<{ name: string; path: string }>;
  folders: Array<{ name: string; path: string; isProject: boolean }>;
};

/** One level of the in-app folder browser (the home folder when no path). */
export async function browseFolders(path?: string): Promise<FolderListing> {
  return invoke<FolderListing>('browse_folders', { path });
}

/** Create `<parent>/<name>` and `git init` it (main checks the name). */
export async function createProjectFolder(parent: string, name: string, git = true): Promise<{ path: string; gitInitialized?: boolean }> {
  return invoke('create_project_folder', { parent, name, git });
}

/** Clone a remote repository into `<parent>/<name>` (name defaults to the repo's). */
export async function cloneProjectRepo(url: string, parent: string, name?: string): Promise<{ path: string }> {
  return invoke('clone_project_repo', { url, parent, name });
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  return invoke<string | null>('pick_workspace_folder');
}

export async function pickModelFile(): Promise<string | null> {
  return invoke<string | null>('pick_model_file');
}

export async function pickMmprojFile(): Promise<string | null> {
  return invoke<string | null>('pick_mmproj_file');
}

export async function indexWorkspaceFolder(path: string, chat_id: string): Promise<WorkspaceIndexResult> {
  return invoke<WorkspaceIndexResult>('index_workspace_folder', { path, chatId: chat_id });
}

export async function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
  return invoke<string>('write_workspace_file', { workspaceRoot, relativePath, content });
}

export async function writeWorkspaceBinary(workspaceRoot: string, relativePath: string, dataUrl: string): Promise<string> {
  return invoke<string>('write_workspace_binary', { workspaceRoot, relativePath, dataUrl });
}

export async function createWorkspaceDocument(
  workspaceRoot: string,
  relativePath: string,
  docType: string,
  content: string
): Promise<string> {
  return invoke<string>('create_workspace_document', { workspaceRoot, relativePath, docType, content });
}

export async function renameWorkspaceFile(workspaceRoot: string, oldPath: string, newPath: string): Promise<void> {
  return invoke<void>('rename_workspace_file', { workspaceRoot, oldPath, newPath });
}

export async function deleteWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<void> {
  return invoke<void>('delete_workspace_file', { workspaceRoot, relativePath });
}

export async function readWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<string> {
  return invoke<string>('read_workspace_file', { workspaceRoot, relativePath });
}

export async function openWorkspaceFile(absolutePath: string, workspaceRoot?: string): Promise<void> {
  return invoke<void>('open_workspace_file', { absolutePath, workspaceRoot });
}

export async function createWorkspaceFolder(workspaceRoot: string, relativePath: string): Promise<void> {
  return invoke<void>('create_workspace_folder', { workspaceRoot, relativePath });
}

// --- File registry (main/chat-db.ts `files` table) ---
// One row per sha256 of the file's content, rather than one row per chat. The
// TUI/CLI is a separate front end on the Rust core and has its own store, so
// this registry describes the files this app holds.

export async function listFiles(): Promise<StoredFile[]> {
  return invoke<StoredFile[]>('files_list');
}

/** Returns the updated row, or null when the hash is unknown. */
export async function setFilePinned(hash: string, pinned: boolean): Promise<StoredFile | null> {
  return invoke<StoredFile | null>('files_pin', { hash, pinned });
}

/**
 * Moves the app's stored copy to the OS trash and forgets the row. Only files
 * inside this app's attachment store are trashed.
 */
export async function trashStoredFile(hash: string): Promise<{ ok: boolean; error?: string }> {
  return invoke<{ ok: boolean; error?: string }>('files_trash', { hash });
}
