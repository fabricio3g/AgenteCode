import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, ModelOption, ReasoningCapabilities } from '$lib/types/chat';
import { ModelDiscoveryController } from './model-discovery.svelte';
import { ThinkingCapabilitiesController } from './thinking-capabilities.svelte';
import { ModelSettingsController } from './model-settings';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const config = (model: string): AppConfig => ({ llm: { backend_mode: 'api', provider: 'openrouter', providers: { openrouter: { model, base_url: 'https://openrouter.ai/api/v1' } } } });
const options = (id: string): ModelOption[] => [{ id, name: id, source: 'api' }];

describe('model discovery ownership', () => {
  it('keeps cached options visible while refreshing and forwards a forced refresh', async () => {
    const pending = deferred<ModelOption[]>(); const cfg = config('one'); const fetch = vi.fn().mockReturnValue(pending.promise);
    const controller = new ModelDiscoveryController({ getConfig: () => cfg, isNative: () => true, cached: () => options('cached'), fetch, loadLocal: vi.fn() });
    const refresh = controller.refresh(true);
    expect(controller.refreshing).toBe(true); expect(controller.models[0].id).toBe('cached'); expect(fetch).toHaveBeenCalledWith(cfg, true);
    pending.resolve(options('fresh')); await refresh; expect(controller.models[0].id).toBe('fresh'); expect(controller.refreshing).toBe(false);
  });
  it('does not let an older request replace the new catalog or clear its loading state', async () => {
    const old = deferred<ModelOption[]>(); const next = deferred<ModelOption[]>(); let cfg = config('one');
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const controller = new ModelDiscoveryController({ getConfig: () => cfg, isNative: () => true, cached: () => undefined, fetch, loadLocal: vi.fn() });
    const first = controller.refresh(); cfg = config('two'); const second = controller.refresh();
    old.resolve(options('old')); await first; expect(controller.models).toEqual([]); expect(controller.refreshing).toBe(true);
    next.resolve(options('new')); await second; expect(controller.models[0].id).toBe('new'); expect(controller.refreshing).toBe(false);
  });
  it('discards a result for a changed route even before another refresh starts', async () => {
    const pending = deferred<ModelOption[]>(); let cfg = config('one');
    const controller = new ModelDiscoveryController({ getConfig: () => cfg, isNative: () => true, cached: () => undefined, fetch: () => pending.promise, loadLocal: vi.fn() });
    const refresh = controller.refresh(); cfg = config('two'); pending.resolve(options('old')); await refresh;
    expect(controller.models).toEqual([]); expect(controller.refreshing).toBe(false);
  });
  it('loads local models through the local port without calling the cloud transport', async () => {
    const fetch = vi.fn(); const local = vi.fn().mockResolvedValue(options('gguf'));
    const controller = new ModelDiscoveryController({ getConfig: () => ({ llm: { backend_mode: 'local' } }), isNative: () => true, cached: vi.fn(), fetch, loadLocal: local });
    await controller.refresh(); expect(local).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect(controller.models[0].id).toBe('gguf');
  });
});

describe('thinking lifecycle ownership', () => {
  const profile: ReasoningCapabilities = { supported: true, levels: ['low', 'high'], source: 'live' };
  it('caches a known route while forced refresh still reaches the provider', async () => {
    const fetch = vi.fn().mockResolvedValue(profile); const controller = new ThinkingCapabilitiesController({ getConfig: () => config('one'), isNative: () => true, fetch });
    await controller.refresh(); await controller.refresh(); expect(fetch).toHaveBeenCalledOnce(); await controller.refresh(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('component disposal invalidates late responses and callbacks', async () => {
    const pending = deferred<ReasoningCapabilities>(); const onResolved = vi.fn();
    const controller = new ThinkingCapabilitiesController({ getConfig: () => config('one'), isNative: () => true, fetch: () => pending.promise, onResolved });
    const refresh = controller.refresh(); controller.cancel(); pending.resolve(profile); await refresh;
    expect(controller.capabilities.source).toBe('unknown'); expect(onResolved).not.toHaveBeenCalled();
  });
  it('retains a known same-route profile after a transient forced-query failure', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(profile).mockRejectedValueOnce(new Error('Offline'));
    const controller = new ThinkingCapabilitiesController({ getConfig: () => config('one'), isNative: () => true, fetch });
    await controller.refresh(); await controller.refresh(true); expect(controller.capabilities.levels).toEqual(profile.levels);
  });
});

describe('model setting commands', () => {
  it('provider edits preserve inactive selection and do not mutate the source configuration', async () => {
    const cfg = config('one'); const commit = vi.fn().mockResolvedValue(undefined); const read = vi.fn(() => cfg);
    const controller = new ModelSettingsController({ getConfig: read, isNative: () => true, commit });
    await controller.updateProvider({ provider: 'deepseek', base_url: 'https://api.deepseek.com', api_key: 'test-key', model: 'model' }, { activate: false });
    const [next, flags] = commit.mock.calls[0]; expect(next.llm.provider).toBe('openrouter'); expect(next.llm.providers.deepseek.model).toBe('model'); expect(cfg.llm?.providers?.deepseek).toBeUndefined(); expect(read).toHaveBeenCalledOnce(); expect(flags.invalidateModels).toBe(true);
  });
  it('generates distinct endpoint ids and removes active entries without removing other providers', async () => {
    let cfg: AppConfig = { ...config('one'), llm: { ...config('one').llm, custom_providers: [{ id: 'custom-test', label: 'Test', base_url: 'https://one.test' }] } };
    const commit = vi.fn(async (next: AppConfig) => { cfg = next; }); const controller = new ModelSettingsController({ getConfig: () => cfg, isNative: () => true, commit });
    expect(await controller.addCustomProvider({ label: 'Test', base_url: ' https://two.test ' })).toBe('custom-test-2');
    expect(cfg.llm?.custom_providers?.at(-1)?.base_url).toBe('https://two.test');
    cfg = { ...cfg, llm: { ...cfg.llm, provider: 'custom-test-2', providers: { ...cfg.llm?.providers, 'custom-test-2': { model: 'x', base_url: 'https://two.test' } } } };
    await controller.removeCustomProvider('custom-test-2'); expect(cfg.llm?.provider).toBe(''); expect(cfg.llm?.providers?.openrouter?.model).toBe('one'); expect(cfg.llm?.providers?.['custom-test-2']).toBeUndefined();
  });
});
