import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelTransportConfig, providerTransportPolicy } from '../../main/agente/model-transport.ts';

const transport = {
  ready: true,
  api_format: 'anthropic',
  base_url: 'https://gateway.example/v1/',
  cache_control: false,
  error: null,
};

test('Desktop aliases retain the core model route and explicit cache override', () => {
  assert.deepEqual(modelTransportConfig('https://gateway.example/v1', 'openai', transport), {
    provider: { api_format: 'anthropic' }, options: { cache_control: false },
  });
});

test('an unresolved route fails before configuring a Desktop alias', () => {
  assert.throws(() => modelTransportConfig('https://gateway.example/v1', 'openai', {
    ...transport, ready: false, api_format: null, cache_control: null,
    error: 'Set provider.opencode-go.models.future.provider.api_format',
  }), /provider\.api_format/);
});

test('a separate compatibility endpoint uses its configured protocol', () => {
  assert.deepEqual(modelTransportConfig('https://gateway.example/openai/v1', 'openai', {
    ...transport, error: 'The native route is unresolved',
  }), { provider: { api_format: 'openai' } });
});

test('older runtimes without policy metadata remain compatible', () => {
  assert.deepEqual(modelTransportConfig('http://localhost:11435/v1', 'openai'), {
    provider: { api_format: 'openai' },
  });
});

test('Desktop aliases preserve route maps and disabled session cache keys', () => {
  const policy = { require_model_route: true, model_routes: { future: 'responses' }, cache: { prompt_cache_key: false } };
  assert.deepEqual(providerTransportPolicy('https://gateway.example/v1', { ...transport, policy }), policy);
  assert.equal(providerTransportPolicy('https://gateway.example/openai/v1', { ...transport, policy }), undefined);
});
