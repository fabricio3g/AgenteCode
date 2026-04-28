/**
 * Tests for configuration migration functions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  migrateProvider,
  migrateTTS,
  migrateSTT,
  ensureOnboarding,
  migrateConfig,
  URL_FIXES,
  LEGACY_TTS_VARIANTS,
  LEGACY_DEFAULT_MODELS,
  LEGACY_STT_PROVIDERS,
} from '../../main/config.migrate.ts';

// ── Constants tests ──────────────────────────────────────────────────────────

describe('Migration constants', () => {
  it('URL_FIXES contains expected mappings', () => {
    assert.strictEqual(URL_FIXES['https://openrouter.ai/api'], 'https://openrouter.ai/api/v1');
    assert.strictEqual(URL_FIXES['https://api.openai.com'], 'https://api.openai.com/v1');
    assert.strictEqual(URL_FIXES['http://localhost:1234'], 'http://localhost:1234/v1');
  });

  it('LEGACY_TTS_VARIANTS maps old names to new', () => {
    assert.strictEqual(LEGACY_TTS_VARIANTS['kitten_en_nano_08'], 'kokoro_v11');
    assert.strictEqual(LEGACY_TTS_VARIANTS['kitten_nano_08'], 'kokoro_v11');
    assert.strictEqual(LEGACY_TTS_VARIANTS['kokoro_multi_v1'], 'kokoro_82m_v1');
  });

  it('LEGACY_DEFAULT_MODELS contains expected values', () => {
    assert.ok(LEGACY_DEFAULT_MODELS.has('gpt-4o-mini'));
    assert.ok(LEGACY_DEFAULT_MODELS.has('openai/gpt-4o-mini'));
    assert.ok(LEGACY_DEFAULT_MODELS.has('local-model'));
    assert.ok(LEGACY_DEFAULT_MODELS.has('default-model'));
    assert.ok(!LEGACY_DEFAULT_MODELS.has('gpt-4o'));
  });

  it('LEGACY_STT_PROVIDERS contains expected values', () => {
    assert.ok(LEGACY_STT_PROVIDERS.has('openai'));
    assert.ok(LEGACY_STT_PROVIDERS.has('anthropic'));
    assert.ok(LEGACY_STT_PROVIDERS.has('groq'));
    assert.ok(!LEGACY_STT_PROVIDERS.has('local'));
  });
});

// ── migrateProvider tests ────────────────────────────────────────────────────

describe('migrateProvider', () => {
  it('fixes openrouter base URL without /v1', () => {
    const provider = { base_url: 'https://openrouter.ai/api', model: 'test' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.urlFixed, true);
    assert.strictEqual(provider.base_url, 'https://openrouter.ai/api/v1');
  });

  it('fixes openai base URL without /v1', () => {
    const provider = { base_url: 'https://api.openai.com', model: 'test' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.urlFixed, true);
    assert.strictEqual(provider.base_url, 'https://api.openai.com/v1');
  });

  it('fixes lmstudio base URL without /v1', () => {
    const provider = { base_url: 'http://localhost:1234', model: 'test' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.urlFixed, true);
    assert.strictEqual(provider.base_url, 'http://localhost:1234/v1');
  });

  it('does not change correct URLs', () => {
    const provider = { base_url: 'https://api.openai.com/v1', model: 'gpt-4' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.urlFixed, false);
    assert.strictEqual(provider.base_url, 'https://api.openai.com/v1');
  });

  it('clears legacy default model gpt-4o-mini', () => {
    const provider = { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.modelCleared, true);
    assert.strictEqual(provider.model, '');
  });

  it('clears legacy default model openai/gpt-4o-mini', () => {
    const provider = { base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.modelCleared, true);
    assert.strictEqual(provider.model, '');
  });

  it('clears legacy default model local-model', () => {
    const provider = { base_url: 'http://localhost:1234/v1', model: 'local-model' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.modelCleared, true);
    assert.strictEqual(provider.model, '');
  });

  it('does not clear valid custom model', () => {
    const provider = { base_url: 'https://api.openai.com/v1', model: 'gpt-4-turbo' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.modelCleared, false);
    assert.strictEqual(provider.model, 'gpt-4-turbo');
  });

  it('handles empty model', () => {
    const provider = { base_url: 'https://api.openai.com/v1', model: '' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.modelCleared, false);
    assert.strictEqual(provider.model, '');
  });

  it('handles missing model field', () => {
    const provider = { base_url: 'https://api.openai.com/v1' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.modelCleared, false);
  });

  it('handles provider with no changes needed', () => {
    const provider = { base_url: 'https://api.anthropic.com', model: 'claude-3' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.urlFixed, false);
    assert.strictEqual(result.modelCleared, false);
  });

  it('fixes both URL and model in single call', () => {
    const provider = { base_url: 'https://openrouter.ai/api', model: 'gpt-4o-mini' };
    const result = migrateProvider(provider);
    assert.strictEqual(result.urlFixed, true);
    assert.strictEqual(result.modelCleared, true);
    assert.strictEqual(provider.base_url, 'https://openrouter.ai/api/v1');
    assert.strictEqual(provider.model, '');
  });
});

// ── migrateTTS tests ─────────────────────────────────────────────────────────

describe('migrateTTS', () => {
  const modelsRoot = '/path/to/models';

  it('migrates legacy TTS variant kitten_en_nano_08 to kokoro_v11', () => {
    const tts = { model_variant: 'kitten_en_nano_08' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, true);
    assert.strictEqual(tts.model_variant, 'kokoro_v11');
  });

  it('migrates legacy TTS variant kokoro_multi_v1', () => {
    const tts = { model_variant: 'kokoro_multi_v1' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, true);
    assert.strictEqual(tts.model_variant, 'kokoro_82m_v1');
  });

  it('does not change current TTS variant', () => {
    const tts = { model_variant: 'kokoro_v11', model_dir: '/path/to/models/kokoro-multi-lang-v1_1', model: 'model.int8.onnx' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, false);
  });

  it('fixes model_dir for valid variant', () => {
    const tts = { model_variant: 'kokoro_v11', model_dir: '/wrong/path' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, true);
    assert.ok(tts.model_dir.includes('kokoro-multi-lang-v1_1'));
  });

  it('sets model_dir when missing', () => {
    const tts = { model_variant: 'kokoro_82m_v1' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, true);
    assert.ok(tts.model_dir.includes('kokoro-multi-lang-v1_0'));
  });

  it('fixes model filename for kokoro variant', () => {
    const tts = { model_variant: 'kokoro_v11', model_dir: '/path/to/models/kokoro-multi-lang-v1_1', model: 'wrong.onnx' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, true);
    assert.strictEqual(tts.model, 'model.int8.onnx');
  });

  it('fixes model filename for kokoro variant', () => {
    const tts = { model_variant: 'kokoro_82m_v1', model_dir: '/path/to/models/kokoro-multi-lang-v1_0', model: 'wrong.onnx' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, true);
    assert.strictEqual(tts.model, 'model.int8.onnx');
  });

  it('handles unknown variant without changes', () => {
    const tts = { model_variant: 'unknown_variant' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, false);
    assert.strictEqual(tts.model_variant, 'unknown_variant');
  });

  it('handles missing model_variant', () => {
    const tts = { model: 'test.onnx' };
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, false);
  });

  it('handles empty TTS config', () => {
    const tts = {};
    const dirty = migrateTTS(tts, modelsRoot);
    assert.strictEqual(dirty, false);
  });
});

// ── migrateSTT tests ─────────────────────────────────────────────────────────

describe('migrateSTT', () => {
  it('migrates legacy STT provider openai to local', () => {
    const stt = { provider: 'openai', model: 'whisper-1' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, true);
    assert.strictEqual(stt.provider, 'local');
  });

  it('migrates legacy STT provider anthropic to local', () => {
    const stt = { provider: 'anthropic' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, true);
    assert.strictEqual(stt.provider, 'local');
  });

  it('migrates legacy STT provider groq to local', () => {
    const stt = { provider: 'groq' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, true);
    assert.strictEqual(stt.provider, 'local');
  });

  it('does not change local STT provider', () => {
    const stt = { provider: 'local', model: 'whisper-1' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, false);
    assert.strictEqual(stt.provider, 'local');
  });

  it('handles uppercase legacy provider', () => {
    const stt = { provider: 'OPENAI' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, true);
    assert.strictEqual(stt.provider, 'local');
  });

  it('handles provider with whitespace', () => {
    const stt = { provider: '  openai  ' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, true);
    assert.strictEqual(stt.provider, 'local');
  });

  it('handles missing provider field', () => {
    const stt = { model: 'whisper-1' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, false);
  });

  it('handles empty provider', () => {
    const stt = { provider: '' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, false);
  });

  it('preserves other STT fields', () => {
    const stt = { provider: 'openai', model: 'whisper-1', whisper_quality: 'base' };
    const dirty = migrateSTT(stt);
    assert.strictEqual(dirty, true);
    assert.strictEqual(stt.provider, 'local');
    assert.strictEqual(stt.model, 'whisper-1');
    assert.strictEqual(stt.whisper_quality, 'base');
  });
});

// ── ensureOnboarding tests ───────────────────────────────────────────────────

describe('ensureOnboarding', () => {
  it('adds onboarding when missing', () => {
    const cfg = { tts: {}, llm: {} };
    const dirty = ensureOnboarding(cfg);
    assert.strictEqual(dirty, true);
    assert.deepStrictEqual(cfg.onboarding, { completed: false, completed_at: null });
  });

  it('does not change existing onboarding', () => {
    const cfg = { onboarding: { completed: true, completed_at: '2024-01-01' } };
    const dirty = ensureOnboarding(cfg);
    assert.strictEqual(dirty, false);
    assert.strictEqual(cfg.onboarding.completed, true);
  });

  it('handles empty config', () => {
    const cfg = {};
    const dirty = ensureOnboarding(cfg);
    assert.strictEqual(dirty, true);
    assert.ok(cfg.onboarding);
  });

  it('does not overwrite partial onboarding', () => {
    const cfg = { onboarding: { completed: true } };
    const dirty = ensureOnboarding(cfg);
    assert.strictEqual(dirty, false);
    assert.strictEqual(cfg.onboarding.completed, true);
  });
});

// ── migrateConfig tests (full integration) ───────────────────────────────────

describe('migrateConfig', () => {
  const modelsRoot = '/path/to/models';

  it('migrates all fields in legacy config', () => {
    const cfg = {
      llm: {
        providers: {
          openai: { base_url: 'https://api.openai.com', model: 'gpt-4o-mini' },
          openrouter: { base_url: 'https://openrouter.ai/api', model: 'openai/gpt-4o-mini' },
        },
      },
      tts: { model_variant: 'kitten_en_nano_08' },
      stt: { provider: 'openai' },
    };
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.dirty, true);
    assert.strictEqual(cfg.llm.providers.openai.base_url, 'https://api.openai.com/v1');
    assert.strictEqual(cfg.llm.providers.openai.model, '');
    assert.strictEqual(cfg.llm.providers.openrouter.base_url, 'https://openrouter.ai/api/v1');
    assert.strictEqual(cfg.tts.model_variant, 'kokoro_v11');
    assert.strictEqual(cfg.stt.provider, 'local');
    assert.ok(cfg.onboarding);
  });

  it('returns clean config when no migrations needed', () => {
    const cfg = {
      llm: {
        providers: {
          openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4-turbo' },
        },
      },
      tts: { model_variant: 'kokoro_v11', model_dir: '/path/to/models/kokoro-multi-lang-v1_1', model: 'model.int8.onnx' },
      stt: { provider: 'local' },
      onboarding: { completed: true },
    };
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.dirty, false);
  });

  it('handles empty config', () => {
    const cfg = {};
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.dirty, true); // Adds onboarding
    assert.ok(cfg.onboarding);
  });

  it('handles config with only llm', () => {
    const cfg = {
      llm: {
        providers: {
          lmstudio: { base_url: 'http://localhost:1234', model: 'local-model' },
        },
      },
    };
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.dirty, true);
    assert.strictEqual(cfg.llm.providers.lmstudio.base_url, 'http://localhost:1234/v1');
    assert.strictEqual(cfg.llm.providers.lmstudio.model, '');
    assert.ok(cfg.onboarding);
  });

  it('handles config with empty providers', () => {
    const cfg = {
      llm: { providers: {} },
      onboarding: { completed: false },
    };
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.dirty, false);
  });

  it('preserves unknown fields', () => {
    const cfg = {
      custom_field: 'should_remain',
      llm: { providers: {} },
      onboarding: { completed: true },
    };
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.dirty, false);
    assert.strictEqual(cfg.custom_field, 'should_remain');
  });

  it('returns same config object reference', () => {
    const cfg = { onboarding: { completed: true } };
    const result = migrateConfig(cfg, modelsRoot);
    assert.strictEqual(result.config, cfg);
  });
});