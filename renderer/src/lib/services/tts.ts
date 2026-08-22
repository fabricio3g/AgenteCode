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

export function generateTtsStream(request: TtsRequest & { volume?: number }): void {
  console.log(`${LOG_PREFIX} Sending generate_tts_stream:`, request.text?.slice(0, 30));
  invoke<{ ok: boolean }>('generate_tts_stream', { request });
}

export function cancelTtsStream(): void {
  invoke<void>('cancel_tts_stream');
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

  console.log(`${LOG_PREFIX} Subscribing to tts-chunk`);
  return api.on('tts-chunk', (evt) => {
    console.log(`${LOG_PREFIX} tts-chunk event received:`, JSON.stringify(evt).slice(0, 200));
    cb(evt);
  });
}

export function onTtsStart(cb: (evt: TtsEvent) => void): () => void {
  const api = getElectronApi();
  if (!api) return () => {};

  return api.on('tts-start', (evt) => {
    console.log(`${LOG_PREFIX} tts-start event received:`, JSON.stringify(evt));
    cb(evt);
  });
}

export function onTtsDone(cb: (evt: TtsEvent) => void): () => void {
  const api = getElectronApi();
  if (!api) return () => {};

  console.log(`${LOG_PREFIX} Subscribing to tts-done`);
  return api.on('tts-done', (evt) => {
    console.log(`${LOG_PREFIX} tts-done event received:`, JSON.stringify(evt));
    cb(evt);
  });
}

async function initWorker(): Promise<string[]> {
  const voices = await invoke<string[]>('list_tts_voices');
  if (voices?.length) return voices;
  // Trigger init
  await invoke<{ ok: boolean }>('generate_tts_stream', { request: { text: '.', voice: 'af_heart' } });
  return invoke<string[]>('list_tts_voices');
}
