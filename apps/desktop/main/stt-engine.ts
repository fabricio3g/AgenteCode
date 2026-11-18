import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig, WHISPER_QUALITY_CATALOG } from './config.ts';
import { getAppPaths } from './paths.ts';
import { resolveWhisperBinary, detectBestBackend, listWhisperBinaries } from './whisper-resolver.ts';
import { DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_ID } from '../shared/providers.ts';
import { warmWhisperServer, findWhisperServer, stopWhisperServer, transcribeWithServer, whisperServerStatus } from './whisper-server.ts';
import { liveWhisperContext } from './voice/whisper-window.ts';
import { transcribeApiAudio } from './voice/speech-api.ts';

const MAX_STT_AUDIO_BYTES = 16 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 45_000;
const WHISPER_TIMEOUT_MS = 60_000;
const STT_PROVIDER_MODES = new Set(['local', 'api', 'auto']);
const LEGACY_API_PROVIDER_NAMES = new Set([
  'openai', 'openrouter', 'lmstudio', 'groq', 'mistral', 'anthropic', 'gemini', 'perplexity', 'xai'
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveSttProviderMode(cfg, localAvailable) {
  const raw = String(cfg?.stt?.provider || '').trim().toLowerCase();
  if (STT_PROVIDER_MODES.has(raw)) return raw;
  if (LEGACY_API_PROVIDER_NAMES.has(raw)) {
    return localAvailable ? 'local' : 'api';
  }
  return localAvailable ? 'local' : 'api';
}

// ── Whisper binary resolution ────────────────────────────────────────────────

function getWhisperBinary(): { path: string; variant: string } | null {
  const binaryPath = resolveWhisperBinary();
  if (!binaryPath) return null;

  const runtimes = listWhisperBinaries();
  const match = runtimes.find(r => r.path === binaryPath);
  const variant = match?.variant || 'unknown';

  if (!fs.existsSync(binaryPath)) return null;

  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
  } catch { /* ignore */ }

  return { path: binaryPath, variant };
}

// ── Model file resolution ────────────────────────────────────────────────────

interface WhisperModelInfo {
  available: boolean;
  modelPath: string;
  catalog: typeof WHISPER_QUALITY_CATALOG[keyof typeof WHISPER_QUALITY_CATALOG];
  searchedDirs: string[];
}

export function checkLocalWhisperModel(quality): WhisperModelInfo {
  const catalog = WHISPER_QUALITY_CATALOG[quality];
  if (!catalog) return { available: false, modelPath: '', catalog: null, searchedDirs: [] };

  const cfg = loadConfig();
  const paths = getAppPaths();
  const configuredModelsDir = String(cfg?.llm?.local?.models_dir || '').trim();
  const candidateDirs = [
    path.join(paths.speechModelsRoot, 'whisper'),
    configuredModelsDir ? path.join(configuredModelsDir, 'whisper', catalog.dir) : '',
    configuredModelsDir ? path.join(configuredModelsDir, catalog.dir) : '',
    path.join(paths.modelsRoot, 'whisper', catalog.dir),
    path.join(paths.modelsRoot, catalog.dir),
    path.join(paths.localModelsRoot, 'whisper', catalog.dir),
  ].filter(Boolean);

  for (const modelDir of candidateDirs) {
    const modelPath = path.join(modelDir, catalog.file);
    if (fs.existsSync(modelPath)) {
      return { available: true, modelPath, catalog, searchedDirs: candidateDirs };
    }
  }

  return {
    available: false,
    modelPath: path.join(candidateDirs[0], catalog.file),
    catalog,
    searchedDirs: candidateDirs,
  };
}

// ── Audio decoding ───────────────────────────────────────────────────────────

async function decodeAudioToWav(audioBytes, mimeType): Promise<{ wavPath: string; inputPath: string }> {
  const { execFileSync } = await import('node:child_process');
  const tmpDir = path.join(os.tmpdir(), 'chatealm-stt');
  fs.mkdirSync(tmpDir, { recursive: true });

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'webm';
  const token = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const inputFile = path.join(tmpDir, `input-${token}.${ext}`);
  const outputFile = path.join(tmpDir, `output-${token}.wav`);

  try {
    fs.writeFileSync(inputFile, audioBytes);

    execFileSync('ffmpeg', [
      '-i', inputFile,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      outputFile,
    ], { stdio: 'pipe', timeout: FFMPEG_TIMEOUT_MS });

    return { wavPath: outputFile, inputPath: inputFile };
  } catch (err: unknown) {
    const stderr = typeof err === 'object' && err !== null && 'stderr' in err
      ? String((err as { stderr?: unknown }).stderr || '')
      : '';
    const detail = stderr.trim() || errorMessage(err) || 'unknown ffmpeg decode failure';
    throw new Error(`Unable to decode recorded audio (${mimeType}). ${detail}`);
  }
}

function writeTempWav(audioBytes): { wavPath: string; inputPath: string | null } {
  const tmpDir = path.join(os.tmpdir(), 'flaxeo-stt');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wavPath = path.join(tmpDir, `input-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}.wav`);
  fs.writeFileSync(wavPath, audioBytes);
  return { wavPath, inputPath: null };
}

function normalizeAudioBytes({ audio_base64, audio_bytes }) {
  if (typeof audio_base64 === 'string' && audio_base64.length > 0) {
    return Buffer.from(audio_base64, 'base64');
  }

  if (audio_bytes instanceof Uint8Array || audio_bytes instanceof ArrayBuffer || Buffer.isBuffer(audio_bytes)) {
    const view = audio_bytes instanceof Uint8Array
      ? audio_bytes
      : (audio_bytes instanceof ArrayBuffer ? new Uint8Array(audio_bytes) : new Uint8Array(audio_bytes.buffer, audio_bytes.byteOffset, audio_bytes.byteLength));
    const copy = Buffer.alloc(view.byteLength);
    copy.set(view);
    return copy;
  }

  if (Array.isArray(audio_bytes)) {
    return Buffer.from(audio_bytes);
  }

  throw new Error('audio_base64 or audio_bytes is required');
}

// ── whisper.cpp CLI invocation ───────────────────────────────────────────────

interface WhisperCliResult {
  text: string;
  language: string;
}

async function runWhisperCli(
  binaryPath: string,
  modelPath: string,
  wavPath: string,
  options: { language: string; threads: number; audioContext?: number }
): Promise<WhisperCliResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-nt',
      '-l', options.language || 'auto',
      '-t', String(options.threads),
      '-np',
      ...(options.audioContext ? ['-ac', String(options.audioContext)] : []),
    ];

    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Whisper transcription timed out'));
    }, WHISPER_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to run whisper-cli: ${errorMessage(err)}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        reject(new Error(`whisper-cli exited with code ${code}${tail ? `: ${tail}` : ''}`));
        return;
      }

      const output = Buffer.concat(chunks).toString();
      const text = parseWhisperOutput(output);
      const langMatch = stderr.match(/language\s*=\s*(\S+)/i);
      const language = langMatch ? langMatch[1].toLowerCase() : 'unknown';

      resolve({ text, language });
    });
  });
}

