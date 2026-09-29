import type { TtsRequest } from '$lib/types/bridge';
import { invoke } from './bridge';

type TtsEvent = Record<string, unknown>;
type ElectronApi = {
  on: (event: string, cb: (evt: TtsEvent) => void) => () => void;
};

const LOG_PREFIX = '[TTS]';

function getElectronApi(): ElectronApi | null {
  const api = (window as Window & { electronAPI?: ElectronApi }).electronAPI;
  if (!api) {
    console.warn(`${LOG_PREFIX} electronAPI not available`);
    return null;
  }
  return api;
}

export async function unloadTts(): Promise<void> {
  await invoke<void>('unload_tts');
}

export async function generateTtsStream(request: TtsRequest & { volume?: number; requestId: string }): Promise<void> {
  await invoke<{ ok: boolean }>('generate_tts_stream', { request });
}

export function cancelTtsStream(): void {
  void invoke<void>('cancel_tts_stream').catch(() => {});
}

export function base64ToFloat32Pcm(base64: string): Float32Array {
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const samples = new Int16Array(buf, 0, raw.length / 2);
  const float32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    float32[i] = samples[i] / 32768;
  }
  return float32;
}

export function onTtsChunk(cb: (evt: TtsEvent) => void): () => void {
  const api = getElectronApi();
  if (!api) return () => {};

  return api.on('tts-chunk', cb);
}

export function onTtsStart(cb: (evt: TtsEvent) => void): () => void {
  const api = getElectronApi();
  if (!api) return () => {};

  return api.on('tts-start', cb);
}

export function onTtsDone(cb: (evt: TtsEvent) => void): () => void {
  const api = getElectronApi();
  if (!api) return () => {};

  return api.on('tts-done', cb);
}

export function onTtsError(cb: (evt: TtsEvent) => void): () => void {
  return getElectronApi()?.on('tts-error', cb) ?? (() => {});
}
