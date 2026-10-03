import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from '../../main/providers/registry.ts';
import { APP_USER_AGENT } from '../../shared/brand.ts';

async function fixture(run) {
  const requests = [];
  let response = { status: 200, body: { data: [{ id: 'old' }] } };
  const server = createServer((request, reply) => {
    requests.push({ url: request.url, headers: request.headers });
    reply.writeHead(response.status, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify(typeof response.body === 'function' ? response.body(request.url) : response.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/v1`, requests, value => { response = value; }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

describe('live model endpoint refresh', () => {
  for (const id of ['opencode-go', 'openrouter']) {
    it(`${id} reads current API membership with Agente headers on each fetch`, async () => {
      await fixture(async (base, requests, setResponse) => {
        const provider = resolveProvider(id, base);
        assert.deepEqual(await provider.fetchModels('fixture-key', base), ['old']);
        setResponse({ status: 200, body: { data: [{ id: 'new' }, { id: 'new' }] } });
        assert.deepEqual(await provider.fetchModels('fixture-key', base), ['new']);
        setResponse({ status: 200, body: { data: [] } });
        assert.deepEqual(await provider.fetchModels('fixture-key', base), []);
        assert.equal(requests.length, 3);
        for (const request of requests) {
          assert.equal(request.url, '/v1/models');
          assert.equal(request.headers.authorization, 'Bearer fixture-key');
          assert.equal(request.headers['user-agent'], APP_USER_AGENT);
          assert.equal(request.headers['cache-control'], 'no-cache');
          if (id === 'opencode-go') assert.ok(request.headers['x-opencode-session']);
        }
      });
    });
  }

  it('rejects API errors and malformed lists instead of silently returning an empty catalog', async () => {
    await fixture(async (base, _requests, setResponse) => {
      const provider = resolveProvider('openrouter', base);
      setResponse({ status: 401, body: { error: 'invalid credentials' } });
      await assert.rejects(provider.fetchModels('fixture-key', base), /HTTP 401/);
      setResponse({ status: 200, body: { error: 'no list' } });
      await assert.rejects(provider.fetchModels('fixture-key', base), /Invalid provider model list/);
    });
  });

  it('reads every page and rejects a repeated cursor', async () => {
    await fixture(async (base, requests, setResponse) => {
      const provider = resolveProvider('custom', base);
      setResponse({ status: 200, body: url => url.includes('after_id=one')
        ? { data: [{ id: 'two' }] } : { data: [{ id: 'one' }], has_more: true, last_id: 'one' } });
      assert.deepEqual(await provider.fetchModels('', base), ['one', 'two']);
      assert.equal(requests[1].url, '/v1/models?after_id=one');
      setResponse({ status: 200, body: { data: [{ id: 'one' }], has_more: true, last_id: 'one' } });
      await assert.rejects(provider.fetchModels('', base), /pagination/);
    });
  });
});
