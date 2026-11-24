import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-core-auth-'));
process.env.AGENTE_CONFIG_DIR = dir;
const { coreAuthPath, coreKey, flagCoreKeys, syncProvidersToCore } = await import('../../main/agente/core-providers.ts');

function writeAuth(entries) {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ entries }));
  // A new mtime, even within the same millisecond as the last write.
  const later = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(path.join(dir, 'auth.json'), later, later);
}

describe('the core key store, read from Desktop', () => {
  it('lives where the core keeps auth.json', () => {
    assert.equal(coreAuthPath(), path.join(dir, 'auth.json'));
  });

  it('reads API keys and OAuth tokens and follows later writes', () => {
    writeAuth({ deepseek: { type: 'api', key: 'sk-one' }, openrouter: { type: 'oauth', token: 'tok' }, empty: { type: 'api', key: '' } });
    assert.equal(coreKey('deepseek'), 'sk-one');
    assert.equal(coreKey('openrouter'), 'tok');
    assert.equal(coreKey('empty'), '');
    assert.equal(coreKey(undefined), '');
    writeAuth({ deepseek: { type: 'api', key: 'sk-two' } });
    assert.equal(coreKey('deepseek'), 'sk-two');
    assert.equal(coreKey('openrouter'), '');
  });

  it('flags providers the core holds a key for, keeping their settings', () => {
    writeAuth({ deepseek: { type: 'api', key: 'sk' }, minimax: { type: 'api', key: 'mm' } });
    const providers = { deepseek: { model: 'deepseek-chat', has_api_key: false }, custom: { has_api_key: false } };
    flagCoreKeys(providers, {});
    assert.deepEqual(providers.deepseek, { model: 'deepseek-chat', has_api_key: true });
    assert.deepEqual(providers.minimax, { has_api_key: true });
    assert.equal(providers.custom.has_api_key, false);
  });

  it('flags providers configured via environment variables', () => {
    writeAuth({});
    const providers = {};
    flagCoreKeys(providers, { OPENROUTER_API_KEY: 'sk-or-env', ZAI_API_KEY: 'sk-glm-env' });
    assert.equal(providers.openrouter?.has_api_key, true);
    assert.equal(providers.glm?.has_api_key, true);
    assert.equal(providers.deepseek, undefined);
  });

  it('excludes namespaced web:* keys from coreKey and flagCoreKeys', () => {
    writeAuth({
      deepseek: { type: 'api', key: 'sk-llm' },
      'web:brave': { type: 'api', key: 'sk-brave' },
      'web:tavily': { type: 'api', key: 'sk-tavily' },
      'web:exa': { type: 'api', key: 'sk-exa' }
    });
    assert.equal(coreKey('deepseek'), 'sk-llm');
    assert.equal(coreKey('web:brave'), '');
    assert.equal(coreKey('web:tavily'), '');
    assert.equal(coreKey('web:exa'), '');
    const providers = { deepseek: { has_api_key: false } };
    flagCoreKeys(providers, {});
    assert.deepEqual(Object.keys(providers), ['deepseek']);
    assert.equal(providers.deepseek.has_api_key, true);
  });

  it('syncs keys, base_url changes, disconnects, and default provider/model to the core', async () => {
    const calls = [];
    const forgotten = [];
    const client = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'providers.status') {
          return {
            providers: [
              { id: 'openrouter', connected: true, stored_key: true, base_url: null },
              { id: 'deepseek', connected: true, stored_key: true, base_url: null },
              { id: 'ollama', connected: true, stored_key: false, base_url: 'http://localhost:11434/v1' }
            ],
            default_provider: 'openrouter',
            default_model: 'old-model'
          };
        }
        return {};
      }
    };

    const nextLlm = {
      provider: 'deepseek',
      providers: {
        openrouter: { has_api_key: false, base_url: 'https://openrouter.ai/api/v1' },
        deepseek: { api_key: 'sk-new', model: 'deepseek-chat', base_url: 'https://api.deepseek.com' },
        ollama: { base_url: 'http://192.168.1.50:11434/v1' }
      }
    };
    const prevLlm = {
      provider: 'openrouter',
      providers: {
        openrouter: { base_url: 'https://openrouter.ai/api/v1' },
        deepseek: { base_url: 'https://api.deepseek.com' },
        ollama: { base_url: 'http://localhost:11434/v1' }
      }
    };

    await syncProvidersToCore(async () => client, nextLlm, prevLlm, (id) => forgotten.push(id));

    assert.equal(nextLlm.providers.deepseek.api_key, undefined);
    assert.deepEqual(forgotten, ['openrouter', 'deepseek']);
    assert.deepEqual(calls.slice(1), [
      { method: 'providers.disconnect', params: { id: 'openrouter' } },
      { method: 'providers.connect', params: { id: 'deepseek', api_key: 'sk-new' } },
      { method: 'providers.connect', params: { id: 'ollama', base_url: 'http://192.168.1.50:11434/v1' } },
      { method: 'providers.set_default', params: { provider: 'deepseek', model: 'deepseek-chat' } }
    ]);
  });

  it('treats a missing or broken store as empty', () => {
    fs.writeFileSync(path.join(dir, 'auth.json'), '{ nope');
    fs.utimesSync(path.join(dir, 'auth.json'), new Date(1), new Date(1));
    assert.equal(coreKey('deepseek'), '');
    fs.rmSync(path.join(dir, 'auth.json'));
    assert.equal(coreKey('deepseek'), '');
  });
});