function parseWhisperOutput(output: string): string {
  const lines = output.split('\n');
  const transcription: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // whisper-cli output format: [timestamp] text
    // e.g. "[00:00.000 --> 00:03.500]  Hello world"
    const bracketMatch = trimmed.match(/^\[[\d:.\-\s>]+\]\s*(.*)$/);
    if (bracketMatch) {
      if (bracketMatch[1].trim()) transcription.push(bracketMatch[1].trim());
      continue;
    }

    // With -nt flag, some versions still print raw text without brackets
    // Skip system/whisper lines that start with known prefixes
    if (/^(whisper_model_load|system_info|ggml_|main:|loading|print_|init |compute |ram:|processing)/i.test(trimmed)) {
      continue;
    }

    // If it doesn't look like a system message, treat as transcription
    if (trimmed.length > 1) {
      transcription.push(trimmed);
    }
  }

  return transcription.join(' ').replace(/\s+/g, ' ').trim();
}

// ── Transcription ────────────────────────────────────────────────────────────

async function transcribeLocal(audioBytes, mimeType, quality, live = false): Promise<{ text: string; language?: string }> {
  const { available, modelPath, catalog, searchedDirs } = checkLocalWhisperModel(quality);
  if (!available) {
    const lookedIn = (searchedDirs || []).slice(0, 3).join(', ');
    throw new Error(
      `Whisper model "${quality}" not found. Expected: ${catalog?.file}` +
      `${lookedIn ? `. Looked in: ${lookedIn}` : ''}`
    );
  }

  const binary = getWhisperBinary();
  if (!binary) {
    throw new Error(
      'whisper-cli binary not found. Download it from Settings → Whisper, ' +
      'or set stt.runtime_path in settings.'
    );
  }

  const cfg = loadConfig();
  const language = String(cfg.stt?.language || 'auto').trim() || 'auto';
  const threads = Math.min(os.cpus().length, 4);

  // The app records 16 kHz mono WAV itself, so ffmpeg is only needed for
  // other formats (older builds, pasted files).
  const isWav = /wav/i.test(String(mimeType));
  const audioContext = live && isWav ? liveWhisperContext(Buffer.from(audioBytes)) : 0;

  // Fast path: a warm whisper-server (GPU when available).
  const serverPath = isWav ? findWhisperServer(binary.path) : null;
  if (serverPath) {
    try {
      const result = await transcribeWithServer(serverPath, modelPath, Buffer.from(audioBytes), language, audioContext);
      return { text: result.text, language };
    } catch (err) {
      console.warn('[stt-engine] whisper-server failed, falling back to the CLI:', errorMessage(err));
    }
  }

  let wavPath: string | null = null;
  let inputPath: string | null = null;
  try {
    const decoded = isWav ? writeTempWav(audioBytes) : await decodeAudioToWav(audioBytes, mimeType);
    wavPath = decoded.wavPath;
    inputPath = decoded.inputPath;
    const result = await runWhisperCli(binary.path, modelPath, wavPath, { language, threads, audioContext });
    return { text: result.text, language: result.language };
  } finally {
    if (wavPath) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
    if (inputPath) {
      try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
    }
  }
}

