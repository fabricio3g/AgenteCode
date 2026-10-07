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
import { availableParallelism } from 'node:os';
import type { BrowserWindow } from 'electron';
import { loadConfig } from '../config.ts';
import { getAppPaths } from '../paths.ts';
import { createLogger } from '../utils/logger.ts';
import { voiceFileRelPath, voiceLanguage, voiceModelFiles, voiceModelRelPath, type VoiceModel } from '../../shared/voice-models.ts';
import { findVoiceModel, voiceCatalog } from './voice-catalog.ts';

type TtsMessage = (
  | { type: 'start'; id: number; total: number }
  | { type: 'chunk'; id: number; index: number; total: number; base64: string }
  | { type: 'done'; id: number; total: number }
  | { type: 'error'; id: number; message: string }) & { requestId?: string };

type SpeechRequest = { text: string; voice?: string; speed?: number; volume?: number; voiceRef?: { file: string; transcript?: string }; model?: string; language?: string; requestId?: string };

const log = createLogger('[TTS]');
const OUT_RATE = 24_000;
/** Unload the model after this long without speech (it reloads in about a second). */
const IDLE_UNLOAD_MS = 10 * 60_000;
const START_TIMEOUT_MS = 20_000;

let server: { child: ChildProcess; port: number; models: string } | null = null;
let starting: Promise<number> | null = null;
let generation = 0;
let activeSpeech: AbortController | null = null;
const listeners = new Set<(msg: TtsMessage) => void>();

function emit(msg: TtsMessage): void {
  for (const listener of listeners) listener(msg);
}

export function onWorkerMessage(handler: (msg: TtsMessage) => void): void {
  listeners.add(handler);
}

export function availableSpeechBackends(): string[] {
  const root = path.join(getAppPaths().nativeBinRoot, 'audio');
  const name = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server';
  return ['cpu', 'vulkan'].filter(backend => fs.existsSync(path.join(root, backend, name)));
}

/** The bundled audio.cpp release (`BUILD_INFO.txt`, written by fetch-native-runtimes). */
export function speechEngineVersion(): string | null {
  for (const backend of availableSpeechBackends()) {
    const info = path.join(getAppPaths().nativeBinRoot, 'audio', backend, 'BUILD_INFO.txt');
    try {
      const release = fs.readFileSync(info, 'utf8').match(/^release=(.+)$/m)?.[1]?.trim();
      if (release) return release;
    } catch { /* older bundles have no build info */ }
  }
  return null;
}

/** The backend to run: the chosen one when this build has it, else whatever is bundled (Vulkan by default). */
function speechBackend(setting: unknown): 'cpu' | 'vulkan' {
  const available = availableSpeechBackends();
  if (setting === 'cpu' && available.includes('cpu')) return 'cpu';
  if (setting === 'vulkan' && available.includes('vulkan')) return 'vulkan';
  return available.includes('vulkan') ? 'vulkan' : 'cpu';
}

/** Threads the server runs with: the setting, else up to 8 of this machine's cores. */
export function speechThreads(setting: unknown): number {
  const cores = availableParallelism();
  return Math.max(1, Math.min(cores, Number(setting) || Math.min(8, cores)));
}

/** What Settings shows for the voice engine. */
export function speechEngineStatus() {
  const tts = loadConfig().tts;
  return {
    version: speechEngineVersion(),
    backends: availableSpeechBackends(),
    backend: speechBackend(tts?.local_backend),
    threads: speechThreads(tts?.num_threads),
    cores: availableParallelism(),
    running: !!server && server.child.exitCode === null,
    installed: installedVoiceModels().map((model) => model.id),
    espeak: hasEspeak(),
    binaryPath: binary(speechBackend(tts?.local_backend)),
    port: server && server.child.exitCode === null ? server.port : null,
    specs: voiceCatalog().length,
    modelsDir: getAppPaths().voiceModelsRoot
  };
}

function binary(backend: string): string | null {
  const name = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server';
  const root = path.join(getAppPaths().nativeBinRoot, 'audio');
  const candidate = path.join(root, backend, name);
  return fs.existsSync(candidate) ? candidate : null;
}

export function modelPath(model: VoiceModel): string {
  return path.join(getAppPaths().voiceModelsRoot, voiceModelRelPath(model));
}

/** Every file of the model is on disk. */
function isInstalled(model: VoiceModel): boolean {
  return voiceModelFiles(model).every((file) => fs.existsSync(path.join(getAppPaths().voiceModelsRoot, voiceFileRelPath(model, file))));
}

/** The voice models that are downloaded. */
export function installedVoiceModels(): VoiceModel[] {
  return voiceCatalog().filter(isInstalled);
}

/** Whether eSpeak-ng is available (Kokoro needs it for most languages). */
let espeakFound: boolean | undefined;

/** Probed once per process: the check blocks the main thread for up to 3 s. */
export function hasEspeak(): boolean {
  if (process.platform === 'win32') return false;
  if (espeakFound === undefined) {
    const probe = spawnSync('sh', ['-c', 'ldconfig -p 2>/dev/null | grep -q libespeak-ng'], { timeout: 3000 });
    espeakFound = probe.status === 0;
  }
  return espeakFound;
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
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`audio.cpp server exited (${child.exitCode ?? child.signalCode})`);
    const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then((res) => res.ok, () => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('audio.cpp server did not start');
}

