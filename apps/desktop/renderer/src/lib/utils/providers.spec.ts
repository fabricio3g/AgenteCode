import { describe, expect, it } from 'vitest';
import { cloudProviders, configuredProviders, defaultBaseUrl, isProviderConfigured, providerLabel } from '$lib/utils/providers';
import { metaFromSpec, providerDirectory } from '$lib/utils/provider-directory.svelte';
import type { AppConfig } from '$lib/types/chat';

describe('providers utils', () => {
  it('builds the directory from the core specs', () => {
    // As `providers.list` sends them (crates/agente-core/providers/*.toml).
    const specs = [
      { id: 'opencode-go', name: 'OpenCode Go', group: 'cloud', base_url: 'https://opencode.ai/zen/go/v1', api_format: 'openai', key_url: 'https://opencode.ai/auth' },
      { id: 'minimax', name: 'MiniMax', group: 'cloud', base_url: 'https://api.minimax.io/anthropic/v1', api_format: 'anthropic', openai_compatible_url: 'https://api.minimax.io/v1' },
      { id: 'deepseek', name: 'DeepSeek', group: 'cloud', base_url: 'https://api.deepseek.com', api_format: 'anthropic' },
      { id: 'ollama', name: 'Ollama (local)', group: 'local', base_url: 'http://localhost:11434/v1', api_format: 'openai' },
      { id: 'llamacpp', name: 'llama.cpp (local)', group: 'local', base_url: 'http://127.0.0.1:8080/v1', api_format: 'openai' },
      { id: 'custom', name: 'Custom / Other', group: 'local', base_url: 'http://127.0.0.1:8080/v1', api_format: 'openai' }
    ] as const;
    providerDirectory.providers = specs.map((s) => metaFromSpec({ ...s })).filter((m) => m !== null);

    const ids = cloudProviders().map((p) => p.id);
    // llama.cpp has its own section; an endpoint Desktop cannot speak to is left out.
    expect(ids).toEqual(['opencode-go', 'minimax', 'ollama', 'custom']);
    expect(providerLabel('ollama')).toBe('Ollama');
    expect(providerLabel('opencode-go')).toBe('OpenCode Go');
    // Desktop talks OpenAI chat, so an Anthropic-format spec uses its OpenAI endpoint.
    expect(defaultBaseUrl('minimax')).toBe('https://api.minimax.io/v1');
    expect(cloudProviders().find((p) => p.id === 'opencode-go')?.keyUrl).toBe('https://opencode.ai/auth');
    expect(cloudProviders().find((p) => p.id === 'custom')?.defaultBaseUrl).toBe('');
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