async function transcribeApi(audioBytes, mimeType) {
  const cfg = loadConfig();
  if (cfg.stt?.api_provider) {
    const provider = cfg.stt.providers?.[cfg.stt.api_provider];
    if (!provider) throw new Error('Configure the transcription service in Settings → Voice.');
    return transcribeApiAudio(provider, audioBytes, mimeType, cfg.stt.language);
  }
  const providerName = cfg.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = cfg.llm?.providers?.[providerName] || {};
  const baseUrl = (provider.base_url || DEFAULT_PROVIDER_BASE_URL).replace(/\/+$/, '');
  const apiKey = provider.api_key || '';
  const sttModel = cfg.stt?.model || 'whisper-1';

  if (!apiKey) {
    throw new Error(`No API key configured for ${providerName}. Please add your API key in Settings > LLM Providers.`);
  }

  const endpoint = baseUrl.endsWith('/v1')
    ? `${baseUrl}/audio/transcriptions`
    : `${baseUrl}/v1/audio/transcriptions`;

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'webm';

  const form = new FormData();
  form.append('model', sttModel);
  form.append('file', new Blob([audioBytes], { type: mimeType }), `recording.${ext}`);

  const resp = await fetch(endpoint, { method: 'POST', headers, body: form });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`STT API error ${resp.status}: ${text || 'Failed transcription'}`);
  }

  const data = await resp.json();
  const text = data?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('STT response missing text field');
  }
  return { text };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Warm only an installed local model; cloud services are never called here. */
export async function preloadWhisper(): Promise<void> {
  const cfg = loadConfig();
  const model = checkLocalWhisperModel(cfg.stt?.whisper_quality || 'medium_q5');
  const binary = getWhisperBinary();
  if (resolveSttProviderMode(cfg, model.available && !!binary) === 'api' || !model.available || !binary) return;
  const serverPath = findWhisperServer(binary.path);
  if (serverPath) await warmWhisperServer(serverPath, model.modelPath);
}

