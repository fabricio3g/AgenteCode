import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, WHISPER_QUALITY_CATALOG } from './config.js';
import { getAppPaths } from './index.js';

// ── Lazy sherpa-onnx import (optional native dep) ───────────────────────────
let _sherpa = null;

async function getSherpa() {
  if (_sherpa) return _sherpa;
  try {
    _sherpa = await import('sherpa-onnx-node');
    return _sherpa;
  } catch {
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

  const paths = getAppPaths();
  const modelDir = path.join(paths.modelsRoot, 'whisper', catalog.dir);

  const encoderPath = path.join(modelDir, catalog.encoder);
  const decoderPath = path.join(modelDir, catalog.decoder);
  const tokensPath = path.join(modelDir, catalog.tokens);

  const available = fs.existsSync(encoderPath) && fs.existsSync(decoderPath) && fs.existsSync(tokensPath);
  return { available, modelDir, catalog };
}

/**
 * Convert raw audio bytes (webm/wav/mp3) to 16kHz mono Float32 PCM.
 * Uses ffmpeg if available, otherwise falls back to basic WAV parsing.
 */
async function decodeAudioToFloat32(audioBytes, mimeType) {
  // Try ffmpeg first (most reliable for webm/opus)
  const { execFileSync } = await import('node:child_process');
  const tmpDir = path.join(os.tmpdir(), 'talamolm-stt');
  fs.mkdirSync(tmpDir, { recursive: true });

  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'webm';
  const inputFile = path.join(tmpDir, `input-${Date.now()}.${ext}`);
  const outputFile = path.join(tmpDir, `output-${Date.now()}.wav`);

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
    ], { stdio: 'pipe', timeout: 30000 });

    // Read the WAV file using sherpa-onnx's readWave (which returns Float32 samples)
    const sherpa = await getSherpa();
    if (sherpa && sherpa.readWave) {
      const wave = sherpa.readWave(outputFile);
      return wave; // { samples: Float32Array, sampleRate: number }
    }

    // Fallback: manually parse WAV
    const wavBuffer = fs.readFileSync(outputFile);
    return parseWavToFloat32(wavBuffer);
  } finally {
    try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  }
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

  const boundary = `----talamolm-stt-${Date.now().toString(16)}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${sttModel}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="recording.${ext}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, audioBytes, closing]);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
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
 * @param {string} args.audio_base64  - Base64-encoded audio data
 * @param {string} [args.mime_type]   - MIME type (default: 'audio/webm')
 * @returns {Promise<{ text: string }>}
 */
export async function transcribeAudio({ audio_base64, mime_type = 'audio/webm' }) {
  if (!audio_base64 || typeof audio_base64 !== 'string') {
    throw new Error('audio_base64 is required');
  }

  const cfg = loadConfig();
  const quality = cfg.stt?.whisper_quality || 'base';
  const audioBytes = Buffer.from(audio_base64, 'base64');

  // Try local Whisper first
  const { available } = checkLocalWhisper(quality);
  if (available) {
    try {
      const sherpa = await getSherpa();
      if (sherpa) {
        return await transcribeLocal(audioBytes, mime_type, quality);
      }
    } catch (err) {
      console.error('[stt-engine] Local transcription failed, falling back to API:', err?.message || err);
    }
  }

  // Fall back to API transcription
  return await transcribeApi(audioBytes, mime_type);
}

/**
 * Get STT status: which mode is active and whether it's ready.
 */
export function getSttStatus() {
  const cfg = loadConfig();
  const quality = cfg.stt?.whisper_quality || 'base';
  const { available } = checkLocalWhisper(quality);

  const providerName = cfg.llm?.provider || 'openai';
  const provider = cfg.llm?.providers?.[providerName] || {};
  const hasApiKey = !!(provider.api_key && provider.api_key !== '***');

  return {
    provider: available ? 'local' : providerName,
    model: available ? `whisper-${quality}` : (cfg.stt?.model || 'whisper-1'),
    ready: available || hasApiKey,
    whisper_quality: quality,
    local_available: available,
    loaded: !!_recognizer,
  };
}
