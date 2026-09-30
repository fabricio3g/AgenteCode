import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveProvider } from '../../main/providers/registry.ts';

// Current llama.cpp has no top-level `disable_thinking` request field — it is
// silently ignored. Thinking is toggled through the Jinja kwarg
// `chat_template_kwargs.enable_thinking` (real boolean; the server 400s on the
// string "false"), the same shape the bundled llama-ui WebUI sends.

function withFetch(fakeFetch, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(callback)
    .finally(() => { globalThis.fetch = original; });
}

function captureBody() {
  let body;
  const fakeFetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    };
  };
  return { fakeFetch, getBody: () => body };
}

const baseParams = {
  apiKey: '',
  baseUrl: 'http://127.0.0.1:11435/v1',
  model: 'local-model',
  messages: [{ role: 'user', content: 'ping' }]
};

describe('local thinking wire format', () => {
  it("forwards the core's 'off' fields as enable_thinking:false (never disable_thinking)", async () => {
    const { fakeFetch, getBody } = captureBody();
    await withFetch(fakeFetch, async () => {
      await resolveProvider('local', baseParams.baseUrl).complete({
        ...baseParams,
        reasoning: { level: 'off', body: { chat_template_kwargs: { enable_thinking: false } } }
      });
    });
    const body = getBody();
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_format, 'auto');
    assert.ok(!('disable_thinking' in body), 'dead disable_thinking field must not be sent');
  });

  it("forwards the core's 'on' fields as enable_thinking:true", async () => {
    const { fakeFetch, getBody } = captureBody();
    await withFetch(fakeFetch, async () => {
      await resolveProvider('local', baseParams.baseUrl).complete({
        ...baseParams,
        reasoning: { level: 'on', body: { chat_template_kwargs: { enable_thinking: true } } }
      });
    });
    const body = getBody();
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.reasoning_format, 'auto');
  });

  it('omits the kwarg when no level is chosen so the server default applies', async () => {
    const { fakeFetch, getBody } = captureBody();
    await withFetch(fakeFetch, async () => {
      await resolveProvider('local', baseParams.baseUrl).complete({ ...baseParams });
    });
    const body = getBody();
    assert.ok(!('chat_template_kwargs' in body), 'no explicit choice must not pin thinking');
    assert.equal(body.reasoning_format, 'auto');
  });

  it('still sends tool definitions alongside the thinking controls', async () => {
    const { fakeFetch, getBody } = captureBody();
    const tools = [{
      type: 'function',
      function: { name: 'calculator', description: 'math', parameters: { type: 'object', properties: {} } }
    }];
    await withFetch(fakeFetch, async () => {
      await resolveProvider('local', baseParams.baseUrl).complete({
        ...baseParams,
        reasoning: { level: 'off', body: { chat_template_kwargs: { enable_thinking: false } } },
        tools,
        tool_choice: 'auto'
      });
    });
    const body = getBody();
    assert.equal(body.tools.length, 1);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  });
});
