import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDeveloperConsoleEntry,
  developerModelMatchesSearch,
  parseDeveloperApiInfo,
  replaceDeveloperApiHost
} from '../../renderer/src/lib/utils/developer-mode.ts';

describe('developer mode helpers', () => {
  it('searches by model name, architecture, and quantization', () => {
    const model = {
      id: 'mistral-nemo',
      name: 'Mistral-Nemo-Instruct.gguf',
      architecture: 'llama',
      quantization_name: 'Q5_K_M',
      size_label: '8.2 GB',
      details: ''
    };

    assert.equal(developerModelMatchesSearch(model, 'nemo'), true);
    assert.equal(developerModelMatchesSearch(model, 'q5_k'), true);
    assert.equal(developerModelMatchesSearch(model, 'qwen'), false);
  });

  it('parses API host, port, root, and LAN display URL', () => {
    const local = parseDeveloperApiInfo('http://127.0.0.1:11435/v1');
    assert.equal(local.host, '127.0.0.1');
    assert.equal(local.port, 11435);
    assert.equal(local.apiRoot, 'http://127.0.0.1:11435/v1');
    assert.equal(local.clientApiRoot, 'http://127.0.0.1:11435/v1');
    assert.equal(local.shareableBaseUrl, 'http://127.0.0.1:11435/v1');

    const shared = parseDeveloperApiInfo('http://0.0.0.0:11435/v1');
    assert.equal(shared.host, '0.0.0.0');
    assert.equal(shared.apiRoot, 'http://0.0.0.0:11435/v1');
    assert.equal(shared.clientApiRoot, 'http://127.0.0.1:11435/v1');
    assert.equal(shared.shareableBaseUrl, 'http://<your-lan-ip>:11435/v1');
  });

  it('switches only the API host while preserving port and path', () => {
    assert.equal(
      replaceDeveloperApiHost('http://127.0.0.1:11435/v1', '0.0.0.0'),
      'http://0.0.0.0:11435/v1'
    );
    assert.equal(
      replaceDeveloperApiHost('http://0.0.0.0:11435/v1', '127.0.0.1'),
      'http://127.0.0.1:11435/v1'
    );
  });

  it('formats console entries with request and response payloads', () => {
    const entry = createDeveloperConsoleEntry({
      method: 'post',
      path: '/v1/chat/completions',
      request: { model: 'test-model' },
      response: { id: 'chatcmpl-test' },
      startedAt: 100,
      endedAt: 136
    });

    assert.equal(entry.method, 'POST');
    assert.equal(entry.status, 200);
    assert.equal(entry.timingMs, 36);
    assert.match(entry.request, /test-model/);
    assert.match(entry.response, /chatcmpl-test/);
  });
});
