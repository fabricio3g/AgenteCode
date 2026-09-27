import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { testProviderConnection } from '../../main/providers/connection-test.ts';
import { getDialect } from '../../main/providers/dialects.ts';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('testProviderConnection', () => {
  it('lists models on success', async () => {
    const calls = [];
    const result = await testProviderConnection({
      dialect: getDialect('deepseek'), baseUrl: 'https://api.deepseek.com', apiKey: 'k', requireKey: true,
      fetchImpl: async (url, init) => { calls.push([url, init.headers.Authorization]); return json({ data: [{ id: 'b' }, { id: 'a' }] }); }
    });
    assert.deepEqual(result, { ok: true, models: ['a', 'b'] });
    assert.deepEqual(calls, [['https://api.deepseek.com/models', 'Bearer k']]);
  });

  it('names a rejected key, a missing key and an unreachable host', async () => {
    const base = { dialect: getDialect('opencode-go'), baseUrl: 'https://opencode.ai/zen/go/v1', requireKey: true };
    assert.deepEqual(await testProviderConnection({ ...base, apiKey: '' }), { ok: false, reason: 'no_key' });
    assert.deepEqual(
      await testProviderConnection({ ...base, apiKey: 'bad', fetchImpl: async () => json({}, 401) }),
      { ok: false, reason: 'auth', status: 401 }
    );
    const down = await testProviderConnection({ ...base, apiKey: 'k', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
    assert.equal(down.ok, false);
    assert.equal(down.reason, 'unreachable');
  });

  it('checks the key itself where the model list is public (OpenRouter)', async () => {
    const seen = [];
    const result = await testProviderConnection({
      dialect: getDialect('openrouter'), baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'bad', requireKey: true,
      fetchImpl: async (url) => { seen.push(url); return url.endsWith('/key') ? json({}, 401) : json({ data: [] }); }
    });
    assert.deepEqual(result, { ok: false, reason: 'auth', status: 401 });
    assert.deepEqual(seen, ['https://openrouter.ai/api/v1/key']);
  });
});
