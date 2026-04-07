import { invoke } from './tauri';

export interface RuntimeRecommendations {
  platform: 'linux' | 'macos' | 'windows';
  arch: 'x64' | 'arm64';
  gpu_backend: string;
  has_gpu: boolean;
  recommended_variant: string;
}

let cached: RuntimeRecommendations | null = null;

export async function getRuntimeRecommendations(): Promise<RuntimeRecommendations> {
  if (cached) return cached;
  cached = await invoke<RuntimeRecommendations>('get_runtime_recommendations');
  return cached!;
}

/** Invalidate cache so next call fetches fresh data */
export function invalidateRuntimeRecommendations() {
  cached = null;
}
