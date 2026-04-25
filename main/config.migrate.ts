/**
 * Configuration migration logic.
 * Handles upgrading older config versions to current schema.
 */

import path from 'node:path';
import type {
  AppConfig,
  TTSConfig,
  STTConfig,
  OnboardingConfig,
  LLMConfig,
} from './config.types.ts';

/**
 * URL fixes for known stale/wrong provider base URLs.
 */
const URL_FIXES: Record<string, string> = {
  'https://openrouter.ai/api': 'https://openrouter.ai/api/v1',
  'https://openrouter.ai/api/': 'https://openrouter.ai/api/v1',
  'https://api.openai.com': 'https://api.openai.com/v1',
  'http://localhost:1234': 'http://localhost:1234/v1',
};

/**
 * Legacy TTS model variant mappings to current variants.
 */
const LEGACY_TTS_VARIANTS: Record<string, string> = {
  kitten_en_nano_08: 'kitten_nano_v02',
  kitten_nano_08: 'kitten_nano_v01',
  kokoro_multi_v1: 'kokoro_82m_v1',
};

/**
 * TTS model directory mappings.
 */
const TTS_DIR_MAP: Record<string, string> = {
  kitten_nano_v02: 'kitten-nano-en-v0_2-fp16',
  kitten_nano_v01: 'kitten-nano-en-v0_1-fp16',
  kitten_mini_v01: 'kitten-mini-en-v0_1-fp16',
  kokoro_82m_v1: 'kokoro-multi-lang-v1_0',
  kokoro_v11: 'kokoro-multi-lang-v1_1',
};

/**
 * TTS model filename mappings.
 */
const TTS_MODEL_MAP: Record<string, string> = {
  kitten_nano_v02: 'model.fp16.onnx',
  kitten_nano_v01: 'model.fp16.onnx',
  kitten_mini_v01: 'model.fp16.onnx',
  kokoro_82m_v1: 'model.int8.onnx',
  kokoro_v11: 'model.int8.onnx',
};

/**
 * Legacy default model names that should be cleared.
 */
const LEGACY_DEFAULT_MODELS = new Set([
  'gpt-4o-mini',
  'openai/gpt-4o-mini',
  'local-model',
  'default-model',
]);

/**
 * Legacy STT provider names that should be migrated to 'local'.
 */
const LEGACY_STT_PROVIDERS = new Set([
  'openai', 'openrouter', 'lmstudio', 'groq', 'mistral',
  'anthropic', 'gemini', 'perplexity', 'xai',
]);

/**
 * Provider configuration interface for migration.
 */
export interface ProviderConfig {
  base_url?: string;
  model?: string;
  api_key?: string;
  type?: string;
  default_params?: Record<string, unknown>;
}

/**
 * Migration result with dirty flag indicating if changes were made.
 */
export interface MigrationResult {
  config: AppConfig;
  dirty: boolean;
}

/**
 * Result of provider URL migration.
 */
export interface ProviderMigrationResult {
  urlFixed: boolean;
  modelCleared: boolean;
}

/**
 * Migrates a single provider's configuration.
 * @param provider - The provider config to migrate
 * @returns Object indicating what changes were made
 */
export function migrateProvider(provider: ProviderConfig): ProviderMigrationResult {
  let urlFixed = false;
  let modelCleared = false;

  // Fix base URL if needed
  if (provider.base_url && URL_FIXES[provider.base_url]) {
    provider.base_url = URL_FIXES[provider.base_url];
    urlFixed = true;
  }

  // Clear legacy default models
  const model = String(provider.model || '').trim();
  if (LEGACY_DEFAULT_MODELS.has(model)) {
    provider.model = '';
    modelCleared = true;
  }

  return { urlFixed, modelCleared };
}

/**
 * Migrates TTS configuration to current schema.
 * @param tts - TTS config to migrate
 * @param modelsRoot - Root path for models directory
 * @returns true if changes were made
 */
export function migrateTTS(tts: TTSConfig, modelsRoot: string): boolean {
  let dirty = false;

  // Migrate legacy model variant names
  if (tts.model_variant && LEGACY_TTS_VARIANTS[tts.model_variant]) {
    tts.model_variant = LEGACY_TTS_VARIANTS[tts.model_variant];
    dirty = true;
  }

  // Fix model_dir and model filename
  if (tts.model_variant && TTS_DIR_MAP[tts.model_variant]) {
    const desiredDir = path.join(modelsRoot, TTS_DIR_MAP[tts.model_variant]);
    if (!tts.model_dir || !tts.model_dir.includes(TTS_DIR_MAP[tts.model_variant])) {
      tts.model_dir = desiredDir;
      dirty = true;
    }

    const desiredModel = TTS_MODEL_MAP[tts.model_variant];
    if (desiredModel && tts.model !== desiredModel) {
      tts.model = desiredModel;
      dirty = true;
    }
  }

  return dirty;
}

/**
 * Migrates STT configuration to current schema.
 * @param stt - STT config to migrate
 * @returns true if changes were made
 */
export function migrateSTT(stt: STTConfig): boolean {
  const sttProvider = String(stt.provider || '').trim().toLowerCase();
  if (LEGACY_STT_PROVIDERS.has(sttProvider)) {
    stt.provider = 'local';
    return true;
  }
  return false;
}

/**
 * Ensures onboarding configuration exists.
 * @param cfg - Full config object
 * @returns true if onboarding was added
 */
export function ensureOnboarding(cfg: AppConfig): boolean {
  if (!cfg.onboarding) {
    cfg.onboarding = { completed: false, completed_at: null };
    return true;
  }
  return false;
}

/**
 * Migrates the full configuration to the current schema.
 * @param cfg - Configuration object to migrate (mutated in place)
 * @param modelsRoot - Root path for models directory
 * @returns Migration result with config and dirty flag
 */
export function migrateConfig(cfg: AppConfig, modelsRoot: string): MigrationResult {
  let dirty = false;

  // Migrate LLM providers
  const providers = cfg.llm?.providers ?? {};
  for (const provider of Object.values(providers)) {
    if (provider && typeof provider === 'object') {
      const result = migrateProvider(provider as ProviderConfig);
      if (result.urlFixed || result.modelCleared) {
        dirty = true;
      }
    }
  }

  // Migrate TTS
  if (cfg.tts) {
    if (migrateTTS(cfg.tts, modelsRoot)) {
      dirty = true;
    }
  }

  // Migrate STT
  if (cfg.stt) {
    if (migrateSTT(cfg.stt)) {
      dirty = true;
    }
  }

  // Ensure onboarding exists
  if (ensureOnboarding(cfg)) {
    dirty = true;
  }

  return { config: cfg, dirty };
}

// Export constants for testing
export {
  URL_FIXES,
  LEGACY_TTS_VARIANTS,
  TTS_DIR_MAP,
  TTS_MODEL_MAP,
  LEGACY_DEFAULT_MODELS,
  LEGACY_STT_PROVIDERS,
};