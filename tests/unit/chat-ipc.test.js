import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resolveApiKeyFromConfig,
  accumulateToolCallDelta,
  finalizeToolCalls
} from '../../main/chat-ipc.ts';
import { resolveApiKey } from '../../main/chat-ipc.ts';
import { startLlamaSession, endLlamaSession, resolveLlamaSessionKey } from '../../main/llama-session.ts';

describe('chat-ipc local session auth', () => {
  it('resolves the per-launch llama-server key for the live session port', () => {
    // Regression: the local llama-server is launched with a generated
    // --api-key that only main knows. Every request path that talks to it
    // must resolve that key (resolveApiKey), otherwise llama.cpp rejects the
    // generation with 401 "Invalid API Key" even though the model loaded fine.
    const sessionKey = startLlamaSession(11435);
    try {
      assert.strictEqual(
        resolveApiKey('', 'http://127.0.0.1:11435/v1', 'local'),
        sessionKey
      );
    } finally {
      endLlamaSession();
    }
  });

  it('does not leak the session key to other ports or hosts', () => {
    startLlamaSession(11435);
    try {
      assert.strictEqual(resolveLlamaSessionKey('http://127.0.0.1:9999/v1'), '');
      assert.strictEqual(resolveLlamaSessionKey('http://192.168.1.10:11435/v1'), '');
      assert.strictEqual(resolveLlamaSessionKey('not a url'), '');
    } finally {
      endLlamaSession();
    }
  });
});

describe('chat-ipc provider safety', () => {
  it('does not fall back to the default provider key for a different provider', () => {
    const cfg = {
      llm: {
        provider: 'openai',
        providers: {
          openai: { api_key: 'sk-openai', base_url: 'https://api.openai.com/v1' },
          anthropic: { api_key: '', base_url: 'https://api.anthropic.com/v1' }
        }
      }
    };

    const resolved = resolveApiKeyFromConfig(
      cfg,
      '',
      'https://api.anthropic.com/v1',
      'anthropic'
    );

    assert.strictEqual(resolved, '');
  });

  it('can resolve a key by exact base URL match when provider name is absent', () => {
    const cfg = {
      llm: {
        provider: 'openai',
        providers: {
          custom: { api_key: 'sk-custom', base_url: 'https://gateway.example.com/v1/' }
        }
      }
    };

    const resolved = resolveApiKeyFromConfig(
      cfg,
      '',
      'https://gateway.example.com/v1',
      ''
    );

    assert.strictEqual(resolved, 'sk-custom');
  });
});

describe('chat-ipc streamed tool call reconstruction', () => {
  it('merges chunked tool call names without duplicating prefixes', () => {
    const acc = new Map();

    accumulateToolCallDelta(acc, {
      index: 0,
      id: 'call_1',
      name: 'read',
      arguments: '{"path":"'
    }, { appendArguments: true });

    accumulateToolCallDelta(acc, {
      index: 0,
      name: 'read_file',
      arguments: 'src/index.ts"}'
    }, { appendArguments: true });

    const calls = finalizeToolCalls(acc);

    assert.deepStrictEqual(calls, [{
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'src/index.ts' }
    }]);
  });

  it('preserves cumulative json deltas from providers like anthropic', () => {
    const acc = new Map();

    accumulateToolCallDelta(acc, {
      index: 0,
      id: 'toolu_1',
      name: 'write_file',
      arguments: '{"path":"a.txt"'
    }, { appendArguments: false });

    accumulateToolCallDelta(acc, {
      index: 0,
      id: 'toolu_1',
      name: 'write_file',
      arguments: '{"path":"a.txt","content":"hello"}'
    }, { appendArguments: false });

    const calls = finalizeToolCalls(acc);

    assert.deepStrictEqual(calls, [{
      id: 'toolu_1',
      name: 'write_file',
      arguments: { path: 'a.txt', content: 'hello' }
    }]);
  });
});
