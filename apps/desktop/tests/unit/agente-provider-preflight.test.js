import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createProviderPreflight, RuntimeNoModelError } from '../../main/agente/provider-preflight.ts';

const transport = { providerName: 'local', model: 'model.gguf', baseUrl: 'http://127.0.0.1:11435/v1' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const starts = [];
  const deps = {
    localConfig: () => ({ selected_model_path: '/models/model.gguf', runtime_path: '/runtime/server', mmproj_path: '/models/projector.gguf' }),
    status: () => ({ state: 'idle' }),
    pendingLaunch: () => null,
    recommended: async () => ({ backend: 'cpu', context_length: 4096, gpu_layers: 0, use_mmap: true }),
    start: async (config) => { starts.push(config); },
    locale: () => 'en',
    ...overrides
  };
  return { ensure: createProviderPreflight(deps), starts };
}

test('cold local turns wait for the managed Home launch to finish', async () => {
  const ready = deferred();
  const h = harness({ start: () => ready.promise });
  let completed = false;
  const turn = h.ensure(transport).then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  ready.resolve('started');
  await turn;
  assert.equal(completed, true);
});

test('simultaneous cold turns share recommendations and one load', async () => {
  const settings = deferred();
  let probes = 0;
  const h = harness({ recommended: () => { probes++; return settings.promise; } });
  const turns = [h.ensure(transport), h.ensure(transport), h.ensure(transport)];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  settings.resolve({ backend: 'cpu', context_length: 4096, gpu_layers: 0 });
  await Promise.all(turns);
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].model_path, '/models/model.gguf');
  assert.equal(h.starts[0].mmproj_path, '/models/projector.gguf');
  assert.equal(h.starts[0].runtime_path, '/runtime/server');
  assert.equal(h.starts[0].gpu_offload, 0);
  assert.equal(h.starts[0].port, 11435);
});

test('already ready selected model is reused without a new process', async () => {
  const h = harness({ status: () => ({ state: 'ready', model_path: '/models/model.gguf', port: 11435 }) });
  await h.ensure(transport);
  assert.deepEqual(h.starts, []);
});

test('a ready server for another model or port does not bypass loading the selection', async () => {
  for (const status of [
    { state: 'ready', model_path: '/models/other.gguf', port: 11435 },
    { state: 'ready', model_path: '/models/model.gguf', port: 11436 }
  ]) {
    const h = harness({ status: () => status });
    await h.ensure(transport);
    assert.equal(h.starts.length, 1);
  }
});

test('the server uses the configured endpoint port rather than a hardcoded default', async () => {
  const h = harness();
  await h.ensure({ ...transport, baseUrl: 'http://127.0.0.1:12000/v1' });
  assert.equal(h.starts[0].port, 12000);
});

test('Home launch preparation is awaited even before starting status is emitted', async () => {
  const ready = deferred();
  const h = harness({ pendingLaunch: () => ({ config: { model_path: '/models/model.gguf', port: 11435 }, promise: ready.promise }) });
  let completed = false;
  const turn = h.ensure(transport).then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(h.starts, []);
  ready.resolve('started');
  await turn;
});

test('local model id alone is not a configured model file', async () => {
  const h = harness({ localConfig: () => ({ model: 'local-model' }) });
  await assert.rejects(h.ensure(transport), RuntimeNoModelError);
  assert.deepEqual(h.starts, []);
});

test('a model already loaded by Home can be used before its selection is persisted', async () => {
  const h = harness({
    localConfig: () => ({}),
    status: () => ({ state: 'ready', model_path: '/models/model.gguf', port: 11435 })
  });
  await h.ensure(transport);
  assert.deepEqual(h.starts, []);
});

test('a failed Home preparation rejects the turn without launching a replacement', async () => {
  const ready = deferred();
  const h = harness({ pendingLaunch: () => ({ config: { model_path: '/models/model.gguf' }, promise: ready.promise }) });
  const turn = h.ensure(transport);
  ready.reject(new Error('Home load failed'));
  await assert.rejects(turn, /Home load failed/);
  assert.deepEqual(h.starts, []);
});

test('API turns never start a local process; blank API model fails fast', async () => {
  const h = harness();
  await h.ensure({ ...transport, providerName: 'openai', model: 'gpt' });
  await assert.rejects(h.ensure({ ...transport, providerName: 'openai', model: '  ' }), RuntimeNoModelError);
  assert.deepEqual(h.starts, []);
});

test('failed loads reject the turn and allow a later retry', async () => {
  let calls = 0;
  const h = harness({ start: async () => { if (++calls === 1) throw new Error('load failed'); } });
  await assert.rejects(h.ensure(transport), /load failed/);
  await h.ensure(transport);
  assert.equal(calls, 2);
});

test('missing-model error uses the shared localized sentence in all seven languages', async () => {
  for (const locale of ['en', 'es', 'pt-BR', 'zh', 'fr', 'de', 'ja']) {
    const catalog = JSON.parse(readFileSync(new URL(`../../renderer/src/lib/locales/${locale}.json`, import.meta.url), 'utf8'));
    const h = harness({ localConfig: () => ({}), locale: () => locale });
    await assert.rejects(h.ensure(transport), (error) => {
      assert.equal(error.errorKey, 'code.runtimeLocalModelNotRunning');
      assert.equal(error.message, catalog.code.runtimeLocalModelNotRunning);
      return true;
    });
  }
  assert.equal(new RuntimeNoModelError('pt-PT').message, new RuntimeNoModelError('pt-BR').message);
  assert.equal(new RuntimeNoModelError('unknown').message, new RuntimeNoModelError('en').message);
});

test('a returning conversation loads its saved local file rather than the global selection', async () => {
  const h = harness({ status: () => ({ state: 'ready', model_path: '/models/model.gguf', port: 11435 }) });
  await h.ensure({ ...transport, modelPath: '/models/conversation.gguf', model: 'conversation.gguf' });
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].model_path, '/models/conversation.gguf');
});
