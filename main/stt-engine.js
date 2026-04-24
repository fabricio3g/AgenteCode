import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, WHISPER_QUALITY_CATALOG } from './config.js';
import { getAppPaths } from './index.js';

const MAX_STT_AUDIO_BYTES = 8 * 1024 * 1024; // 8MB input cap
const FFMPEG_TIMEOUT_MS = 45_000;
const STT_PROVIDER_MODES = new Set(['local', 'api', 'auto']);
const LEGACY_API_PROVIDER_NAMES = new Set([
  'openai', 'openrouter', 'lmstudio', 'groq', 'mistral', 'anthropic', 'gemini', 'perplexity', 'xai'
]);

function resolveSttProviderMode(cfg, localAvailable) {
  const raw = String(cfg?.stt?.provider || '').trim().toLowerCase();
  if (STT_PROVIDER_MODES.has(raw)) return raw;

  // Legacy configs stored provider names (e.g. "openai") in stt.provider.
  // Prefer local when a local Whisper model exists, otherwise fall back to API.
  if (LEGACY_API_PROVIDER_NAMES.has(raw)) {
    return localAvailable ? 'local' : 'api';
  }

  return localAvailable ? 'local' : 'api';
}

// ── Lazy sherpa-onnx import (optional native dep) ───────────────────────────
let _sherpa = null;

async function getSherpa() {
  if (_sherpa) return _sherpa;
  try {
    const mod = await import('sherpa-onnx-node');
    const resolved = (mod?.default && (mod.default.OfflineRecognizer || mod.default.readWave))
      ? mod.default
      : mod;

    if (!resolved?.OfflineRecognizer) {
      console.error('[stt-engine] sherpa-onnx-node loaded but OfflineRecognizer is missing');
      return null;
    }

    _sherpa = resolved;
    return _sherpa;
  } catch (err) {
    console.error('[stt-engine] Failed to load sherpa-onnx-node:', err?.message || err);
    return null; // graceful fallback if native module is missing
  }
}

// ── Cached recognizer (reused across transcriptions) ────────────────────────
let _recognizer = null;
let _recognizerKey = ''; // cache key = model dir

/**
 * Get or create an OfflineRecognizer for the given Whisper model directory.
 * Caches the instance so subsequent transcriptions are fast.
 */
async function getOrCreateRecognizer(modelDir, catalog) {
  const cacheKey = modelDir;
  if (_recognizer && _recognizerKey === cacheKey) return _recognizer;

  // Unload previous
  _recognizer = null;
  _recognizerKey = '';

  const sherpa = await getSherpa();
  if (!sherpa) throw new Error('sherpa-onnx-node is not available');

  const encoderPath = path.join(modelDir, catalog.encoder);
  const decoderPath = path.join(modelDir, catalog.decoder);
  const tokensPath = path.join(modelDir, catalog.tokens);

  if (!fs.existsSync(encoderPath)) throw new Error(`Whisper encoder not found: ${encoderPath}`);
  if (!fs.existsSync(decoderPath)) throw new Error(`Whisper decoder not found: ${decoderPath}`);
  if (!fs.existsSync(tokensPath)) throw new Error(`Whisper tokens not found: ${tokensPath}`);

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: encoderPath,
        decoder: decoderPath,
        language: 'en',
        task: 'transcribe',
      },
      tokens: tokensPath,
      numThreads: Math.min(os.cpus().length, 4),
      debug: 0,
      provider: 'cpu',
    },
  };

  _recognizer = new sherpa.OfflineRecognizer(config);
  _recognizerKey = cacheKey;
  return _recognizer;
}

/**
 * Unload the cached Whisper recognizer (frees memory).
 */
export function unloadWhisper() {
  _recognizer = null;
  _recognizerKey = '';
}

/**
 * Check if a local Whisper model is available for the given quality.
 * Returns { available, modelDir, catalog } or { available: false }.
 */