export async function transcribeAudio(args = {}) {
  const mime_type = args?.mime_type || 'audio/webm';
  const audioBytes = normalizeAudioBytes(args);
  if (!audioBytes?.length) {
    throw new Error('Recorded audio is empty');
  }
  if (audioBytes.length > MAX_STT_AUDIO_BYTES) {
    throw new Error('Recording is too long. Please keep voice messages under 60 seconds.');
  }

  const cfg = loadConfig();
  const quality = cfg.stt?.whisper_quality || 'medium_q5';

  const modelInfo = checkLocalWhisperModel(quality);
  const binary = getWhisperBinary();
  const available = modelInfo.available && !!binary;

  const sttProvider = resolveSttProviderMode(cfg, available);

  if (sttProvider === 'local') {
    if (!modelInfo.available) {
      const lookedIn = (modelInfo.searchedDirs || []).slice(0, 3).join(', ');
      throw new Error(
        `Whisper model "${quality}" is not downloaded. Open Settings → Whisper to install it.` +
        `${lookedIn ? ` Looked in: ${lookedIn}` : ''}`
      );
    }
    if (!binary) {
      throw new Error(
        'whisper-cli runtime is not installed. Open Settings → Whisper to download it.'
      );
    }
    try {
      return await transcribeLocal(audioBytes, mime_type, quality, args.live === true);
    } catch (err: unknown) {
      throw new Error(`Local transcription failed: ${errorMessage(err)}`);
    }
  }

  if (sttProvider === 'api') {
    return await transcribeApi(audioBytes, mime_type);
  }

  // auto mode: prefer local, fall back to API
  if (available) {
    try {
      return await transcribeLocal(audioBytes, mime_type, quality, args.live === true);
    } catch (err: unknown) {
      console.error('[stt-engine] Local transcription failed, falling back to API:', errorMessage(err));
    }
  }

  return await transcribeApi(audioBytes, mime_type);
}

export function getSttStatus() {
  const cfg = loadConfig();
  const quality = cfg.stt?.whisper_quality || 'medium_q5';
  const { available: modelAvailable, catalog } = checkLocalWhisperModel(quality);
  const binary = getWhisperBinary();
  const sttProvider = resolveSttProviderMode(cfg, modelAvailable && !!binary);

  const providerName = cfg.stt?.api_provider || cfg.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = cfg.stt?.api_provider ? cfg.stt.providers?.[providerName] : cfg.llm?.providers?.[providerName];
  const hasApiKey = !!provider && (!!provider.api_key || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/.test(provider.base_url || ''));

  const usingLocal = sttProvider === 'local' || (sttProvider === 'auto' && modelAvailable && !!binary);
  const ready = sttProvider === 'api'
    ? hasApiKey
    : sttProvider === 'local'
      ? (modelAvailable && !!binary)
      : ((modelAvailable && !!binary) || hasApiKey);

  const backend = detectBestBackend();

  return {
    provider: usingLocal ? 'local' : providerName,
    model: usingLocal ? `whisper-${quality}` : (provider?.model || cfg.stt?.model || 'whisper-1'),
    ready,
    whisper_quality: quality,
    language: usingLocal ? (cfg.stt?.language || 'auto') : undefined,
    multilingual: usingLocal ? (catalog?.multilingual ?? true) : undefined,
    local_available: modelAvailable && !!binary,
    model_available: modelAvailable,
    runtime_available: !!binary,
    runtime_path: binary?.path || null,
    runtime_variant: binary?.variant || null,
    backend: backend.backend,
    backend_reason: backend.reason,
    has_cuda: backend.hasCuda,
    has_vulkan: backend.hasVulkan,
    installed_runtimes: listWhisperBinaries().length,
    server_available: !!findWhisperServer(binary?.path || null),
    server_running: whisperServerStatus().running,
    server_gpu: whisperServerStatus().gpu,
  };
}

export function unloadWhisper() {
  stopWhisperServer();
}
