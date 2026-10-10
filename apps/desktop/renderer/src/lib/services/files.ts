import type { FileRef, FileStoreStats, LocalModel, StoredFile, WorkspaceIndexResult } from '$lib/types/bridge';
import { invoke } from './bridge';

export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>('path_exists', { path });
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

async function resetMediaPermissions(): Promise<{ removed: string[]; failed: string[] }> {
  return invoke<{ removed: string[]; failed: string[] }>('reset_media_permissions');
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

async function workspaceExec(payload: {
  workspace_root: string;
  command: string;
  args?: string[];
  cwd?: string;
  shell?: boolean;
  timeout_ms?: number;
}): Promise<{
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code?: number | null;
  timed_out: boolean;
}> {
  return invoke('workspace_exec', payload);
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

export async function getFile(hash: string): Promise<StoredFile | null> {
  return invoke<StoredFile | null>('files_get', { hash });
}

/** Every chat message that uses this file. */
export async function listFileRefs(hash: string): Promise<FileRef[]> {
  return invoke<FileRef[]>('files_refs', { hash });
}

/** Returns the updated row, or null when the hash is unknown. */
export async function setFilePinned(hash: string, pinned: boolean): Promise<StoredFile | null> {
  return invoke<StoredFile | null>('files_pin', { hash, pinned });
}

export async function fileStats(): Promise<FileStoreStats> {
  return invoke<FileStoreStats>('files_stats');
}

/**
 * Moves the app's stored copy to the OS trash and forgets the row. Only files
 * inside this app's attachment store are trashed.
 */
export async function trashStoredFile(hash: string): Promise<{ ok: boolean; error?: string }> {
  return invoke<{ ok: boolean; error?: string }>('files_trash', { hash });
}
