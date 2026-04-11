import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeStorage } from 'electron';
import { getAppPaths } from './index.js';

const RUNTIME_INSTALL_VARIANTS = [
  'auto', 'cpu', 'cuda', 'cuda12', 'cuda13', 'vulkan',
  'hip', 'rocm', 'sycl', 'openeuler_310p', 'openeuler_910b_aclgraph'
];

const TTS_MODEL_CATALOG = {
  kitten_nano_v02: {
    label: 'Kitten Nano EN v0.2',
    repo: 'csukuangfj/kitten-nano-en-v0_2-fp16',
    dir: 'kitten-nano-en-v0_2-fp16',
    engine: 'kitten'
  },
  kitten_nano_v01: {
    label: 'Kitten Nano EN v0.1',
    repo: 'csukuangfj/kitten-nano-en-v0_1-fp16',
    dir: 'kitten-nano-en-v0_1-fp16',
    engine: 'kitten'
  },
  kitten_mini_v01: {
    label: 'Kitten Mini EN v0.1',
    repo: 'csukuangfj/kitten-mini-en-v0_1-fp16',
    dir: 'kitten-mini-en-v0_1-fp16',
    engine: 'kitten'
  },
  kokoro_82m_v1: {
    label: 'Kokoro Multi-lang v1.0',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_0',
    dir: 'kokoro-multi-lang-v1_0',
    engine: 'kokoro',
    lang: 'en-us',
    voice_map: {}
  },
  kokoro_v11: {
    label: 'Kokoro v1.1 Chinese + English',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    dir: 'kokoro-multi-lang-v1_1',
    engine: 'kokoro',
    lang: 'en-us',
    voice_map: {}
  }
};

const WHISPER_QUALITY_CATALOG = {
  tiny: {
    label: 'Tiny',
    repo: 'csukuangfj/sherpa-onnx-whisper-tiny.en',
    dir: 'sherpa-onnx-whisper-tiny.en',
    encoder: 'tiny.en-encoder.int8.onnx',
    decoder: 'tiny.en-decoder.int8.onnx',
    tokens: 'tiny.en-tokens.txt',
    files: ['tiny.en-encoder.int8.onnx', 'tiny.en-decoder.int8.onnx', 'tiny.en-tokens.txt'],
  },
  base: {
    label: 'Base',
    repo: 'csukuangfj/sherpa-onnx-whisper-base.en',
    dir: 'sherpa-onnx-whisper-base.en',
    encoder: 'base.en-encoder.int8.onnx',
    decoder: 'base.en-decoder.int8.onnx',
    tokens: 'base.en-tokens.txt',
    files: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'],
  },
  small: {
    label: 'Small',
    repo: 'csukuangfj/sherpa-onnx-whisper-small.en',
    dir: 'sherpa-onnx-whisper-small.en',
    encoder: 'small.en-encoder.int8.onnx',
    decoder: 'small.en-decoder.int8.onnx',
    tokens: 'small.en-tokens.txt',
    files: ['small.en-encoder.int8.onnx', 'small.en-decoder.int8.onnx', 'small.en-tokens.txt'],
  },
  medium: {
    label: 'Medium',
    repo: 'csukuangfj/sherpa-onnx-whisper-medium.en',
    dir: 'sherpa-onnx-whisper-medium.en',
    encoder: 'medium.en-encoder.int8.onnx',
    decoder: 'medium.en-decoder.int8.onnx',
    tokens: 'medium.en-tokens.txt',
    files: ['medium.en-encoder.int8.onnx', 'medium.en-decoder.int8.onnx', 'medium.en-tokens.txt'],
  },
};

const LOCAL_GGUF_CATALOG = {
  qwen35_2b_q4_k_m: {
    label: 'Qwen 3.5 2B Q4_K_M',
    filename: 'Qwen3.5-2B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    size_bytes: 1610612736
  },
  qwen35_4b_q4_k_m: {
    label: 'Qwen 3.5 4B Q4_K_M',
    filename: 'Qwen3.5-4B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    size_bytes: 3006479104
  },
  qwen35_08b_q4_k_m: {
    label: 'Qwen 3.5 0.8B Q4_K_M',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    size_bytes: 643000000
  }
};

// ── safeStorage helpers ──────────────────────────────────────────────────────
// We store API keys encrypted via Electron's safeStorage (OS keychain) in a
// separate secrets.json file.  config.json never contains plain-text keys.
// If safeStorage is unavailable (e.g. in tests) we fall back to plain-text so
// the app still works.

function canEncrypt() {
  try { return safeStorage?.isEncryptionAvailable?.() ?? false; } catch { return false; }
}

function encryptSecret(plaintext) {
  if (!plaintext || !canEncrypt()) return plaintext;
  try {
    return safeStorage.encryptString(plaintext).toString('base64');
  } catch {
    return plaintext;
  }
}

function decryptSecret(ciphertext) {
  if (!ciphertext || !canEncrypt()) return ciphertext;
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  } catch {
    return ciphertext;
  }
}

function readSecrets() {
  const paths = getAppPaths();
  return readJsonSafe(paths.secretsPath, {});
}

