import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { syncWebSearchToCore, webSyncPayload } from '../../main/agente/core-web.ts';

describe('core web search sync', () => {
  it('sends the choice, the keyed providers and the SearXNG URL', () => {
    assert.deepEqual(webSyncPayload({
      provider: 'brave',
      max_results: 8,
      providers: {
        brave: { api_key: ' b-key ' },
        tavily: { api_key: '' },
        exa: { api_key: 'e-key' },
        jina: { api_key: 'not for the core' },
        searxng: { base_url: 'https://search.example/' },
      },
    }), {
      provider: 'brave',
      max_results: 8,
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
});
