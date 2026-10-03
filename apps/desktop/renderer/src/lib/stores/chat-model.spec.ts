import { describe, expect, it } from 'vitest';
import { captureChatModel, configForChatModel, homeRuntimeMatchesModel } from './chat-model';
import { normalizeChat } from './app-store-helpers';
import type { AppConfig } from '$lib/types/chat';

const config: AppConfig = { llm: { backend_mode: 'api', provider: 'custom-a', providers: {
  'custom-a': { model: 'model-a', has_api_key: true, base_url: 'https://a.test/v1' },
  'custom-b': { model: 'model-b', has_api_key: true, base_url: 'https://b.test/v1' }
}, local: { model: 'local-a', selected_model_path: '/models/a.gguf', base_url: 'http://localhost:1234/v1' } } };

describe('conversation model identity', () => {
  it('retains the application backend default before first configuration', () => {
    expect(captureChatModel({}, 'local').backendMode).toBe('local');
    expect(captureChatModel({}, 'api').backendMode).toBe('api');
    expect(captureChatModel(config, 'local').backendMode).toBe('api');
  });

  it('keeps API and local choices per conversation across normalization/restart', () => {
    const a = captureChatModel(config);
    const b = captureChatModel({ llm: { ...config.llm, backend_mode: 'local', provider: 'custom-b', local: { model: 'local-b', selected_model_path: '/models/b.gguf', base_url: 'http://localhost:4321/v1' } } });
    const restoredA = normalizeChat(JSON.parse(JSON.stringify({ id: 'a', modelSelection: a, messages: [] })), 0);
    const restoredB = normalizeChat(JSON.parse(JSON.stringify({ id: 'b', modelSelection: b, messages: [] })), 1);
    const activeB = configForChatModel(config, restoredB.modelSelection);
    expect(activeB.llm?.backend_mode).toBe('local');
    expect(activeB.llm?.local?.model).toBe('local-b');
    const activeA = configForChatModel(activeB, restoredA.modelSelection);
    expect(activeA.llm?.provider).toBe('custom-a');
    expect(activeA.llm?.providers?.['custom-a'].model).toBe('model-a');
    expect(activeA.llm?.local?.model).toBe('local-a');
    expect(activeA.llm?.providers?.['custom-a'].has_api_key).toBe(true);
    expect(config.llm?.local?.model).toBe('local-a');
  });

  it('a captured run keeps its model when another chat switches providers', () => {
    const run = configForChatModel(config, captureChatModel(config));
    configForChatModel(config, { ...captureChatModel(config), provider: 'custom-b', model: 'other' });
    expect(run.llm?.providers?.['custom-a'].model).toBe('model-a');
    expect(captureChatModel(config)).not.toHaveProperty('api_key');
  });

  it('does not resurrect a removed provider or fall back to another model', () => {
    const saved = captureChatModel(config);
    const removed = configForChatModel({ llm: { providers: {} } }, saved);
    expect(removed.llm?.provider).toBe('custom-a');
    expect(removed.llm?.providers?.['custom-a']).toBeUndefined();
  });

  it('uses a runtime context reading only for its selected provider and model', () => {
    const cloud = { provider: 'custom-a', model: 'model-a' };
    const local = { provider: 'local', model: 'local-a' };
    expect(homeRuntimeMatchesModel(cloud, config)).toBe(true);
    expect(homeRuntimeMatchesModel(local, config)).toBe(false);
    const localConfig = configForChatModel(config, { ...captureChatModel(config), backendMode: 'local' });
    expect(homeRuntimeMatchesModel(cloud, localConfig)).toBe(false);
    expect(homeRuntimeMatchesModel(local, localConfig)).toBe(true);
    expect(homeRuntimeMatchesModel({ ...cloud, model: 'other' }, config)).toBe(false);
    expect(homeRuntimeMatchesModel(cloud, configForChatModel(localConfig, captureChatModel(config)))).toBe(true);
  });
});
