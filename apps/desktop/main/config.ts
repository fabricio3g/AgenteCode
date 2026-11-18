/**
 * Main configuration module for Agente.
 * 
 * This module orchestrates config loading, saving, and management.
 * It integrates:
 * - Utility functions from config.utils.ts
 * - Default config from config.defaults.ts
 * - Migration logic from config.migrate.ts
 * - Secret management from config.secrets.ts
 * - Redaction from config.redact.ts
 * 
 * Electron-dependent functions remain in this module.
 */

import fs from 'node:fs';
import { getAppPaths } from './paths.ts';

// Import from TypeScript modules
import { deepMerge, deepClone, readJsonSafe, writeJsonSafe } from './config.utils.ts';
import { getDefaultConfig } from './config.defaults.ts';
import { migrateConfig } from './config.migrate.ts';
import { SecretsManager, CryptoProvider } from './config.secrets.ts';
import type { AppConfig, AppPaths as AppPathsType } from './config.types.ts';

// ── Model Catalogs ───────────────────────────────────────────────────────────

export const TTS_MODEL_CATALOG = {
  kokoro_v11: {
    label: 'Kokoro v1.1 Multi-language (High Quality)',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    dir: 'kokoro-multi-lang-v1_1',
    engine: 'kokoro',
    lang: 'multi',
    voice_map: {}
  },
  kokoro_82m_v1: {
    label: 'Kokoro Multi-lang v1.0',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_0',
    dir: 'kokoro-multi-lang-v1_0',
    engine: 'kokoro',
    lang: 'multi',
    voice_map: {}
  }
};

export const WHISPER_QUALITY_CATALOG = {
  tiny_q5: {
    label: 'Tiny (Q5_1) — Fastest',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    file: 'ggml-tiny-q5_1.bin',
    multilingual: true,
    files: ['ggml-tiny-q5_1.bin'],
  },
  base_q5: {
    label: 'Base (Q5_1) — Fast',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    file: 'ggml-base-q5_1.bin',
    multilingual: true,
    files: ['ggml-base-q5_1.bin'],
  },
  small_q5: {
    label: 'Small (Q5_1) — Balanced',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    file: 'ggml-small-q5_1.bin',
    multilingual: true,
    files: ['ggml-small-q5_1.bin'],
  },
  medium_q5: {
    label: 'Medium (Q5_0) — Recommended',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    file: 'ggml-medium-q5_0.bin',
    multilingual: true,
    files: ['ggml-medium-q5_0.bin'],
  },
  large_v3_q5: {
    label: 'Large v3 (Q5_0) — Best',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    file: 'ggml-large-v3-q5_0.bin',
    multilingual: true,
    files: ['ggml-large-v3-q5_0.bin'],
  },
  large_v3_turbo_q5: {
    label: 'Large v3 Turbo (Q5_0) — Best',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    multilingual: true,
    files: ['ggml-large-v3-turbo-q5_0.bin'],
  },
};

export const LOCAL_GGUF_CATALOG = {
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

// ── Electron safeStorage Crypto Provider ─────────────────────────────────────

/**
 * Gets safeStorage lazily (only available inside Electron runtime).
 */
function getSafeStorage() {
  try {
    return require('electron').safeStorage;
  } catch {
    return null;
  }
}

/**
 * Crypto provider that uses Electron's safeStorage for real encryption.
 */
class ElectronSafeStorageCrypto implements CryptoProvider {
  isEncryptionAvailable(): boolean {
    const safeStorage = getSafeStorage();
    try {
      return safeStorage?.isEncryptionAvailable?.() ?? false;
    } catch {
      return false;
    }
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;
    const safeStorage = getSafeStorage();
    if (!safeStorage) return plaintext;
    try {
      return safeStorage.encryptString(plaintext).toString('base64');
    } catch {
      return plaintext;
    }
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext) return ciphertext;
    const safeStorage = getSafeStorage();
    if (!safeStorage) return ciphertext;
    try {
      return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
    } catch {
      return ciphertext;
    }
  }
}

