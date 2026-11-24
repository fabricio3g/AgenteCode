import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetWebSearchSync, syncWebSearchToCore, webSyncPayload } from '../../main/agente/core-web.ts';

describe('core web search sync', () => {
  it('sends the choice, the keyed providers and the SearXNG URL', () => {
    assert.deepEqual(webSyncPayload({
      provider: 'brave',
      providers: {
        brave: { api_key: ' b-key ' },
        tavily: { api_key: '' },
        exa: { api_key: 'e-key' },
        jina: { api_key: 'not for the core' },
        searxng: { base_url: 'https://search.example/' },
      },
    }), {
      provider: 'brave',
      searxng_url: 'https://search.example/',
      keys: { brave: 'b-key', exa: 'e-key' },
    });
    assert.deepEqual(webSyncPayload(undefined), { provider: 'auto', keys: {} });
  });

  it('connects only when the settings changed since the last sync', async () => {
    const sent = [];
    let connects = 0;
    const connect = async () => {
      connects += 1;
      return { request: async (method, params) => { sent.push([method, params]); return {}; } };
    };
    const search = { provider: 'tavily', providers: { tavily: { api_key: 't' } } };
    await syncWebSearchToCore(connect, search);
    await syncWebSearchToCore(connect, search);
    assert.equal(connects, 1);
    assert.deepEqual(sent, [['web.sync', { provider: 'tavily', keys: { tavily: 't' } }]]);
    await syncWebSearchToCore(connect, { ...search, provider: 'auto' });
    assert.equal(connects, 2);
  });

  it('leaves a core without web.sync alone and retries a failed sync', async () => {
    const { AgenteRpcError } = await import('../../main/agente-client.ts');
    const missing = async () => ({ request: async () => { throw new AgenteRpcError(-32601, 'nope'); } });
    await syncWebSearchToCore(missing, { provider: 'exa-old-core' });
    const failing = async () => ({ request: async () => { throw new Error('down'); } });
    await assert.rejects(syncWebSearchToCore(failing, { provider: 'retry-me' }));
    let calls = 0;
    await syncWebSearchToCore(async () => ({ request: async () => { calls += 1; } }), { provider: 'retry-me' });
    assert.equal(calls, 1, 'a failed payload is sent again');
  });

  it('resets dedupe cache on daemon close and prevents out-of-order saves from clobbering lastSynced', async () => {
    resetWebSearchSync();
    const sent = [];
    const send = async () => ({
      request: async (_method, params) => { sent.push(params.provider); return {}; }
    });

    await syncWebSearchToCore(send, { provider: 'brave' });
    await syncWebSearchToCore(send, { provider: 'brave' });
    assert.deepEqual(sent, ['brave']);

    resetWebSearchSync();
    await syncWebSearchToCore(send, { provider: 'brave' });
    assert.deepEqual(sent, ['brave', 'brave'], 'reset forces resync after disconnect');

    // Out-of-order completion: save A starts first and hangs, save B completes first, then save A resolves.
    resetWebSearchSync();
    sent.length = 0;
    let releaseA;
    const first = syncWebSearchToCore(async () => ({
      request: async (_method, params) => {
        sent.push(params.provider);
        await new Promise((resolve) => { releaseA = resolve; });
        return {};
      }
    }), { provider: 'first-a' });
    // Yield so `first` reaches request()
    await new Promise((resolve) => setTimeout(resolve, 0));
    await syncWebSearchToCore(send, { provider: 'second-b' });
    releaseA();
    await first;

    // `second-b` must remain the deduped signature, not stale `first-a`.
    await syncWebSearchToCore(send, { provider: 'second-b' });
    assert.deepEqual(sent, ['first-a', 'second-b']);
    await syncWebSearchToCore(send, { provider: 'first-a' });
    assert.deepEqual(sent, ['first-a', 'second-b', 'first-a']);

    // A reset while a sync is in flight prevents the stale completion from caching.
    resetWebSearchSync();
    sent.length = 0;
    let releaseInflight;
    const inflight = syncWebSearchToCore(async () => ({
      request: async (_method, params) => {
        sent.push(params.provider);
        await new Promise((resolve) => { releaseInflight = resolve; });
        return {};
      }
    }), { provider: 'during-close' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetWebSearchSync();
    releaseInflight();
    await inflight;
    await syncWebSearchToCore(send, { provider: 'during-close' });
    assert.deepEqual(sent, ['during-close', 'during-close']);
  });
});
