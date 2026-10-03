import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '$lib/types/chat';

const mocks = vi.hoisted(() => ({ config: {} as AppConfig, invoke: vi.fn() }));
vi.mock('$lib/stores/app.svelte', () => ({ appStore: mocks }));
vi.mock('$lib/services/bridge', () => ({ invoke: mocks.invoke, isElectron: () => true, listen: vi.fn(), emit: vi.fn() }));
vi.mock('$lib/utils/providers', () => ({ defaultBaseUrl: (id: string) => `https://${id}.test/v1` }));
import { ProviderModelsStore } from './provider-models.svelte';
import { fetchModels, invalidateModels } from '$lib/services/chat-api';
import { MODEL_LIST_TTL_MS } from '$lib/services/model-list-cache';

beforeEach(() => {
  invalidateModels(); mocks.invoke.mockReset();
  mocks.config = { llm: { provider: 'openrouter', providers: {
    openrouter: { has_api_key: true, model: 'saved', base_url: 'https://openrouter.test/v1' }
  } } };
});
afterEach(() => vi.useRealTimers());

describe('provider picker refresh', () => {
  it('shares the API snapshot with the active chat and refreshes after expiry', async () => {
    vi.useFakeTimers();
    const store = new ProviderModelsStore();
    mocks.invoke.mockResolvedValueOnce(['retired']).mockResolvedValueOnce(['new']);
    await Promise.all([store.load('openrouter'), fetchModels(mocks.config)]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(store.models('openrouter').map(m => m.id)).toEqual(['retired']);
    vi.advanceTimersByTime(MODEL_LIST_TTL_MS);
    await store.load('openrouter');
    expect(store.models('openrouter').map(m => m.id)).toEqual(['new']);
  });

  it('replaces removed models and an empty successful list without changing the selected model', async () => {
    const store = new ProviderModelsStore();
    mocks.invoke.mockResolvedValueOnce(['old', 'retired']).mockResolvedValueOnce(['new']).mockResolvedValueOnce([]);
    await store.load('openrouter'); await store.load('openrouter', true);
    expect(store.models('openrouter').map(m => m.id)).toEqual(['new']);
    await store.load('openrouter', true);
    expect(store.models('openrouter')).toEqual([]);
    expect(mocks.config.llm?.providers?.openrouter.model).toBe('saved');
  });

  it('shows failure and retries instead of marking the saved model as a fetched list', async () => {
    const store = new ProviderModelsStore();
    mocks.invoke.mockRejectedValueOnce(new Error('HTTP 401')).mockResolvedValueOnce(['recovered']);
    await store.load('openrouter');
    expect(store.errors.openrouter).toBeTruthy();
    await store.load('openrouter');
    expect(store.models('openrouter').map(m => m.id)).toEqual(['recovered']);
    expect(store.errors.openrouter).toBe('');
  });

  it('discards a slow response when a provider endpoint changes', async () => {
    const store = new ProviderModelsStore();
    let resolve!: (value: string[]) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(['new endpoint']);
    const old = store.load('openrouter');
    mocks.config.llm!.providers!.openrouter.base_url = 'https://other.test/v1';
    await store.load('openrouter'); resolve(['old endpoint']); await old;
    expect(store.models('openrouter').map(m => m.id)).toEqual(['new endpoint']);
  });
});
