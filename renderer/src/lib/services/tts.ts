import type { TtsRequest } from '$lib/types/tauri';
import { invoke } from './tauri';

export async function unloadTts(): Promise<void> {
  await invoke<void>('unload_tts');
}

export function generateTtsStream(request: TtsRequest & { volume?: number }): void {
  console.log('[TTS] Sending generate_tts_stream:', (request as any).text?.slice(0, 30));
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

export function onTtsChunk(cb: (evt: any) => void): () => void {
  const api = (window as any).electronAPI;
  if (!api) { console.warn('[TTS] electronAPI not available'); return () => {}; }
  console.log('[TTS] Subscribing to tts-chunk');
  return api.on('tts-chunk', (evt: any) => {
    console.log('[TTS] tts-chunk event received:', JSON.stringify(evt).slice(0, 200));
    cb(evt);
  });
}

export function onTtsStart(cb: (evt: any) => void): () => void {
  const api = (window as any).electronAPI;
  if (!api) { console.warn('[TTS] electronAPI not available'); return () => {}; }
  return api.on('tts-start', (evt: any) => {
    console.log('[TTS] tts-start event received:', JSON.stringify(evt));
    cb(evt);
  });
}

export function onTtsDone(cb: (evt: any) => void): () => void {
  const api = (window as any).electronAPI;
  if (!api) { console.warn('[TTS] electronAPI not available'); return () => {}; }
  console.log('[TTS] Subscribing to tts-done');
  return api.on('tts-done', (evt: any) => {
    console.log('[TTS] tts-done event received:', JSON.stringify(evt));
    cb(evt);
  });
}

export async function initWorker(): Promise<string[]> {
  const voices = await invoke<string[]>('list_tts_voices');
  if (voices?.length) return voices;
  // Trigger init
  await invoke<{ ok: boolean }>('generate_tts_stream', { request: { text: '.', voice: 'af_heart' } });
  return invoke<string[]>('list_tts_voices');
}
