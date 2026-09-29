// ── Text to speech on audio.cpp ─────────────────────────────────────────
// Desktop ships audio.cpp's server (resources/bin/audio, fetched at build
// time) and the user downloads voice models from Settings → Voice. The
// server runs on 127.0.0.1 with the downloaded models, loads one when it is
// first used and keeps it warm. Speech is made sentence by sentence and each
// clip is sent to the renderer as it is ready, as 24 kHz 16-bit PCM (what
// its player expects), with the same start/chunk/done messages as before.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getAppPaths } from '../paths.ts';
import { createLogger } from '../utils/logger.ts';
import { VOICE_MODELS, voiceLanguage, voiceModel, voiceModelRelPath, type VoiceModel } from '../../shared/voice-models.ts';

type TtsMessage =
  | { type: 'start'; id: number; total: number }
  | { type: 'chunk'; id: number; index: number; total: number; base64: string }
  | { type: 'done'; id: number; total: number }
  | { type: 'error'; id: number; message: string };

type SpeechRequest = { text: string; voice?: string; speed?: number; volume?: number; model?: string; language?: string };

const log = createLogger('[TTS]');
const OUT_RATE = 24_000;
/** Unload the model after this long without speech (it reloads in about a second). */
const IDLE_UNLOAD_MS = 10 * 60_000;
const START_TIMEOUT_MS = 20_000;

let server: { child: ChildProcess; port: number; models: string } | null = null;
let starting: Promise<number> | null = null;
let generation = 0;
const listeners = new Set<(msg: TtsMessage) => void>();

function emit(msg: TtsMessage): void {
  for (const listener of listeners) listener(msg);
}

export function onWorkerMessage(handler: (msg: TtsMessage) => void): void {
  listeners.add(handler);
}

function binary(): string | null {
  const name = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server';
  const root = path.join(getAppPaths().nativeBinRoot, 'audio');
  for (const backend of ['cpu', 'vulkan']) {
    const candidate = path.join(root, backend, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function modelPath(model: VoiceModel): string {
  return path.join(getAppPaths().voiceModelsRoot, voiceModelRelPath(model));
}

/** The voice models that are downloaded. */
export function installedVoiceModels(): VoiceModel[] {
  return VOICE_MODELS.filter((model) => fs.existsSync(modelPath(model)));
}

/** Whether eSpeak-ng is available (Kokoro needs it for most languages). */
export function hasEspeak(): boolean {
  if (process.platform === 'win32') return false;
  const probe = spawnSync('sh', ['-c', 'ldconfig -p 2>/dev/null | grep -q libespeak-ng'], { timeout: 3000 });
  return probe.status === 0;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`audio.cpp server exited (${child.exitCode})`);
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.ok, () => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('audio.cpp server did not start');
}

/** Start (or restart, when the downloaded models changed) the server; returns its port. */
async function ensureServer(): Promise<number> {
  const models = installedVoiceModels();
  const signature = models.map((model) => model.id).join(',');
  if (server && server.models === signature && server.child.exitCode === null) return server.port;
  if (starting) return starting;
  starting = (async () => {
    stopServer();
    const exe = binary();
    if (!exe) throw new Error('The voice engine (audio.cpp) is not bundled with this build.');
    if (!models.length) throw new Error('Download a voice model in Settings → Voice first.');
    const port = await freePort();
    const config = {
      host: '127.0.0.1',
      port,
      backend: 'cpu',
      lazy_load: true,
      max_loaded_models: 1,
      idle_unload_ms: IDLE_UNLOAD_MS,
      models: models.map((model) => ({ id: model.id, family: model.family, path: modelPath(model), task: 'tts', mode: 'offline' }))
    };
    const configPath = path.join(getAppPaths().voiceModelsRoot, 'audiocpp', 'server.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const child = spawn(exe, ['--config', configPath], { cwd: path.dirname(exe), stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => log.info(chunk.toString().trim().slice(0, 300)));
    await waitHealthy(port, child);
    server = { child, port, models: signature };
    return port;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

function stopServer(): void {
  if (server && server.child.exitCode === null) server.child.kill();
  server = null;
}

/** WAV bytes → mono float samples and their rate (16-bit PCM or 32-bit float). */
export function decodeWav(bytes: Buffer): { samples: Float32Array; rate: number } {
  let offset = 12;
  let rate = OUT_RATE;
  let channels = 1;
  let bits = 16;
  let format = 1;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      rate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === 'data') {
      const end = Math.min(bytes.length, body + size);
      const step = (bits / 8) * channels;
      const count = Math.floor((end - body) / step);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        const at = body + i * step;
        samples[i] = format === 3 && bits === 32 ? bytes.readFloatLE(at) : bytes.readInt16LE(at) / 32768;
      }
      return { samples, rate };
    }
    offset = body + size + (size % 2);
  }
  return { samples: new Float32Array(0), rate };
}

/** Linear resampling to the player's 24 kHz, volume applied, as 16-bit PCM in base64. */
export function toPlayerPcm(samples: Float32Array, rate: number, volume: number): string {
  const ratio = rate / OUT_RATE;
  const length = Math.max(0, Math.floor(samples.length / ratio));
  const out = Buffer.alloc(length * 2);
  const gain = Math.max(0, Math.min(2, volume));
  for (let i = 0; i < length; i += 1) {
    const at = i * ratio;
    const left = Math.floor(at);
    const next = samples[Math.min(left + 1, samples.length - 1)] ?? 0;
    const value = (samples[left] ?? 0) + ((next - (samples[left] ?? 0)) * (at - left));
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * gain)) * 32767), i * 2);
  }
  return out.toString('base64');
}

