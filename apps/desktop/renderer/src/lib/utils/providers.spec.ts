import { describe, expect, it } from 'vitest';
import { CLOUD_PROVIDERS, configuredProviders, isProviderConfigured, providerLabel } from '$lib/utils/providers';
import type { AppConfig } from '$lib/types/chat';

describe('providers utils', () => {
  it('has cloud and local catalog entries', () => {
    expect(CLOUD_PROVIDERS.some((p) => p.id === 'opencode-go')).toBe(true);
    for (const removed of ['openai', 'anthropic', 'gemini', 'groq', 'mistral']) {
      expect(CLOUD_PROVIDERS.some((p) => p.id === removed)).toBe(false);
    }
    expect(CLOUD_PROVIDERS.some((p) => p.id === 'ollama')).toBe(true);
    expect(providerLabel('deepseek')).toBe('DeepSeek');
  });

  it('lists providers with has_api_key (redacted config)', () => {
    const config = {
      llm: {
        provider: 'deepseek',
        providers: {
          deepseek: { has_api_key: true, model: 'deepseek-v4-flash', base_url: 'https://api.deepseek.com' },
          openrouter: { has_api_key: false, model: '', base_url: 'https://openrouter.ai/api/v1' }
        }
      }
    } as unknown as AppConfig;

    const list = configuredProviders(config);
    expect(list.map((p) => p.id)).toContain('deepseek');
    expect(list.find((p) => p.id === 'deepseek')?.hasKey).toBe(true);
    expect(list.find((p) => p.id === 'deepseek')?.isActive).toBe(true);
  });

  it('treats placeholder bullet keys as configured', () => {
    const config = {
      llm: {
        provider: 'openrouter',
        providers: {
          openrouter: { api_key: '••••••••', model: 'deepseek/deepseek-v4-flash', base_url: 'https://openrouter.ai/api/v1' }
        }
      }
    } as unknown as AppConfig;
    expect(isProviderConfigured(config, 'openrouter')).toBe(true);
    expect(configuredProviders(config).some((p) => p.id === 'openrouter')).toBe(true);
  });

  it('always includes active provider when includeActiveAlways', () => {
    const config = {
      llm: {
        provider: 'openrouter',
        providers: {
          openrouter: { has_api_key: false, model: '', base_url: 'https://openrouter.ai/api/v1' }
        }
      }
    } as unknown as AppConfig;
    const list = configuredProviders(config, { includeActiveAlways: true });
    expect(list.some((p) => p.id === 'openrouter' && p.isActive)).toBe(true);
  });

  it('lists only configured providers without forcing empty ones', () => {
    const config = {
      llm: {
        provider: 'openrouter',
        providers: {
          openrouter: { has_api_key: true, model: 'deepseek/deepseek-v4-flash', base_url: 'https://openrouter.ai/api/v1' },
          anthropic: { model: 'claude-3-5-sonnet', base_url: 'https://api.anthropic.com/v1' },
          groq: { has_api_key: false, model: '', base_url: 'https://api.groq.com' }
        }
      }
    } as unknown as AppConfig;

    const list = configuredProviders(config, { includeActiveAlways: false });
    expect(list.map((p) => p.id)).toContain('openrouter');
    expect(list.map((p) => p.id)).toContain('anthropic');
    expect(list.map((p) => p.id)).not.toContain('groq');
  });
});

