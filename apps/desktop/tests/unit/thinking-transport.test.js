import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
const require = createRequire(import.meta.url);
let root, resolveTransport;
const previousHome = process.env.AGENTE_HOME;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-thinking-route-'));
  process.env.AGENTE_HOME = path.join(root, 'app');
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { isPackaged: false, getPath: name => path.join(root, name) } } };
  const config = await import('../../main/config.ts');
  config.saveConfig({ llm: { backend_mode: 'local', local: { model: 'local-placeholder.gguf', base_url: 'http://127.0.0.1:11435/v1' }, providers: {
    openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'cloud-reasoning-model' },
    deepseek: { base_url: 'https://api.deepseek.com/v1', model: '' }
  } } });
  ({ resolveTransport } = await import('../../main/agente/transport.ts'));
});
after(() => {
  if (previousHome === undefined) delete process.env.AGENTE_HOME; else process.env.AGENTE_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
test('an explicit cloud provider never inherits the active local model', () => {
  const route = resolveTransport('openrouter');
  assert.equal(route.providerName, 'openrouter');
  assert.equal(route.model, 'cloud-reasoning-model');
  assert.equal(route.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(route.modelPath, undefined);
});
test('an unselected cloud model stays unselected rather than becoming a GGUF', () => {
  const route = resolveTransport('deepseek', '');
  assert.equal(route.providerName, 'deepseek'); assert.equal(route.model, '');
  assert.equal(route.modelPath, undefined);
});
test('explicit local and unnamed default routes remain local', () => {
  assert.equal(resolveTransport('local').providerName, 'local');
  assert.equal(resolveTransport('').providerName, 'local');
});