function checkLocalWhisper(quality) {
  const catalog = WHISPER_QUALITY_CATALOG[quality];
  if (!catalog) return { available: false };

  const cfg = loadConfig();
  const paths = getAppPaths();
  const configuredModelsDir = String(cfg?.llm?.local?.models_dir || '').trim();
  const candidateDirs = [
    configuredModelsDir ? path.join(configuredModelsDir, 'whisper', catalog.dir) : '',
    configuredModelsDir ? path.join(configuredModelsDir, catalog.dir) : '', // legacy location
    path.join(paths.modelsRoot, 'whisper', catalog.dir),
    path.join(paths.modelsRoot, catalog.dir) // legacy location
  ].filter(Boolean);

  for (const modelDir of candidateDirs) {
    const encoderPath = path.join(modelDir, catalog.encoder);
    const decoderPath = path.join(modelDir, catalog.decoder);
    const tokensPath = path.join(modelDir, catalog.tokens);

    const available = fs.existsSync(encoderPath) && fs.existsSync(decoderPath) && fs.existsSync(tokensPath);
    if (available) {
      return { available: true, modelDir, catalog, searchedDirs: candidateDirs };
    }
  }

  return {
    available: false,
    modelDir: candidateDirs[0] || path.join(paths.modelsRoot, 'whisper', catalog.dir),
    catalog,
    searchedDirs: candidateDirs
  };
}

/**
 * Convert raw audio bytes (webm/wav/mp3) to 16kHz mono Float32 PCM.
 * Uses ffmpeg if available, otherwise falls back to basic WAV parsing.
 */
async function decodeAudioToFloat32(audioBytes, mimeType) {
  // Try ffmpeg first (most reliable for webm/opus)
  const { execFileSync } = await import('node:child_process');
  const tmpDir = path.join(os.tmpdir(), 'chatealm-stt');
  fs.mkdirSync(tmpDir, { recursive: true });

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'webm';
  const token = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const inputFile = path.join(tmpDir, `input-${token}.${ext}`);
  const outputFile = path.join(tmpDir, `output-${token}.wav`);

  try {
    fs.writeFileSync(inputFile, audioBytes);

    // Convert to 16kHz mono s16le WAV using ffmpeg
    execFileSync('ffmpeg', [
      '-i', inputFile,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      outputFile
    ], { stdio: 'pipe', timeout: FFMPEG_TIMEOUT_MS });

    // Read the WAV file using sherpa-onnx's readWave (which returns Float32 samples)
    const sherpa = await getSherpa();
    if (sherpa && sherpa.readWave) {
      const wave = sherpa.readWave(outputFile);
      return wave; // { samples: Float32Array, sampleRate: number }
    }

    // Fallback: manually parse WAV
    const wavBuffer = fs.readFileSync(outputFile);
    return parseWavToFloat32(wavBuffer);
  } catch (err) {
    if (ext === 'wav') {
      try {
        return parseWavToFloat32(audioBytes);
      } catch {
        // ignored - handled below with detailed ffmpeg error
      }
    }
    const stderr = err?.stderr ? String(err.stderr) : '';
    const detail = stderr.trim() || err?.message || 'unknown ffmpeg decode failure';
    throw new Error(`Unable to decode recorded audio (${mimeType}). ${detail}`);
  } finally {
    try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  }
}

function normalizeAudioBytes({ audio_base64, audio_bytes }) {
  if (typeof audio_base64 === 'string' && audio_base64.length > 0) {
    return Buffer.from(audio_base64, 'base64');
  }

  if (audio_bytes instanceof Uint8Array || audio_bytes instanceof ArrayBuffer || Buffer.isBuffer(audio_bytes)) {
    // Force a JS-owned copy to avoid Electron "External buffers are not allowed" errors.
    // IPC-transferred Uint8Arrays use external backing stores that Node fs.writeFileSync
    // cannot access directly. We allocate a fresh Buffer and memcpy the data.
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

/**
 * Parse a 16-bit PCM WAV buffer to Float32Array samples.
 */
function parseWavToFloat32(wavBuffer) {
  // Find 'data' chunk
  let dataOffset = 44; // standard WAV header
  let dataSize = wavBuffer.length - 44;

  // Try to find the actual data chunk
  for (let i = 0; i < Math.min(wavBuffer.length - 8, 200); i++) {
    if (wavBuffer[i] === 0x64 && wavBuffer[i + 1] === 0x61 &&
        wavBuffer[i + 2] === 0x74 && wavBuffer[i + 3] === 0x61) { // 'data'
      dataSize = wavBuffer.readUInt32LE(i + 4);
      dataOffset = i + 8;
      break;
    }
  }

  const numSamples = Math.floor(dataSize / 2); // 16-bit = 2 bytes per sample
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const offset = dataOffset + i * 2;
    if (offset + 1 < wavBuffer.length) {
      samples[i] = wavBuffer.readInt16LE(offset) / 32768.0;
    }
  }

  return { samples, sampleRate: 16000 };
}

/**
 * Transcribe audio locally using sherpa-onnx Whisper.
 */
async function transcribeLocal(audioBytes, mimeType, quality) {
  const { available, modelDir, catalog } = checkLocalWhisper(quality);
  if (!available) throw new Error(`Local Whisper model "${quality}" not found`);

  const recognizer = await getOrCreateRecognizer(modelDir, catalog);
  const waveform = await decodeAudioToFloat32(audioBytes, mimeType);

  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: waveform.samples, sampleRate: waveform.sampleRate });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);

  return { text: result.text || '' };
}

