import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GeminiProvider } from '../../main/providers/gemini.ts';
import { LocalProvider } from '../../main/providers/local.ts';

function withFetch(fakeFetch, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(callback)
    .finally(() => { globalThis.fetch = original; });
}

describe('provider endpoint contracts', () => {
  it('uses the API root and bearer authentication for local model discovery', async () => {
    await withFetch(async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8080/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer local-secret');
      return { ok: true, json: async () => ({ data: [{ id: 'test-model' }] }) };
    }, async () => {
      const models = await new LocalProvider().fetchModels(
        'local-secret',
        'http://127.0.0.1:8080/v1/chat/completions'
      );
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
      const result = await new LocalProvider().completeChat({
        apiKey: 'local-secret',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }]
      });
      assert.equal(result.content, 'ok');
      assert.equal(result.usage.total_tokens, 3);
    });
  });

  it('uses a configured Gemini endpoint for model discovery', async () => {
    await withFetch(async (url) => {
      assert.equal(url, 'https://gemini.example.test/v1beta/models?key=test-key');
      return {
        ok: true,
        json: async () => ({
          models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }]
        })
      };
    }, async () => {
      const models = await new GeminiProvider().fetchModels('test-key', 'https://gemini.example.test');
      assert.deepEqual(models, ['gemini-test']);
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
      for await (const event of new LocalProvider().streamChat({
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }]
      })) {
        events.push(event);
      }
      const usage = events.find((event) => event.usage)?.usage;
      assert.equal(usage.timings.predicted_ms, 2000);
      assert.equal(usage.completion_tokens, 4);
    });
  });
});
