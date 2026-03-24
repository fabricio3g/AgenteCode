import type { TtsRequest } from '$lib/types/tauri';
import { invoke } from './tauri';

export async function generateTts(request: TtsRequest): Promise<string> {
  return invoke<string>('generate_tts', { request });
}

export async function unloadTts(): Promise<void> {
  await invoke<void>('unload_tts');
}

export async function checkEspeakData(models_dir: string): Promise<{ found: boolean; path?: string; source?: string }> {
  return invoke<{ found: boolean; path?: string; source?: string }>('check_espeak_data', { modelsDir: models_dir });
}
