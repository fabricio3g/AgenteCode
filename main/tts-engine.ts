// Kokoro TTS engine — spawns Worker Thread for ONNX inference
// Main process stays responsive while inference runs in worker

import { Worker } from 'worker_threads';
import path from 'path';
import type { BrowserWindow } from 'electron';

let _worker: Worker | null = null;
let _ready = false;
let _voices: string[] = [];
let _initPromise: Promise<void> | null = null;
let _genId = 0;

function getWorker(): Worker {
  if (!_worker) {
    const workerPath = path.resolve(__dirname, 'tts-worker.cjs');
    console.log('[TTS Engine] Spawning worker at:', workerPath);
    _worker = new Worker(workerPath);
    _worker.on('error', (err) => console.error('[TTS Worker] Error:', err));
    _worker.on('exit', (code) => console.log('[TTS Worker] Exited with code', code));
  }
  return _worker;
}

export async function initTts(): Promise<string[]> {
  await initWorker();
  return listVoices();
}

export async function generateTtsStream(
  request: { text: string; voice?: string; speed?: number; volume?: number },
  _win: any
): Promise<void> {
  console.log('[TTS Main] generateTtsStream called:', JSON.stringify({ text: request.text.slice(0, 30), voice: request.voice }));
  await initWorker();
  if (!_worker) throw new Error('Worker not available');
  _worker.postMessage({
    type: 'generate',
    id: ++_genId,
    text: request.text,
    voice: request.voice || 'af_heart',
    speed: Number(request.speed || 1),
    volume: Number(request.volume ?? 1),
  });
  console.log('[TTS Main] Sent to worker, id:', _genId);
}

// Handle worker messages for streaming
export function onWorkerMessage(handler: (msg: any) => void): void {
  getWorker().on('message', handler);
}

async function initWorker(): Promise<void> {
  if (_ready) return;
  if (_initPromise) return _initPromise;
  _initPromise = new Promise((resolve) => {
    const w = getWorker();
    w.on('message', function h(msg: any) {
      if (msg.type === 'ready') {
        w.off('message', h);
        _ready = true;
        _voices = msg.voices || [];
        console.log('[TTS Worker] Ready,', _voices.length, 'voices');
        resolve();
      }
    });
    w.postMessage({ type: 'init' });
  });
  return _initPromise;
}

export async function unloadTts(): Promise<void> {
  if (_worker) {
    _worker.postMessage({ type: 'unload' });
    _worker = null;
    _ready = false;
    _voices = [];
    _initPromise = null;
    _genId = 0;
  }
}

export function cancelTtsStream(): void {
  if (_worker && _genId > 0) {
    _worker.postMessage({ type: 'cancel', id: _genId });
  }
}

export function listVoices(): string[] {
  return _voices;
}

export async function checkEspeakData(_modelsDir: string): Promise<{ found: boolean }> {
  return { found: true };
}
