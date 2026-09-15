import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveProvider } from '../../main/providers/registry.ts';
import { geminiProvider } from '../../main/providers/gemini.ts';
import { buildContents } from '../../main/providers/gemini.ts';
import { buildMessages, anthropicProvider } from '../../main/providers/anthropic.ts';
import { buildBody, buildMistralRequest } from '../../main/providers/openai-core.ts';
import { getDialect, resolveDialect } from '../../main/providers/dialects.ts';
import { mapOpenAiFinishReason } from '../../main/providers/protocol.ts';

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

  it('honors explicit SDK providers on local gateways', () => {
    for (const id of ['ollama', 'lmstudio', 'anthropic', 'gemini', 'custom']) {
      assert.equal(resolveDialect(id, 'http://localhost:1234/v1').id, id);
    }
    assert.equal(resolveDialect(undefined, 'http://localhost:8080/v1').id, 'local');
    assert.equal(resolveDialect(undefined, 'https://localhost.example.test/v1').id, 'custom');
  });

  it('uses Cohere compatibility URL and only its supported efforts', () => {
    const dialect = getDialect('cohere');
    assert.equal(dialect.normalizeBaseUrl('https://api.cohere.ai/v1'), 'https://api.cohere.ai/compatibility/v1');
    assert.equal(dialect.normalizeBaseUrl('https://proxy.test/v1'), 'https://proxy.test/v1');
    assert.deepEqual(dialect.reasoningBody('medium'), { reasoning_effort: 'high' });
    assert.deepEqual(dialect.reasoningBody('none'), { reasoning_effort: 'none' });
  });

  it('does not send llama.cpp or unsupported tool_choice fields to Ollama', () => {
    const body = buildBody(getDialect('ollama'), { model: 'qwen3', messages: [], tool_choice: 'auto', reasoning: { level: 'off' } }, true);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.chat_template_kwargs, undefined);
    assert.equal(body.stream_options.include_usage, true);
  });

  it('preserves Mistral system instructions and paired tool history in SDK casing', () => {
    const body = buildMistralRequest(getDialect('mistral'), { messages: [
      { role: 'system', content: 'Use tools' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'abc123456', type: 'function', function: { name: 'calculator', arguments: '{}' } }] },
      { role: 'tool', name: 'calculator', tool_call_id: 'abc123456', content: '4' }
    ], tool_choice: 'required' }, false);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].toolCalls[0].id, body.messages[2].toolCallId);
    assert.equal(body.messages[2].name, 'calculator');
    assert.equal(body.toolChoice, 'any');
  });

  it('decodes actual Mistral SDK stream fields and encodes a follow-up tool result', async () => {
    let requests = 0;
    // The Mistral SDK v2 calls fetch with a single Request object (not
    // fetch(url, options)) and maps camelCase SDK fields to snake_case wire
    // fields itself — the mock has to speak that convention.
    await withFetch(async (input, init) => {
      const rawBody = input instanceof Request ? await input.text() : String(init?.body || '');
      const body = JSON.parse(rawBody);
      if (requests++ === 0) {
        const frame = { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'mistral-small-latest',
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'abc123456', type: 'function', function: { name: 'calculator', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } };
        return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].tool_calls[0].id, 'abc123456');
      assert.equal(body.messages[2].tool_call_id, 'abc123456');
      return Response.json({ id: 'answer', object: 'chat.completion', created: 1, model: 'mistral-small-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } });
    }, async () => {
      const provider = resolveProvider('mistral');
      const params = { apiKey: 'mistral-contract-test', model: 'mistral-small-latest', baseUrl: 'https://mistral.example.test', messages: [{ role: 'user', content: 'Calculate' }] };
      const events = [];
      for await (const event of provider.stream(params)) events.push(event);
      assert.equal(events.find(e => e.type === 'tool-call-delta')?.delta.name, 'calculator');
      assert.equal(events.find(e => e.type === 'usage')?.usage.output_tokens, 3);
      assert.equal(events.find(e => e.type === 'finish')?.reason.kind, 'tool-calls');
      const answer = await provider.complete({ ...params, messages: [
        { role: 'system', content: 'Use tools' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'abc123456', type: 'function', function: { name: 'calculator', arguments: '{}' } }] },
        { role: 'tool', name: 'calculator', tool_call_id: 'abc123456', content: '4' }
      ] });
      assert.equal(answer.content, '4');
      assert.equal(answer.finishReason.kind, 'stop');
    });
  });

  it('captures streamed Claude signatures and no-argument tool calls', async () => {
    const frames = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque==' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'lookup', name: 'clock', input: {} } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: 'message_stop' }
    ];
    await withFetch(async () => new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }), async () => {
      const events = [];
      for await (const event of anthropicProvider.stream({ apiKey: 'claude-contract-test', model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Time?' }] })) events.push(event);
      assert.equal(events.find(e => e.type === 'tool-call-delta')?.delta.name, 'clock');
      assert.deepEqual(events.find(e => e.type === 'provider-state')?.state.blocks, [{ type: 'thinking', thinking: 'Plan.', signature: 'opaque==' }]);
      assert.equal(events.find(e => e.type === 'usage')?.usage.total_tokens, 15);
    });
  });

  it('replays Gemini signed parts verbatim and groups parallel function responses', () => {
    const blocks = [{ thought: true, text: 'Plan', thoughtSignature: 'opaque==' },
      { functionCall: { id: 'a', name: 'lookup', args: {} }, thoughtSignature: 'signed==' },
      { functionCall: { id: 'b', name: 'lookup', args: {} } }];
    const result = buildContents([
      { role: 'assistant', content: null, providerState: { provider: 'gemini', blocks } },
      { role: 'tool', name: 'lookup', tool_call_id: 'a', content: '{"answer":4}' },
      { role: 'tool', name: 'lookup', tool_call_id: 'b', content: 'plain text' }
    ]);
    assert.deepEqual(result.contents[0], { role: 'model', parts: blocks });
    assert.equal(result.contents[1].parts.length, 2);
    assert.deepEqual(result.contents[1].parts[0].functionResponse.response, { result: { answer: 4 } });
    assert.equal(result.contents[1].parts[1].functionResponse.id, 'b');
  });

  it('preserves Claude signed thinking and parallel tool-result adjacency', () => {
    const blocks = [{ type: 'thinking', thinking: 'Plan', signature: 'opaque==' }];
    const result = buildMessages([
      { role: 'assistant', content: '', providerState: { provider: 'anthropic', blocks }, tool_calls: ['a', 'b'].map(id => ({ id, function: { name: 'lookup', arguments: '{}' } })) },
      { role: 'tool', tool_call_id: 'a', content: 'first' },
      { role: 'tool', tool_call_id: 'b', content: 'second' }
    ]);
    assert.deepEqual(result.messages[0].content[0], blocks[0]);
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages[1].content.map(b => b.tool_use_id), ['a', 'b']);
  });

  it('only exposes Gemini Pro reasoning levels that the model accepts', async () => {
    assert.deepEqual((await geminiProvider.getReasoningCapabilities('', '', 'gemini-3-pro-preview')).levels, ['low', 'high']);
    assert.equal((await geminiProvider.getReasoningCapabilities('', '', 'gemini-2.5-pro')).levels.includes('off'), false);
    assert.deepEqual((await anthropicProvider.getReasoningCapabilities('', '', 'claude-sonnet-4-5')).levels, ['off', 'enabled']);
  });

  it('replays OpenRouter opaque reasoning without leaking internal state to other providers', () => {
    const blocks = [{ type: 'reasoning.encrypted', data: 'opaque==' }];
    const params = { messages: [{ role: 'assistant', content: '', providerState: { provider: 'openrouter', blocks } }] };
    assert.deepEqual(buildBody(getDialect('openrouter'), params, false).messages[0].reasoning_details, blocks);
    const other = buildBody(getDialect('local'), params, false).messages[0];
    assert.equal(other.providerState, undefined);
    assert.equal(other.reasoning_details, undefined);
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
      const models = await geminiProvider.fetchModels('test-key', 'https://gemini.example.test');
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
