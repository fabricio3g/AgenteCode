import { describe, expect, it } from 'vitest';
import {
  mergeLocalSettingsConfig,
  mergePromptSettingsConfig,
  mergeProviderConfig,
  mergeSearchSettingsConfig,
  setBackendModeConfig,
  setLocalModelConfig
} from '$lib/stores/app-store-config';

describe('app-store-config', () => {
  it('merges provider config without dropping existing provider state', () => {
    const next = mergeProviderConfig(
      {
        llm: {
          provider: 'openai',
          providers: {
            openai: { base_url: 'https://api.openai.com', model: 'gpt-4o', api_key: 'old', has_api_key: true, top_p: 0.9 }
          }
        }
      },
      {
        provider: 'openai',
        model: 'gpt-5',
        api_key: '',
        temperature: 0.2
      }
    );

    expect(next.llm?.provider).toBe('openai');
    expect(next.llm?.providers?.openai.model).toBe('gpt-5');
    expect(next.llm?.providers?.openai.api_key).toBeUndefined();
    expect(next.llm?.providers?.openai.has_api_key).toBe(true);
    expect(next.llm?.providers?.openai.top_p).toBe(0.9);
    expect(next.llm?.providers?.openai.temperature).toBe(0.2);
  });

  it('forces local mode defaults when selecting backend and local model', () => {
    const backendConfig = setBackendModeConfig({}, 'local');
    expect(backendConfig.llm?.backend_mode).toBe('local');
    expect(backendConfig.llm?.local?.base_url).toBe('http://127.0.0.1:11435/v1');

    const next = setLocalModelConfig(backendConfig, {
      id: 'llama',
      name: 'Llama 3.1',
      path: 'D:/models/llama.gguf',
      source: 'local'
    });

    expect(next.llm?.backend_mode).toBe('local');
    expect(next.llm?.local?.model).toBe('Llama 3.1');
    expect(next.llm?.local?.selected_model_path).toBe('D:/models/llama.gguf');
  });

  it('merges local, prompt, and search settings predictably', () => {
    const withLocal = mergeLocalSettingsConfig({}, { context_length: 8192, runtime_path: 'D:/llama.cpp' });
    expect(withLocal.llm?.local?.context_length).toBe(8192);
    expect(withLocal.llm?.local?.runtime_path).toBe('D:/llama.cpp');

    const withPrompt = mergePromptSettingsConfig(withLocal, {
      system_prompt: 'Global',
      user_prompt: 'User',
      local_system_prompt: 'Local'
    });
    expect(withPrompt.llm?.system_prompt).toBe('Global');
    expect(withPrompt.llm?.user_prompt).toBe('User');
    expect(withPrompt.llm?.local?.system_prompt).toBe('Local');

    const withSearch = mergeSearchSettingsConfig(withPrompt, {
      provider: 'brave',
      providers: { brave: { api_key: 'abc' } }
    });
    expect(withSearch.search?.provider).toBe('brave');
    expect(withSearch.search?.providers?.brave?.api_key).toBe('abc');
  });
});