function writeSecrets(secrets) {
  const paths = getAppPaths();
  writeJsonSafe(paths.secretsPath, secrets);
}

// Extract all API keys from cfg, encrypt & save to secrets file.
// The api_key fields in the returned cfg copy are cleared.
function saveApiKeysToSecrets(cfg) {
  const secrets = readSecrets();
  const providers = cfg?.llm?.providers || {};
  for (const [name, provider] of Object.entries(providers)) {
    if (provider?.api_key) {
      secrets[`llm.providers.${name}.api_key`] = encryptSecret(provider.api_key);
      provider.api_key = '';
    }
  }
  // Also handle search provider API keys
  const searchProviders = cfg?.search?.providers || {};
  for (const [name, provider] of Object.entries(searchProviders)) {
    if (provider && typeof provider === 'object' && provider.api_key) {
      secrets[`search.providers.${name}.api_key`] = encryptSecret(provider.api_key);
      provider.api_key = '';
    }
  }
  writeSecrets(secrets);
}

// Re-inject decrypted API keys from secrets file into cfg (mutates in place).
function injectApiKeysFromSecrets(cfg) {
  const secrets = readSecrets();
  const providers = cfg?.llm?.providers || {};
  for (const name of Object.keys(providers)) {
    const secretKey = `llm.providers.${name}.api_key`;
    if (secrets[secretKey]) {
      providers[name].api_key = decryptSecret(secrets[secretKey]);
    }
  }
  const searchProviders = cfg?.search?.providers || {};
  for (const name of Object.keys(searchProviders)) {
    const secretKey = `search.providers.${name}.api_key`;
    if (secrets[secretKey] && searchProviders[name] && typeof searchProviders[name] === 'object') {
      searchProviders[name].api_key = decryptSecret(secrets[secretKey]);
    }
  }
  return cfg;
}

// ────────────────────────────────────────────────────────────────────────────

