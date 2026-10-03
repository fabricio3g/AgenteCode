import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_LIST_TTL_MS, ModelListCache } from './model-list-cache';

afterEach(() => vi.useRealTimers());

describe('live model snapshots', () => {
  it('shares concurrent loads and expires a successful list', async () => {
    vi.useFakeTimers();
    const cache = new ModelListCache<string[]>();
    const fetcher = vi.fn().mockResolvedValueOnce(['old']).mockResolvedValueOnce(['new']);
    await Promise.all([cache.load('provider', fetcher), cache.load('provider', fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.load('provider', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MODEL_LIST_TTL_MS);
    expect(await cache.load('provider', fetcher)).toEqual(['new']);
  });

  it('forced refresh wins over an older request, including removals and empty lists', async () => {
    const cache = new ModelListCache<string[]>();
    let resolveOld!: (value: string[]) => void;
    const old = cache.load('provider', () => new Promise(resolve => { resolveOld = resolve; }));
    await cache.load('provider', async () => ['new'], true);
    resolveOld(['retired']);
    await old;
    expect(cache.peek('provider')).toEqual(['new']);
    await cache.load('provider', async () => [], true);
    expect(cache.peek('provider')).toEqual([]);
  });

  it('does not cache failures or revive a cleared credential/endpoint snapshot', async () => {
    const cache = new ModelListCache<string[]>();
    await expect(cache.load('a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await cache.load('a', async () => ['recovered'])).toEqual(['recovered']);
    let resolve!: (value: string[]) => void;
    const pending = cache.load('b', () => new Promise(done => { resolve = done; }));
    cache.clear();
    resolve(['old credential']); await pending;
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('a')).toBeUndefined();
  });
});