/**
 * Transcribe audio via remote API (OpenAI Whisper or compatible endpoint).
 */
async function transcribeApi(audioBytes, mimeType) {
  const cfg = loadConfig();
  const providerName = cfg.llm?.provider || 'openai';
  const provider = cfg.llm?.providers?.[providerName] || {};
  const baseUrl = (provider.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
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

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: form
  });

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

/**
 * Transcribe audio (base64-encoded).
 * Prefers local Whisper model if available; falls back to API.
 *
 * @param {object} args
 * @param {string} [args.audio_base64]  - Base64-encoded audio data
 * @param {Uint8Array|ArrayBuffer|number[]} [args.audio_bytes] - Raw audio bytes
 * @param {string} [args.mime_type]   - MIME type (default: 'audio/webm')
 * @returns {Promise<{ text: string }>}
 */
export async function transcribeAudio(args = {}) {
  const mime_type = args?.mime_type || 'audio/webm';
  const audioBytes = normalizeAudioBytes(args);
  if (!audioBytes?.length) {
    throw new Error('Recorded audio is empty');
  }
  if (audioBytes.length > MAX_STT_AUDIO_BYTES) {
    throw new Error('Recording is too long. Please keep voice messages under about 30 seconds.');
  }

  const cfg = loadConfig();
  const quality = cfg.stt?.whisper_quality || 'base';

  const localWhisper = checkLocalWhisper(quality);
  const { available } = localWhisper;
  const sttProvider = resolveSttProviderMode(cfg, available);
  const sherpa = await getSherpa();

  if (sttProvider === 'local') {
    if (!available) {
      const lookedIn = (localWhisper.searchedDirs || []).slice(0, 3).join(', ');
      throw new Error(`Local Whisper model "${quality}" is not downloaded. Open Model Hub → Whisper to install it.${lookedIn ? ` Looked in: ${lookedIn}` : ''}`);
    }
    if (!sherpa) {
      throw new Error('Local Whisper runtime is unavailable (sherpa-onnx-node failed to load). Run npm install/rebuild and restart the app.');
    }
    try {
      return await transcribeLocal(audioBytes, mime_type, quality);
    } catch (err) {
      throw new Error(`Local transcription failed: ${err?.message || err}`);
    }
  }

  if (sttProvider === 'api') {
    return await transcribeApi(audioBytes, mime_type);
  }

  // auto mode: prefer local, then fallback to API
  if (available && sherpa) {
    try {
      return await transcribeLocal(audioBytes, mime_type, quality);
    } catch (err) {
      console.error('[stt-engine] Local transcription failed, falling back to API:', err?.message || err);
    }
  }

  return await transcribeApi(audioBytes, mime_type);
}

/**
 * Get STT status: which mode is active and whether it's ready.
 */
export function getSttStatus() {
  const cfg = loadConfig();
  const quality = cfg.stt?.whisper_quality || 'base';
  const { available } = checkLocalWhisper(quality);
  const sttProvider = resolveSttProviderMode(cfg, available);

  const providerName = cfg.llm?.provider || 'openai';
  const provider = cfg.llm?.providers?.[providerName] || {};
  const hasApiKey = !!(provider.api_key && provider.api_key !== '***');

  const usingLocal = sttProvider === 'local' || (sttProvider === 'auto' && available);
  const ready = sttProvider === 'api'
    ? hasApiKey
    : sttProvider === 'local'
      ? available
      : (available || hasApiKey);

  return {
    provider: usingLocal ? 'local' : providerName,
    model: usingLocal ? `whisper-${quality}` : (cfg.stt?.model || 'whisper-1'),
    ready,
    whisper_quality: quality,
    local_available: available,
    loaded: !!_recognizer,
  };
}