/**
 * Gets the paths provider for secrets manager.
 */
function getSecretsPaths(): AppPathsType {
  return getAppPaths() as AppPathsType;
}

/**
 * Creates a secrets manager with Electron's safeStorage.
 */
function createElectronSecretsManager(): SecretsManager {
  return new SecretsManager(new ElectronSafeStorageCrypto(), getSecretsPaths());
}

// ── Config State Management ──────────────────────────────────────────────────

let _config: AppConfig | null = null;
let _configLock = false;

/**
 * Waits for config lock to be released.
 * @param maxWaitMs - Maximum wait time in milliseconds
 * @returns true if lock was acquired, false if timeout
 */
async function waitForConfigLock(maxWaitMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (_configLock) {
    if (Date.now() - start > maxWaitMs) return false;
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
}

// ── Config Loading and Saving ────────────────────────────────────────────────

/**
 * Gets the default configuration using app paths.
 */
function createDefaultConfig(): AppConfig {
  const paths = getAppPaths() as AppPathsType;
  return getDefaultConfig(paths);
}

/**
 * Loads config from disk, bypassing the in-memory cache.
 * Used when we need authoritative on-disk state (e.g., to restore API keys).
 */
export function loadConfigFromDisk(): AppConfig {
  const paths = getAppPaths() as AppPathsType;
  const secretsManager = createElectronSecretsManager();
  const defaultCfg = createDefaultConfig();
  
  if (!fs.existsSync(paths.configPath)) {
    return deepClone(defaultCfg);
  }

  try {
    const raw = readJsonSafe(paths.configPath, {});
    const cfg = deepMerge(deepClone(defaultCfg), raw);
    secretsManager.injectApiKeysFromSecrets(cfg);
    return cfg;
  } catch {
    return deepClone(defaultCfg);
  }
}

/**
 * Loads config with caching.
 * Creates default config if file doesn't exist.
 */
export function loadConfig(): AppConfig {
  const paths = getAppPaths() as AppPathsType;
  const secretsManager = createElectronSecretsManager();
  
  if (_config && !_configLock) return _config;

  const defaultCfg = createDefaultConfig();

  if (!fs.existsSync(paths.configPath)) {
    saveConfig(defaultCfg);
    _config = deepClone(defaultCfg);
    return _config;
  }

  try {
    const raw = readJsonSafe(paths.configPath, {});
    _config = deepMerge(deepClone(defaultCfg), raw);
    secretsManager.injectApiKeysFromSecrets(_config);
    
    // Run migrations
    const result = migrateConfig(_config, paths.modelsRoot);
    _config = result.config;
    
    // Save if migrations made changes
    if (result.dirty) {
      saveConfig(_config);
    }
    
    return _config;
  } catch {
    saveConfig(defaultCfg);
    _config = deepClone(defaultCfg);
    return _config;
  }
}

/**
 * Saves config to disk.
 * Encrypts API keys to secrets file before saving.
 */
export function saveConfig(cfg: AppConfig): void {
  const paths = getAppPaths() as AppPathsType;
  const secretsManager = createElectronSecretsManager();
  
  _configLock = true;
  try {
    const toWrite = deepClone(cfg);
    secretsManager.saveApiKeysToSecrets(toWrite);
    _config = deepClone(cfg);
    writeJsonSafe(paths.configPath, toWrite);
  } finally {
    _configLock = false;
  }
}

/**
 * Updates config with partial values.
 */
export async function updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  await waitForConfigLock();
  const current = loadConfig();
  const merged = deepMerge(deepClone(current), partial);
  saveConfig(merged);
  return merged;
}

/** Drop Desktop's own copy of an LLM provider's key (the Rust core holds it now). */
export function forgetProviderKey(id: string): void {
  createElectronSecretsManager().deleteSecret(`llm.providers.${id}.api_key`);
  const provider = _config?.llm?.providers?.[id] as { api_key?: string } | undefined;
  if (provider) delete provider.api_key;
}

// Export types
export type { AppConfig } from './config.types.ts';