function getDefaultConfig() {
  const paths = getAppPaths();
  return {
    tts: {
      engine: 'kitten',
      model_variant: 'kitten_nano_v02',
      model_dir: path.join(paths.modelsRoot, 'kitten-nano-en-v0_2-fp16'),
      model: 'model.fp16.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      data_dir: 'espeak-ng-data',
      dict_dir: 'dict',
      lexicon: 'lexicon.txt',
      lang: 'en-us',
      num_threads: 2,
      provider: 'cpu',
      sample_rate: 24000,
      voice_map: {
        Bella: 0, Jasper: 1, Luna: 2, Bruno: 3,
        Rosie: 4, Hugo: 5, Kiki: 6, Leo: 7
      }
    },
    llm: {
      backend_mode: 'api',
      provider: 'openai',
      system_prompt: 'You are a helpful assistant.',
      user_prompt: '',
      local: {
        enabled: true,
        runtime: 'llama_cpp',
        binary: {
          managed: true, path: '', version: '', channel: 'stable',
          manifest_url: '', current_asset_id: '', sha256: '',
          install_variant: 'auto', install_source: 'github_release',
          release_source: 'api', release_tag: '',
          installed: [], active_runtime_id: ''
        },
        server: { host: '127.0.0.1', port: 11435, args: [] },
        models_dir: paths.localModelsRoot,
        base_url: `http://127.0.0.1:11435/v1`,
        active_model_id: '', default_model_id: '', models: []
      },
      providers: {
        openai: {
          type: 'openai_compat', base_url: 'https://api.openai.com/v1',
          api_key: '', model: '', default_params: { temperature: 0.7 }
        },
        openrouter: {
          type: 'openai_compat', base_url: 'https://openrouter.ai/api/v1',
          api_key: '', model: '', default_params: { temperature: 0.7 }
        },
        lmstudio: {
          type: 'openai_compat', base_url: 'http://localhost:1234/v1',
          api_key: '', model: '', default_params: { temperature: 0.7 }
        }
      }
    },
    stt: {
      provider: 'local', model: 'whisper-1',
      whisper_quality: 'base',
    },
    onboarding: {
      completed: false,
      completed_at: null,
    }
  };
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function slugify(input) {
  return String(input || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    return true;
  } catch {
    return false;
  }
}

let _config = null;
let _configLock = false;

// Always read config from disk, bypassing the in-memory cache.
// Used when we need the authoritative on-disk state (e.g., to restore API keys).
export function loadConfigFromDisk() {
  const paths = getAppPaths();
  const defaultCfg = getDefaultConfig();
  if (!fs.existsSync(paths.configPath)) {
    return structuredClone(defaultCfg);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
    const cfg = deepMerge(structuredClone(defaultCfg), raw || {});
    return injectApiKeysFromSecrets(cfg);
  } catch {
    return structuredClone(defaultCfg);
  }
}

async function waitForConfigLock(maxWaitMs = 5000) {
  const start = Date.now();
  while (_configLock) {
    if (Date.now() - start > maxWaitMs) return false;
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
}

export function loadConfig() {
  const paths = getAppPaths();
  if (_config && !_configLock) return _config;
  const defaultCfg = getDefaultConfig();
  if (!fs.existsSync(paths.configPath)) {
    saveConfig(defaultCfg);
    _config = structuredClone(defaultCfg);
    return _config;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
    _config = deepMerge(structuredClone(defaultCfg), raw || {});
    injectApiKeysFromSecrets(_config);
    _config = migrateConfig(_config);
    return _config;
  } catch {
    saveConfig(defaultCfg);
    _config = structuredClone(defaultCfg);
    return _config;
  }
}

// Fix known stale/wrong provider base URLs from older configs
function migrateConfig(cfg) {
  const urlFixes = {
    'https://openrouter.ai/api': 'https://openrouter.ai/api/v1',
    'https://openrouter.ai/api/': 'https://openrouter.ai/api/v1',
    // B1: fix missing /v1 suffix on openai and lmstudio base URLs
    'https://api.openai.com': 'https://api.openai.com/v1',
    'http://localhost:1234': 'http://localhost:1234/v1',
  };
  let dirty = false;
  const legacyTtsVariants = {
    kitten_en_nano_08: 'kitten_nano_v02',
    kitten_nano_08: 'kitten_nano_v01',
    kokoro_multi_v1: 'kokoro_82m_v1'
  };
  const providers = cfg?.llm?.providers ?? {};
  const legacyDefaultModels = new Set([
    'gpt-4o-mini',
    'openai/gpt-4o-mini',
    'local-model',
    'default-model'
  ]);
  for (const [key, provider] of Object.entries(providers)) {
    if (provider?.base_url && urlFixes[provider.base_url]) {
      providers[key].base_url = urlFixes[provider.base_url];
      dirty = true;
    }
    const model = String(provider?.model || '').trim();
    if (legacyDefaultModels.has(model)) {
      providers[key].model = '';
      dirty = true;
    }
  }
  if (cfg?.tts?.model_variant && legacyTtsVariants[cfg.tts.model_variant]) {
    cfg.tts.model_variant = legacyTtsVariants[cfg.tts.model_variant];
    dirty = true;
  }
  const ttsDirMap = {
    kitten_nano_v02: 'kitten-nano-en-v0_2-fp16',
    kitten_nano_v01: 'kitten-nano-en-v0_1-fp16',
    kitten_mini_v01: 'kitten-mini-en-v0_1-fp16',
    kokoro_82m_v1: 'kokoro-multi-lang-v1_0',
    kokoro_v11: 'kokoro-multi-lang-v1_1'
  };
  const ttsModelMap = {
    kitten_nano_v02: 'model.fp16.onnx',
    kitten_nano_v01: 'model.fp16.onnx',
    kitten_mini_v01: 'model.fp16.onnx',
    kokoro_82m_v1: 'model.int8.onnx',
    kokoro_v11: 'model.int8.onnx'
  };
  if (cfg?.tts?.model_variant && ttsDirMap[cfg.tts.model_variant]) {
    const desiredDir = path.join(getAppPaths().modelsRoot, ttsDirMap[cfg.tts.model_variant]);
    if (!cfg.tts.model_dir || !cfg.tts.model_dir.includes(ttsDirMap[cfg.tts.model_variant])) {
      cfg.tts.model_dir = desiredDir;
      dirty = true;
    }
    const desiredModel = ttsModelMap[cfg.tts.model_variant];
    if (desiredModel && cfg.tts.model !== desiredModel) {
      cfg.tts.model = desiredModel;
      dirty = true;
    }
  }

  // Migrate legacy STT provider names (e.g. "openai") to explicit modes.
  const legacySttProviders = new Set([
    'openai', 'openrouter', 'lmstudio', 'groq', 'mistral', 'anthropic', 'gemini', 'perplexity', 'xai'
  ]);
  const sttProvider = String(cfg?.stt?.provider || '').trim().toLowerCase();
  if (legacySttProviders.has(sttProvider)) {
    cfg.stt = cfg.stt || {};
    cfg.stt.provider = 'local';
    dirty = true;
  }

  // Ensure onboarding key exists for older configs
  if (!cfg.onboarding) {
    cfg.onboarding = { completed: false, completed_at: null };
    dirty = true;
  }
  if (dirty) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  const paths = getAppPaths();
  _configLock = true;
  try {
    const toWrite = structuredClone(cfg);
    saveApiKeysToSecrets(toWrite);
    _config = structuredClone(cfg);
    writeJsonSafe(paths.configPath, toWrite);
  } finally {
    _configLock = false;
  }
}

export async function updateConfig(partial) {
  await waitForConfigLock();
  const current = loadConfig();
  const merged = deepMerge(structuredClone(current), partial);
  saveConfig(merged);
  return merged;
}

export function redactConfig(cfg) {
  const out = structuredClone(cfg);
  for (const provider of Object.values(out.llm?.providers || {})) {
    if (provider.api_key) {
      provider.has_api_key = true;
      delete provider.api_key;
    } else {
      provider.has_api_key = false;
    }
  }
  return out;
}

export {
  TTS_MODEL_CATALOG, WHISPER_QUALITY_CATALOG, LOCAL_GGUF_CATALOG,
  RUNTIME_INSTALL_VARIANTS,
  deepMerge, slugify, readJsonSafe, writeJsonSafe
};
