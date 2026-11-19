/**
 * Tests for configuration redaction functions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  redactProvider,
  redactLLMConfig,
  redactConfig,
  hasApiKey,
  countApiKeys,
} from '../../main/config.redact.ts';

// ── redactProvider tests ─────────────────────────────────────────────────────

describe('redactProvider', () => {
  it('removes api_key from provider', () => {
    const provider = {
      type: 'openai_compat',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-secret-key-123',
      model: 'gpt-4',
      default_params: { temperature: 0.7 }
    };
    const redacted = redactProvider(provider);
    assert.strictEqual(redacted.api_key, undefined);
    assert.ok(!('api_key' in redacted));
  });

  it('sets has_api_key to true when key exists', () => {
    const provider = {
      type: 'openai_compat',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      model: '',
      default_params: {}
    };
    const redacted = redactProvider(provider);
    assert.strictEqual(redacted.has_api_key, true);
  });

  it('sets has_api_key to false when key is empty', () => {
    const provider = {
      type: 'openai_compat',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      model: '',
      default_params: {}
    };
    const redacted = redactProvider(provider);
    assert.strictEqual(redacted.has_api_key, false);
  });

  it('sets has_api_key to false when key is missing', () => {
    const provider = {
      type: 'openai_compat',
      base_url: 'https://api.openai.com/v1',
      model: '',
      default_params: {}
    };
    const redacted = redactProvider(provider);
    assert.strictEqual(redacted.has_api_key, false);
  });

  it('preserves other provider fields', () => {
    const provider = {
      type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-ant-test',
      model: 'claude-3',
      default_params: { temperature: 0.5, max_tokens: 1024 }
    };
    const redacted = redactProvider(provider);
    assert.strictEqual(redacted.type, 'anthropic');
    assert.strictEqual(redacted.base_url, 'https://api.anthropic.com');
    assert.strictEqual(redacted.model, 'claude-3');
    assert.strictEqual(redacted.default_params.temperature, 0.5);
    assert.strictEqual(redacted.default_params.max_tokens, 1024);
  });

  it('does not mutate original provider', () => {
    const provider = {
      type: 'openai_compat',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret-key',
      model: '',
      default_params: {}
    };
    redactProvider(provider);
    assert.strictEqual(provider.api_key, 'secret-key');
  });

  it('handles whitespace-only api_key', () => {
    const provider = {
      type: 'openai_compat',
      base_url: 'https://api.openai.com/v1',
      api_key: '   ',
      model: '',
      default_params: {}
    };
    const redacted = redactProvider(provider);
    // Whitespace is truthy but still marks as having a key (non-empty string)
    assert.strictEqual(redacted.has_api_key, true);
  });
});

// ── redactLLMConfig tests ────────────────────────────────────────────────────

describe('redactLLMConfig', () => {
  it('redacts all providers', () => {
    const llm = {
      backend_mode: 'api',
      provider: 'openai',
      system_prompt: 'Hello',
      user_prompt: '',
      local: { enabled: true },
      providers: {
        openai: { api_key: 'sk-openai', model: 'gpt-4', base_url: 'https://api.openai.com/v1', type: 'openai_compat', default_params: {} },
        anthropic: { api_key: '', model: '', base_url: 'https://api.anthropic.com', type: 'anthropic', default_params: {} },
      }
    };
    const redacted = redactLLMConfig(llm);
    assert.strictEqual(redacted.providers.openai.has_api_key, true);
    assert.strictEqual(redacted.providers.anthropic.has_api_key, false);
    assert.strictEqual(redacted.providers.openai.api_key, undefined);
    assert.strictEqual(redacted.providers.anthropic.api_key, undefined);
  });

  it('handles empty providers object', () => {
    const llm = {
      backend_mode: 'api',
      provider: 'openai',
      providers: {}
    };
    const redacted = redactLLMConfig(llm);
    assert.deepStrictEqual(redacted.providers, {});
  });

  it('handles missing providers', () => {
    const llm = {};
    const redacted = redactLLMConfig(llm);
    assert.deepStrictEqual(redacted.providers, {});
  });

  it('preserves other LLM fields', () => {
    const llm = {
      backend_mode: 'local',
      provider: 'local',
      system_prompt: 'You are helpful',
      user_prompt: 'Custom prefix',
      local: { enabled: true, runtime: 'llama_cpp' },
      providers: {}
    };
    const redacted = redactLLMConfig(llm);
    assert.strictEqual(redacted.backend_mode, 'local');
    assert.strictEqual(redacted.provider, 'local');
    assert.strictEqual(redacted.system_prompt, 'You are helpful');
    assert.strictEqual(redacted.user_prompt, 'Custom prefix');
  });

  it('uses defaults for missing fields', () => {
    const llm = {
      providers: {
        openai: { api_key: 'sk-test', model: '', base_url: '', type: '', default_params: {} }
      }
    };
    const redacted = redactLLMConfig(llm);
    assert.strictEqual(redacted.backend_mode, 'api');
    assert.strictEqual(redacted.provider, '');
    assert.strictEqual(redacted.system_prompt, '');
  });
});

// ── redactConfig tests ───────────────────────────────────────────────────────

describe('redactConfig', () => {
  it('redacts full config without mutating original', () => {
    const config = {
      tts: { engine: 'kokoro' },
      llm: {
        backend_mode: 'api',
        provider: 'openai',
        system_prompt: 'Test',
        user_prompt: '',
        local: {},
        providers: {
          openai: { api_key: 'secret-key', model: 'gpt-4', base_url: 'https://api.openai.com/v1', type: 'openai_compat', default_params: {} },
        }
      },
      rag: { enabled: true },
      stt: { provider: 'local' },
      onboarding: { completed: false }
    };
    const redacted = redactConfig(config);
    
    // Original unchanged
    assert.strictEqual(config.llm.providers.openai.api_key, 'secret-key');
    
    // Redacted has has_api_key flag
    assert.strictEqual(redacted.llm.providers.openai.has_api_key, true);
    assert.strictEqual(redacted.llm.providers.openai.api_key, undefined);
  });

  it('preserves non-LLM sections', () => {
    const config = {
      tts: { engine: 'kokoro', model_variant: 'kokoro_v11' },
      llm: { providers: {} },
      rag: { enabled: true, rerank: false },
      stt: { provider: 'local', model: 'whisper-1' },
      onboarding: { completed: true }
    };
    const redacted = redactConfig(config);
    assert.strictEqual(redacted.tts.engine, 'kokoro');
    assert.strictEqual(redacted.rag.enabled, true);
    assert.strictEqual(redacted.stt.provider, 'local');
    assert.strictEqual(redacted.onboarding.completed, true);
  });

  it('handles config with no providers', () => {
    const config = {
      llm: { providers: {} },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };
    const redacted = redactConfig(config);
    assert.deepStrictEqual(redacted.llm.providers, {});
  });

  it('handles empty config', () => {
    const config = {};
    const redacted = redactConfig(config);
    assert.ok(redacted);
    assert.ok(redacted.llm);
    assert.deepStrictEqual(redacted.llm.providers, {});
  });

  it('returns deeply cloned object', () => {
    const config = {
      tts: { engine: 'kokoro' },
      llm: { providers: {} },
      rag: {},
      stt: {},
      onboarding: {}
    };
    const redacted = redactConfig(config);
    
    // Modify redacted, ensure original unchanged
    redacted.tts.engine = 'wasm';
    assert.strictEqual(config.tts.engine, 'kokoro');
  });

  it('redacts search.providers API keys without mutating original config', () => {
    const config = {
      tts: {},
      stt: {},
      llm: { providers: {} },
      rag: {},
      onboarding: {},
      search: {
        provider: 'brave',
        max_results: 6,
        providers: {
          brave: { api_key: 'BSA-secret-token' },
          tavily: { api_key: '' },
          searxng: { base_url: 'http://localhost:8080' }
        }
      }
    };
    const redacted = redactConfig(config);

    // Original unchanged
    assert.strictEqual(config.search.providers.brave.api_key, 'BSA-secret-token');

    // Redacted search providers strip api_key and expose has_api_key
    assert.strictEqual(redacted.search.providers.brave.api_key, undefined);
    assert.ok(!('api_key' in redacted.search.providers.brave));
    assert.strictEqual(redacted.search.providers.brave.has_api_key, true);
    assert.strictEqual(redacted.search.providers.tavily.api_key, undefined);
    assert.strictEqual(redacted.search.providers.tavily.has_api_key, false);
    assert.strictEqual(redacted.search.providers.searxng.base_url, 'http://localhost:8080');
    assert.strictEqual(redacted.search.providers.searxng.has_api_key, false);
  });
});

// ── hasApiKey tests ──────────────────────────────────────────────────────────

describe('hasApiKey', () => {
  it('returns true for non-empty api_key', () => {
    const provider = { api_key: 'sk-test', model: '', base_url: '', type: '', default_params: {} };
    assert.strictEqual(hasApiKey(provider), true);
  });

  it('returns false for empty api_key', () => {
    const provider = { api_key: '', model: '', base_url: '', type: '', default_params: {} };
    assert.strictEqual(hasApiKey(provider), false);
  });

  it('returns false for undefined api_key', () => {
    const provider = { model: '', base_url: '', type: '', default_params: {} };
    assert.strictEqual(hasApiKey(provider), false);
  });

  it('returns false for null api_key', () => {
    const provider = { api_key: null, model: '', base_url: '', type: '', default_params: {} };
    assert.strictEqual(hasApiKey(provider), false);
  });

  it('returns true for whitespace api_key', () => {
    const provider = { api_key: '  ', model: '', base_url: '', type: '', default_params: {} };
    assert.strictEqual(hasApiKey(provider), true);
  });
});

// ── countApiKeys tests ───────────────────────────────────────────────────────

describe('countApiKeys', () => {
  it('counts providers with API keys', () => {
    const config = {
      llm: {
        providers: {
          openai: { api_key: 'sk-openai', model: '', base_url: '', type: '', default_params: {} },
          anthropic: { api_key: 'sk-ant', model: '', base_url: '', type: '', default_params: {} },
          lmstudio: { api_key: '', model: '', base_url: '', type: '', default_params: {} },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };
    assert.strictEqual(countApiKeys(config), 2);
  });

  it('returns 0 for empty providers', () => {
    const config = {
      llm: { providers: {} },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };
    assert.strictEqual(countApiKeys(config), 0);
  });

  it('returns 0 for missing llm section', () => {
    const config = {};
    assert.strictEqual(countApiKeys(config), 0);
  });

  it('handles all providers having keys', () => {
    const config = {
      llm: {
        providers: {
          openai: { api_key: 'key1', model: '', base_url: '', type: '', default_params: {} },
          openrouter: { api_key: 'key2', model: '', base_url: '', type: '', default_params: {} },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };
    assert.strictEqual(countApiKeys(config), 2);
  });

  it('handles all providers without keys', () => {
    const config = {
      llm: {
        providers: {
          openai: { api_key: '', model: '', base_url: '', type: '', default_params: {} },
          openrouter: { api_key: '', model: '', base_url: '', type: '', default_params: {} },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };
    assert.strictEqual(countApiKeys(config), 0);
  });
});