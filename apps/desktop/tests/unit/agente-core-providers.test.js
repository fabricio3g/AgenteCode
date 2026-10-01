import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-core-auth-'));
process.env.AGENTE_CONFIG_DIR = dir;
const { coreAuthPath, coreKey, flagCoreKeys } = await import('../../main/agente/core-providers.ts');

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
    flagCoreKeys(providers);
    assert.deepEqual(providers.deepseek, { model: 'deepseek-chat', has_api_key: true });
    assert.deepEqual(providers.minimax, { has_api_key: true });
    assert.equal(providers.custom.has_api_key, false);
  });

  it('treats a missing or broken store as empty', () => {
    fs.writeFileSync(path.join(dir, 'auth.json'), '{ nope');
    fs.utimesSync(path.join(dir, 'auth.json'), new Date(1), new Date(1));
    assert.equal(coreKey('deepseek'), '');
    fs.rmSync(path.join(dir, 'auth.json'));
    assert.equal(coreKey('deepseek'), '');
  });
});