/** Start (or restart, when the downloaded models changed) the server; returns its port. */
async function ensureServer(): Promise<number> {
  const models = installedVoiceModels();
  const tts = loadConfig().tts;
  const backend = speechBackend(tts?.local_backend);
  const threads = speechThreads(tts?.num_threads);
  const selected = findVoiceModel(typeof tts?.voice_model === 'string' ? tts.voice_model : undefined)?.id ?? models[0]?.id;
  const signature = JSON.stringify([models.map(model => model.id), backend, threads, selected]);
  if (server && server.models === signature && server.child.exitCode === null) return server.port;
  if (starting) return starting;
  starting = (async () => {
    stopServer();
    const exe = binary(backend);
    if (!exe) throw new Error('The voice engine (audio.cpp) is not bundled with this build.');
    if (!models.length) throw new Error('Download a voice model in Settings → Voice first.');
    const port = await freePort();
    const config = {
      host: '127.0.0.1',
      port,
      backend,
      threads,
      lazy_load: true,
      max_loaded_models: 1,
      idle_unload_ms: IDLE_UNLOAD_MS,
      models: models.map((model) => ({ id: model.id, family: model.family, path: modelPath(model), task: model.serverTask ?? 'tts', mode: 'offline', lazy: model.id !== selected }))
    };
    const configPath = path.join(getAppPaths().voiceModelsRoot, 'audiocpp', 'server.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const child = spawn(exe, ['--config', configPath], { cwd: path.dirname(exe), stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.stderr?.on('data', (chunk: Buffer) => log.info(chunk.toString().trim().slice(0, 300)));
    try { await waitHealthy(port, child); }
    catch (error) { child.kill(); throw spawnError ?? error; }
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
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The voice engine returned invalid WAV audio.');
  }
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
      if (size < 16 || body + size > bytes.length) throw new Error('The voice engine returned a truncated WAV header.');
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      rate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
      if (!rate || !channels || !((format === 1 && bits === 16) || (format === 3 && bits === 32))) {
        throw new Error('The voice engine returned an unsupported WAV format.');
      }
    } else if (id === 'data') {
      const end = Math.min(bytes.length, body + size);
      const step = (bits / 8) * channels;
      const count = Math.floor((end - body) / step);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        const at = body + i * step;
        for (let channel = 0; channel < channels; channel++) {
          const sample = at + channel * (bits / 8);
          samples[i] += (format === 3 ? bytes.readFloatLE(sample) : bytes.readInt16LE(sample) / 32768) / channels;
        }
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

/** Small natural phrases bound first-audio latency; keep the first sentence separate. */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…。！？])\s+/);
  const out: string[] = [];
  for (let part of parts) {
    while (part.length > 100) {
      const prefix = part.slice(0, 100);
      const clause = [...prefix.matchAll(/[,;:]\s+/g)].at(-1);
      const boundary = clause && clause.index >= 35 ? clause.index + 1 : prefix.lastIndexOf(' ');
      // Never split inside a word, URL or identifier.
      if (boundary < 1) break;
      out.push(part.slice(0, boundary).trim());
      part = part.slice(boundary).trim();
    }
    if (part) out.push(part);
  }
  return out;
}

async function speak(port: number, model: VoiceModel, request: SpeechRequest, sentence: string, signal: AbortSignal): Promise<Buffer> {
  // Catalog models without built-in voices speak in their default voice: send none.
  const ref = model.canClone && request.voiceRef?.file ? request.voiceRef : undefined;
  if (model.needsReference && !ref) throw new Error('This model needs a cloned voice. Add one in Settings → Voice.');
  const voice = ref ? undefined : request.voice && model.voices.some((option) => option.id === request.voice) ? request.voice : model.voices[0]?.id;
  const res = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    body: JSON.stringify({
      model: model.id,
      input: sentence,
      ...(voice ? { voice } : {}),
      ...(ref ? { voice_ref: ref.file, ...(ref.transcript ? { reference_text: ref.transcript } : {}) } : {}),
      language: voice ? voiceLanguage(model, voice, request.language || 'en') : (request.language || model.languages[0] || 'en'),
      ...(request.speed && request.speed !== 1 ? { speed: request.speed } : {})
    })
  });
  if (!res.ok) throw new Error(`Voice engine: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function chosenModel(request: SpeechRequest): VoiceModel {
  const installed = installedVoiceModels();
  const model = findVoiceModel(request.model);
  if (model) {
    if (!installed.includes(model)) throw new Error(`Download ${model.title} in Settings → Voice first.`);
    return model;
  }
  const first = installed.find((candidate) => candidate.voices.some((voice) => voice.id === request.voice)) ?? installed[0];
  if (!first) throw new Error('Download a voice model in Settings → Voice first.');
  return first;
}

export async function generateTtsStream(request: SpeechRequest, _win: BrowserWindow | null): Promise<void> {
  activeSpeech?.abort();
  const controller = new AbortController();
  activeSpeech = controller;
  const id = ++generation;
  const sentences = splitSentences(request.text || '');
  const send = (msg: TtsMessage) => {
    if (id === generation && !controller.signal.aborted) emit({ ...msg, requestId: request.requestId });
  };
  send({ type: 'start', id, total: sentences.length });
  try {
    if (!sentences.length) { send({ type: 'done', id, total: 0 }); return; }
    const model = chosenModel(request);
    const port = await ensureServer();
    if (id !== generation) return;
    for (const [index, sentence] of sentences.entries()) {
      const wav = await speak(port, model, request, sentence, controller.signal);
      if (id !== generation) return;
      const { samples, rate } = decodeWav(wav);
      if (!samples.length) throw new Error('The voice engine returned no playable audio.');
      send({ type: 'chunk', id, index, total: sentences.length, base64: toPlayerPcm(samples, rate, Number(request.volume ?? 1)) });
    }
    send({ type: 'done', id, total: sentences.length });
  } catch (error) {
    if (id !== generation || controller.signal.aborted) return;
    log.error('speech failed:', error);
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (activeSpeech === controller) activeSpeech = null;
  }
}

export function cancelTtsStream(): void {
  generation += 1;
  activeSpeech?.abort();
  activeSpeech = null;
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