/** Sentences, merged up to ~220 characters, so audio starts after the first one. */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…。！？])\s+/);
  const out: string[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + part.length < 220 && last.length < 60) out[out.length - 1] = `${last} ${part}`;
    else if (part) out.push(part);
  }
  return out;
}

async function speak(port: number, model: VoiceModel, request: SpeechRequest, sentence: string): Promise<Buffer> {
  const voice = request.voice && model.voices.some((option) => option.id === request.voice) ? request.voice : model.voices[0].id;
  const res = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      input: sentence,
      voice,
      language: voiceLanguage(model, voice, request.language || 'en'),
      ...(request.speed && request.speed !== 1 ? { speed: request.speed } : {})
    })
  });
  if (!res.ok) throw new Error(`Voice engine: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function chosenModel(request: SpeechRequest): VoiceModel {
  const installed = installedVoiceModels();
  const model = voiceModel(request.model);
  if (model && installed.includes(model)) return model;
  const first = installed[0];
  if (!first) throw new Error('Download a voice model in Settings → Voice first.');
  return first;
}

export async function generateTtsStream(request: SpeechRequest, _win: BrowserWindow | null): Promise<void> {
  const id = ++generation;
  const sentences = splitSentences(request.text || '');
  emit({ type: 'start', id, total: sentences.length });
  try {
    const model = chosenModel(request);
    const port = await ensureServer();
    for (const [index, sentence] of sentences.entries()) {
      const wav = await speak(port, model, request, sentence);
      if (id !== generation) return;
      const { samples, rate } = decodeWav(wav);
      emit({ type: 'chunk', id, index, total: sentences.length, base64: toPlayerPcm(samples, rate, Number(request.volume ?? 1)) });
    }
    emit({ type: 'done', id, total: sentences.length });
  } catch (error) {
    log.error('speech failed:', error);
    emit({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
    emit({ type: 'done', id, total: 0 });
  }
}

export function cancelTtsStream(): void {
  generation += 1;
}

export async function initTts(): Promise<string[]> {
  if (installedVoiceModels().length) await ensureServer();
  return listVoices();
}

export async function unloadTts(): Promise<void> {
  cancelTtsStream();
  stopServer();
}

export function listVoices(): string[] {
  return installedVoiceModels().flatMap((model) => model.voices.map((voice) => voice.id));
}

export async function checkEspeakData(_modelsDir: string): Promise<{ found: boolean }> {
  return { found: hasEspeak() };
}
