// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/services/bridge', async importOriginal => ({ ...await importOriginal<typeof import('$lib/services/bridge')>(), isElectron: () => true }));
vi.mock('$lib/services/chat-api', async importOriginal => ({ ...await importOriginal<typeof import('$lib/services/chat-api')>(), fetchReasoningCapabilities: vi.fn() }));
import { appStore } from './app.svelte';
import { fetchReasoningCapabilities } from '$lib/services/chat-api';
import type { ReasoningCapabilities } from '$lib/types/chat';
const local: ReasoningCapabilities = { supported: true, source: 'template', levels: ['off', 'on'], default: 'on' };
const cloud: ReasoningCapabilities = { supported: true, source: 'live', levels: ['low', 'medium', 'high'], default: 'medium' };
const config = (mode: 'local' | 'api') => ({ llm: { backend_mode: mode, provider: 'openrouter', local: { model: 'placeholder.gguf', selected_model_path: '/tmp/placeholder.gguf' }, providers: { openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'cloud-reasoner' } } } });
function deferred() {
  let resolve!: (value: ReasoningCapabilities) => void;
  const promise = new Promise<ReasoningCapabilities>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); appStore.chats = []; appStore.currentChatId = null; appStore.reasoningLevel = null; appStore.reasoningCapabilities = { supported: false, levels: [], source: 'unknown' }; });
describe('thinking capabilities belong to the active route', () => {
  it('hides local choices immediately while the cloud profile is loading', async () => {
    appStore.config = config('local'); vi.mocked(fetchReasoningCapabilities).mockResolvedValueOnce(local);
    await appStore.refreshReasoningCapabilities(true);
    expect(appStore.reasoningCapabilities.levels).toEqual(['off', 'on']);
    appStore.config = config('api'); const pending = deferred(); vi.mocked(fetchReasoningCapabilities).mockReturnValueOnce(pending.promise);
    const probe = appStore.refreshReasoningCapabilities(true);
    expect(appStore.reasoningCapabilities).toEqual({ supported: false, levels: [], source: 'unknown' });
    expect(fetchReasoningCapabilities).toHaveBeenLastCalledWith({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: undefined, providerName: 'openrouter', model: 'cloud-reasoner' });
    pending.resolve(cloud); await probe;
    expect(appStore.reasoningCapabilities.levels).toEqual(['low', 'medium', 'high']);
  });
  it('ignores a late local result after the user has switched to a cloud provider', async () => {
    const pending = deferred(); appStore.config = config('local'); vi.mocked(fetchReasoningCapabilities).mockReturnValueOnce(pending.promise);
    const old = appStore.refreshReasoningCapabilities(true);
    appStore.config = config('api'); vi.mocked(fetchReasoningCapabilities).mockResolvedValueOnce(cloud);
    await appStore.refreshReasoningCapabilities(true); pending.resolve(local); await old;
    expect(appStore.reasoningCapabilities.levels).toEqual(cloud.levels);
  });
  it('a failed cloud probe does not resurrect local choices', async () => {
    appStore.config = config('local'); vi.mocked(fetchReasoningCapabilities).mockResolvedValueOnce(local);
    await appStore.refreshReasoningCapabilities(true);
    appStore.config = config('api'); vi.mocked(fetchReasoningCapabilities).mockRejectedValueOnce(new Error('Catalog unavailable'));
    await appStore.refreshReasoningCapabilities(true);
    expect(appStore.reasoningCapabilities).toEqual({ supported: false, levels: [], source: 'unknown' });
  });
  it('cannot apply a local result after the config switches before a new probe starts', async () => {
    const pending = deferred(); appStore.config = config('local'); vi.mocked(fetchReasoningCapabilities).mockReturnValueOnce(pending.promise);
    const old = appStore.refreshReasoningCapabilities(true);
    appStore.config = config('api'); pending.resolve(local); await old;
    expect(appStore.reasoningCapabilities.source).toBe('unknown');
  });

});
