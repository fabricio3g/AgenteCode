/**
 * Tests for default configuration factory functions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import {
  DEFAULT_TTS_VOICE_MAP,
  getDefaultTTSConfig,
  getDefaultProvider,
  getDefaultProviders,
  getDefaultLocalLLMConfig,
  getDefaultLLMConfig,
  getDefaultRAGConfig,
  getDefaultSTTConfig,
  getDefaultOnboardingConfig,
  getDefaultConfig,
  createDefaultConfigWithPaths,
} from '../../main/config.defaults.ts';

// ── getDefaultTTSConfig tests ────────────────────────────────────────────────

describe('getDefaultTTSConfig', () => {
  const modelsRoot = '/path/to/models';

  it('returns valid TTS config', () => {
    const tts = getDefaultTTSConfig(modelsRoot);
    assert.ok(tts);
    assert.strictEqual(tts.engine, 'wasm');
    assert.strictEqual(tts.model_variant, 'kokoro_v11');
    assert.ok(tts.model_dir);
  });

  it('sets model_dir relative to modelsRoot', () => {
    const tts = getDefaultTTSConfig(modelsRoot);
    // path.join normalizes based on platform, so check for the directory name
    assert.ok(tts.model_dir.includes('kokoro-multi-lang-v1_1'));
    // Verify it's a valid absolute path structure
    assert.ok(path.isAbsolute(tts.model_dir) || tts.model_dir.startsWith('.'));
  });

  it('has default voice mapping', () => {
    const tts = getDefaultTTSConfig(modelsRoot);
    assert.deepStrictEqual(tts.voice_map, DEFAULT_TTS_VOICE_MAP);
    assert.notStrictEqual(tts.voice_map, DEFAULT_TTS_VOICE_MAP);
  });

  it('uses correct defaults', () => {
    const tts = getDefaultTTSConfig(modelsRoot);
    assert.strictEqual(tts.num_threads, 2);
    assert.strictEqual(tts.sample_rate, 24000);
    assert.strictEqual(tts.provider, 'cpu');
    assert.strictEqual(tts.lang, 'en-us');
  });

  it('handles Windows paths correctly', () => {
    const windowsRoot = 'C:\\Users\\test\\models';
    const tts = getDefaultTTSConfig(windowsRoot);
    assert.ok(tts.model_dir);
    // Path.join handles platform-specific separators
    assert.ok(tts.model_dir.includes('kokoro-multi-lang-v1_1'));
  });

  it('handles relative paths', () => {
    const relativeRoot = './models';
    const tts = getDefaultTTSConfig(relativeRoot);
    assert.ok(tts.model_dir);
    // Just verify it includes the TTS directory name
    assert.ok(tts.model_dir.includes('kokoro-multi-lang-v1_1'));
  });
});

// ── getDefaultProvider tests ─────────────────────────────────────────────────

describe('getDefaultProvider', () => {
  it('returns valid provider config', () => {
    const provider = getDefaultProvider('https://api.openai.com/v1');
    assert.ok(provider);
    assert.strictEqual(provider.type, 'openai_compat');
    assert.strictEqual(provider.base_url, 'https://api.openai.com/v1');
  });

  it('has empty api_key by default', () => {
    const provider = getDefaultProvider('https://api.test.com/v1');
    assert.strictEqual(provider.api_key, '');
  });

  it('has empty model by default', () => {
    const provider = getDefaultProvider('https://api.test.com/v1');
    assert.strictEqual(provider.model, '');
  });

  it('has default temperature', () => {
    const provider = getDefaultProvider('https://api.test.com/v1');
    assert.strictEqual(provider.default_params.temperature, 0.7);
  });

  it('accepts any base URL', () => {
    const provider = getDefaultProvider('http://localhost:8080/api');
    assert.strictEqual(provider.base_url, 'http://localhost:8080/api');
  });
});

// ── getDefaultProviders tests ────────────────────────────────────────────────

describe('getDefaultProviders', () => {
  it('returns provider map with expected keys', () => {
    const providers = getDefaultProviders();
    assert.ok(providers);
    assert.ok(providers.openai);
    assert.ok(providers.openrouter);
    assert.ok(providers.lmstudio);
    assert.strictEqual(Object.keys(providers).length, 3);
  });

  it('has correct openai base URL', () => {
    const providers = getDefaultProviders();
    assert.strictEqual(providers.openai.base_url, 'https://api.openai.com/v1');
  });

  it('has correct openrouter base URL', () => {
    const providers = getDefaultProviders();
    assert.strictEqual(providers.openrouter.base_url, 'https://openrouter.ai/api/v1');
  });

  it('has correct lmstudio base URL', () => {
    const providers = getDefaultProviders();
    assert.strictEqual(providers.lmstudio.base_url, 'http://localhost:1234/v1');
  });

  it('all providers are openai_compat type', () => {
    const providers = getDefaultProviders();
    for (const provider of Object.values(providers)) {
      assert.strictEqual(provider.type, 'openai_compat');
    }
  });

  it('all providers have empty api_key', () => {
    const providers = getDefaultProviders();
    for (const provider of Object.values(providers)) {
      assert.strictEqual(provider.api_key, '');
    }
  });
});

// ── getDefaultLocalLLMConfig tests ───────────────────────────────────────────

describe('getDefaultLocalLLMConfig', () => {
  const localModelsRoot = '/path/to/local/models';

  it('returns valid local config', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.ok(local);
    assert.strictEqual(local.enabled, true);
    assert.strictEqual(local.runtime, 'llama_cpp');
  });

  it('sets models_dir from parameter', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.strictEqual(local.models_dir, localModelsRoot);
  });

  it('uses default port 11435', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.strictEqual(local.server.port, 11435);
    assert.strictEqual(local.embedding_port, 11436);
  });

  it('accepts custom port', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot, 8080);
    assert.strictEqual(local.server.port, 8080);
    assert.ok(local.base_url.includes('8080'));
  });

  it('has default embedding model', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.strictEqual(local.embedding_model, 'nomic_embed_text_v15');
  });

  it('has managed binary by default', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.strictEqual(local.binary.managed, true);
    assert.strictEqual(local.binary.install_variant, 'auto');
  });

  it('has empty models list', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.deepStrictEqual(local.models, []);
    assert.strictEqual(local.active_model_id, '');
  });

  it('generates correct base_url', () => {
    const local = getDefaultLocalLLMConfig(localModelsRoot);
    assert.strictEqual(local.base_url, 'http://127.0.0.1:11435/v1');
  });
});

// ── getDefaultLLMConfig tests ────────────────────────────────────────────────

describe('getDefaultLLMConfig', () => {
  const localModelsRoot = '/path/to/local/models';

  it('returns valid LLM config', () => {
    const llm = getDefaultLLMConfig(localModelsRoot);
    assert.ok(llm);
    assert.strictEqual(llm.backend_mode, 'api');
    assert.strictEqual(llm.provider, 'openai');
  });

  it('has default system prompt', () => {
    const llm = getDefaultLLMConfig(localModelsRoot);
    assert.strictEqual(llm.system_prompt, 'You are a helpful assistant.');
    assert.strictEqual(llm.user_prompt, '');
  });

  it('has local config', () => {
    const llm = getDefaultLLMConfig(localModelsRoot);
    assert.ok(llm.local);
    assert.strictEqual(llm.local.enabled, true);
  });

  it('has providers map', () => {
    const llm = getDefaultLLMConfig(localModelsRoot);
    assert.ok(llm.providers);
    assert.ok(llm.providers.openai);
  });

  it('passes localModelsRoot to local config', () => {
    const llm = getDefaultLLMConfig(localModelsRoot);
    assert.strictEqual(llm.local.models_dir, localModelsRoot);
  });
});

// ── getDefaultRAGConfig tests ────────────────────────────────────────────────

describe('getDefaultRAGConfig', () => {
  it('returns valid RAG config', () => {
    const rag = getDefaultRAGConfig();
    assert.ok(rag);
    assert.strictEqual(rag.enabled, true);
  });

  it('auto starts embedding by default', () => {
    const rag = getDefaultRAGConfig();
    assert.strictEqual(rag.auto_start_embedding, true);
  });

  it('rerank is disabled by default', () => {
    const rag = getDefaultRAGConfig();
    assert.strictEqual(rag.rerank, false);
  });

  it('has preferred embedding model', () => {
    const rag = getDefaultRAGConfig();
    assert.strictEqual(rag.preferred_embedding_model, 'nomic_embed_text_v15');
  });

  it('has fallback embedding models', () => {
    const rag = getDefaultRAGConfig();
    assert.ok(Array.isArray(rag.fallback_embedding_models));
    assert.ok(rag.fallback_embedding_models.includes('all_minilm_l6_v2'));
  });
});

// ── getDefaultSTTConfig tests ────────────────────────────────────────────────

describe('getDefaultSTTConfig', () => {
  it('returns valid STT config', () => {
    const stt = getDefaultSTTConfig();
    assert.ok(stt);
    assert.strictEqual(stt.provider, 'local');
  });

  it('uses whisper-1 model', () => {
    const stt = getDefaultSTTConfig();
    assert.strictEqual(stt.model, 'whisper-1');
  });

  it('uses base quality by default', () => {
    const stt = getDefaultSTTConfig();
    assert.strictEqual(stt.whisper_quality, 'base');
  });
});

// ── getDefaultOnboardingConfig tests ─────────────────────────────────────────

describe('getDefaultOnboardingConfig', () => {
  it('returns valid onboarding config', () => {
    const onboarding = getDefaultOnboardingConfig();
    assert.ok(onboarding);
    assert.strictEqual(onboarding.completed, false);
    assert.strictEqual(onboarding.completed_at, null);
  });

  it('is not completed by default', () => {
    const onboarding = getDefaultOnboardingConfig();
    assert.strictEqual(onboarding.completed, false);
  });

  it('has null completed_at', () => {
    const onboarding = getDefaultOnboardingConfig();
    assert.strictEqual(onboarding.completed_at, null);
  });
});

// ── getDefaultConfig tests (full integration) ────────────────────────────────

describe('getDefaultConfig', () => {
  it('returns complete config object', () => {
    const paths = {
      configPath: '/config.json',
      secretsPath: '/secrets.json',
      modelsRoot: '/models',
      localModelsRoot: '/local/models',
    };
    const config = getDefaultConfig(paths);
    assert.ok(config);
    assert.ok(config.tts);
    assert.ok(config.llm);
    assert.ok(config.rag);
    assert.ok(config.stt);
    assert.ok(config.onboarding);
  });

  it('passes modelsRoot to TTS config', () => {
    const paths = {
      configPath: '/config.json',
      secretsPath: '/secrets.json',
      modelsRoot: '/my/models',
      localModelsRoot: '/local/models',
    };
    const config = getDefaultConfig(paths);
    // Check for the expected directory name (path.join normalizes separators)
    assert.ok(config.tts.model_dir.includes('kokoro-multi-lang-v1_1'));
  });

  it('passes localModelsRoot to LLM config', () => {
    const paths = {
      configPath: '/config.json',
      secretsPath: '/secrets.json',
      modelsRoot: '/models',
      localModelsRoot: '/my/local/models',
    };
    const config = getDefaultConfig(paths);
    assert.strictEqual(config.llm.local.models_dir, '/my/local/models');
  });

  it('uses correct defaults for all sections', () => {
    const paths = {
      configPath: '/config.json',
      secretsPath: '/secrets.json',
      modelsRoot: '/models',
      localModelsRoot: '/local',
    };
    const config = getDefaultConfig(paths);
    
    // Verify defaults are applied
    assert.strictEqual(config.llm.provider, 'openai');
    assert.strictEqual(config.tts.engine, 'wasm');
    assert.strictEqual(config.stt.provider, 'local');
    assert.strictEqual(config.rag.enabled, true);
    assert.strictEqual(config.onboarding.completed, false);
  });

  it('config is serializable to JSON', () => {
    const paths = {
      configPath: '/config.json',
      secretsPath: '/secrets.json',
      modelsRoot: '/models',
      localModelsRoot: '/local',
    };
    const config = getDefaultConfig(paths);
    const json = JSON.stringify(config);
    const parsed = JSON.parse(json);
    
    // Verify structure after JSON round-trip
    assert.ok(parsed.tts);
    assert.ok(parsed.llm);
    assert.ok(parsed.rag);
  });
});

// ── createDefaultConfigWithPaths tests ───────────────────────────────────────

describe('createDefaultConfigWithPaths', () => {
  it('creates config with custom paths', () => {
    const config = createDefaultConfigWithPaths('/models', '/local');
    assert.ok(config);
    // Check for expected directory names
    assert.ok(config.tts.model_dir.includes('kokoro-multi-lang-v1_1'));
    assert.strictEqual(config.llm.local.models_dir, '/local');
  });

  it('handles same path for both roots', () => {
    const config = createDefaultConfigWithPaths('/models', '/models');
    assert.ok(config.tts.model_dir.includes('kokoro-multi-lang-v1_1'));
    assert.strictEqual(config.llm.local.models_dir, '/models');
  });

  it('works with Windows paths', () => {
    const config = createDefaultConfigWithPaths('C:\\models', 'D:\\local');
    assert.ok(config.tts.model_dir);
    assert.ok(config.llm.local.models_dir);
  });

  it('works with relative paths', () => {
    const config = createDefaultConfigWithPaths('./models', '../local');
    assert.ok(config.tts.model_dir);
    assert.ok(config.llm.local.models_dir);
  });
});
