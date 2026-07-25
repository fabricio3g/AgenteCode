import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLlamaServerBinary, supportsLlamaFlag } from '../../main/llama-runtime.ts';
import { normalizeOpenAiBaseUrl } from '../../main/providers/helpers.ts';
import { buildLlamaArgs } from '../../main/process-manager.ts';

describe('llama.cpp runtime compatibility', () => {
  it('only accepts llama-server as an HTTP runtime', () => {
    assert.equal(isLlamaServerBinary('C:/tools/llama-server.exe'), true);
    assert.equal(isLlamaServerBinary('/opt/llama-server'), true);
    assert.equal(isLlamaServerBinary('/opt/llama-cli'), false);
    assert.equal(isLlamaServerBinary('/opt/server'), false);
  });

  it('normalizes pasted OpenAI chat endpoints to their API root', () => {
    assert.equal(normalizeOpenAiBaseUrl('http://localhost:8080/v1/chat/completions/'), 'http://localhost:8080/v1');
    assert.equal(normalizeOpenAiBaseUrl('http://localhost:8080/v1/'), 'http://localhost:8080/v1');
  });

  it('uses current load-mode flags and skips unsupported flags', () => {
    const capabilities = {
      supportedFlags: new Set([
        '--load-mode', '--spec-type', '--no-webui', '--flash-attn', '--reasoning'
      ])
    };
    const args = buildLlamaArgs({
      model_path: '',
      port: 11435,
      backend_mode: 'cpu',
      context_length: 4096,
      mmap: false,
      keep_in_memory: true,
      speculative_decoding: true,
      speculative_ngram: 64,
      disable_thinking: true
    }, process.execPath, null, capabilities);

    assert.deepEqual(args.slice(args.indexOf('--load-mode'), args.indexOf('--load-mode') + 2), ['--load-mode', 'mlock']);
    assert.equal(args.includes('--mlock'), false);
    assert.equal(args.includes('--no-mmap'), false);
    assert.equal(args.includes('--ngram-cache-size'), false);
    assert.equal(args.includes('--spec-type'), true);
    assert.equal(args.includes('--reasoning'), true);
  });

  it('treats unknown capability data conservatively only when supplied', () => {
    assert.equal(supportsLlamaFlag(null, '--anything'), true);
    assert.equal(supportsLlamaFlag({ supportedFlags: new Set() }, '--anything'), false);
  });
});
