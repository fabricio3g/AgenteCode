import { describe, expect, it } from 'vitest';
import { CLOUD_PROVIDERS, configuredProviders, isProviderConfigured, providerLabel } from '$lib/utils/providers';
import type { AppConfig } from '$lib/types/chat';

describe('providers utils', () => {
  it('has cloud and local catalog entries', () => {
    expect(CLOUD_PROVIDERS.some((p) => p.id === 'openai')).toBe(true);
    expect(CLOUD_PROVIDERS.some((p) => p.id === 'ollama')).toBe(true);
    expect(providerLabel('deepseek')).toBe('DeepSeek');
  });

  it('lists providers with has_api_key (redacted config)', () => {
    const config = {
      llm: {
        provider: 'deepseek',
        providers: {
          deepseek: { has_api_key: true, model: 'deepseek-v4-flash', base_url: 'https://api.deepseek.com' },
          openai: { has_api_key: false, model: '', base_url: 'https://api.openai.com/v1' }
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
        provider: 'openai',
        providers: {
          openai: { api_key: '••••••••', model: 'gpt-4o', base_url: 'https://api.openai.com/v1' }
        }
      }
    } as unknown as AppConfig;
    expect(isProviderConfigured(config, 'openai')).toBe(true);
    expect(configuredProviders(config).some((p) => p.id === 'openai')).toBe(true);
  });

  it('always includes active provider when includeActiveAlways', () => {
    const config = {
      llm: {
        provider: 'openai',
        providers: {
          openai: { has_api_key: false, model: '', base_url: 'https://api.openai.com/v1' }
        }
      }
    } as unknown as AppConfig;
    const list = configuredProviders(config, { includeActiveAlways: true });
    expect(list.some((p) => p.id === 'openai' && p.isActive)).toBe(true);
  });

  it('lists only configured providers without forcing empty ones', () => {
    const config = {
      llm: {
        provider: 'openai',
        providers: {
          openai: { has_api_key: true, model: 'gpt-4o', base_url: 'https://api.openai.com/v1' },
          anthropic: { model: 'claude-3-5-sonnet', base_url: 'https://api.anthropic.com/v1' },
          groq: { has_api_key: false, model: '', base_url: 'https://api.groq.com/openai/v1' }
        }
      }
    } as unknown as AppConfig;

    const list = configuredProviders(config, { includeActiveAlways: false });
    expect(list.map((p) => p.id)).toContain('openai');
    expect(list.map((p) => p.id)).toContain('anthropic');
    expect(list.map((p) => p.id)).not.toContain('groq');
  });
});

