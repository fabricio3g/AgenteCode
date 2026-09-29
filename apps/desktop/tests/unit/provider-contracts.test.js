import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveProvider } from '../../main/providers/registry.ts';
import { buildBody } from '../../main/providers/openai-core.ts';
import { getDialect, resolveDialect } from '../../main/providers/dialects.ts';
import { mapOpenAiFinishReason, classifyError } from '../../main/providers/protocol.ts';

function withFetch(fakeFetch, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(callback)
    .finally(() => { globalThis.fetch = original; });
}

describe('provider endpoint contracts', () => {
  it('maps an upstream "error" finish to the provider message, not jargon', () => {
    // OpenRouter reports an upstream failure as finish_reason "error" on an
    // HTTP-200 stream with the cause in choices[0].error. The card used to
    // read `unknown finish reason "error"`.
    assert.deepEqual(mapOpenAiFinishReason('error', '400: Upstream error from Cohere'), {
      kind: 'error',
      failure: { message: '400: Upstream error from Cohere', code: 'SERVER' }
    });
    assert.deepEqual(mapOpenAiFinishReason('error'), {
      kind: 'error',
      failure: { message: 'The provider reported an error while generating the reply.', code: 'SERVER' }
    });
    assert.deepEqual(mapOpenAiFinishReason('stop'), { kind: 'stop' });
    assert.deepEqual(mapOpenAiFinishReason('tool_calls'), { kind: 'tool-calls' });
  });

  it('keeps the upstream cause of an OpenRouter mid-stream failure, and classifies it as retryable', () => {
    // OpenRouter's generic "JSON error injected into SSE stream" hides the real
    // reason in error.metadata, so a retryable outage looked like an unknown one.
    const failure = classifyError({
      message: 'JSON error injected into SSE stream',
      error: { message: 'JSON error injected into SSE stream', code: 502, metadata: { provider_name: 'Stealth', raw: 'upstream connection reset' } }
    });
    assert.match(failure.message, /Stealth: upstream connection reset/);
    assert.equal(failure.code, 'SERVER');
  });

  it('does not re-file a context overflow as an unknown stream error', () => {
    const failure = classifyError({ message: 'Error code: 400 - context_length_exceeded', status: 400 });
    assert.equal(failure.code, 'CONTEXT_WINDOW_EXCEEDED');
  });

  it('honors explicit SDK providers on local gateways', () => {
    for (const id of ['ollama', 'lmstudio', 'custom']) {
      assert.equal(resolveDialect(id, 'http://localhost:1234/v1').id, id);
    }
    assert.equal(resolveDialect(undefined, 'http://localhost:8080/v1').id, 'local');
    assert.equal(resolveDialect(undefined, 'https://localhost.example.test/v1').id, 'custom');
  });

  it('does not send llama.cpp or unsupported tool_choice fields to Ollama', () => {
    const body = buildBody(getDialect('ollama'), { model: 'qwen3', messages: [], tool_choice: 'auto', reasoning: { level: 'off' } }, true);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.chat_template_kwargs, undefined);
    assert.equal(body.stream_options.include_usage, true);
  });

  it('replays OpenRouter opaque reasoning without leaking internal state to other providers', () => {
    const blocks = [{ type: 'reasoning.encrypted', data: 'opaque==' }];
    const params = { messages: [{ role: 'assistant', content: '', providerState: { provider: 'openrouter', blocks } }] };
    assert.deepEqual(buildBody(getDialect('openrouter'), params, false).messages[0].reasoning_details, blocks);
    const other = buildBody(getDialect('local'), params, false).messages[0];
    assert.equal(other.providerState, undefined);
    assert.equal(other.reasoning_details, undefined);
  });
  it('routes OpenCode Go by name and host, and drops removed providers', () => {
    assert.equal(resolveDialect('opencode-go').id, 'opencode-go');
    assert.equal(resolveDialect(undefined, 'https://opencode.ai/zen/go/v1').id, 'opencode-go');
    assert.equal(getDialect('anthropic'), undefined);
    assert.equal(getDialect('gemini'), undefined);
  });

  it('uses the API root and bearer authentication for local model discovery', async () => {
    await withFetch(async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8080/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer local-secret');
      return { ok: true, json: async () => ({ data: [{ id: 'test-model' }] }) };
    }, async () => {
      const models = await resolveProvider('local', 'http://127.0.0.1:8080/v1/chat/completions')
        .fetchModels('local-secret', 'http://127.0.0.1:8080/v1/chat/completions');
      assert.deepEqual(models, ['test-model']);
    });
  });

  it('normalizes local completion responses and forwards authentication', async () => {
    await withFetch(async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer local-secret');
      const body = JSON.parse(options.body);
      assert.equal(body.stream, false);
      assert.equal(body.model, 'test-model');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        })
      };
    }, async () => {
      const result = await resolveProvider('local', 'http://127.0.0.1:8080/v1').complete({
        apiKey: 'local-secret',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }]
      });
      assert.equal(result.content, 'ok');
      assert.equal(result.usage.total_tokens, 3);
    });
  });

  it('requests and preserves llama.cpp usage-only SSE timing frames', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14},"timings":{"predicted_ms":2000,"predicted_per_second":2}}\n\n',
      'data: [DONE]\n\n'
    ].map((value) => new TextEncoder().encode(value));
    let index = 0;

    await withFetch(async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.stream_options.include_usage, true);
      return {
        ok: true,
        body: {
          getReader() {
            return {
              read: async () => index < chunks.length
                ? { done: false, value: chunks[index++] }
                : { done: true, value: undefined }
            };
          }
        }
      };
    }, async () => {
      const events = [];
      for await (const chunk of resolveProvider('local', 'http://127.0.0.1:8080/v1').stream({
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }]
      })) {
        events.push(chunk);
      }
      const usage = events.find((chunk) => chunk.type === 'usage')?.usage;
      assert.equal(usage.timings.predicted_ms, 2000);
      assert.equal(usage.completion_tokens, 4);
    });
  });
});
