import type { CachedModelMeta, GgufMeta, LocalModel } from '$lib/types/tauri';
import { invoke } from './tauri';

export async function getLocalModels(): Promise<LocalModel[]> {
  const response = await invoke<{ models: LocalModel[] }>('get_local_models');
  return response.models || [];
}

export async function getIndexedModels(): Promise<CachedModelMeta[]> {
  return invoke<CachedModelMeta[]>('get_indexed_models');
}

export async function refreshModelIndex(): Promise<number> {
  return invoke<number>('refresh_model_index');
}

export async function invalidateModelCache(path: string): Promise<void> {
  await invoke<void>('invalidate_model_cache', { path });
}

export async function getGgufMetadata(filePath: string): Promise<GgufMeta> {
  return invoke<GgufMeta>('get_gguf_metadata', { filePath });
}

export async function deleteLocalModel(path: string): Promise<void> {
  await invoke<void>('delete_local_model', { path });
}

export async function getModelsDirPath(): Promise<string> {
  return invoke<string>('get_models_dir_path');
}

export async function importLocalModel(
  filePath: string,
  copy_to_managed = false
): Promise<{ success: boolean; model: LocalModel }> {
  return invoke<{ success: boolean; model: LocalModel }>('import_local_model', {
    filePath,
    copy_to_managed
  });
}
