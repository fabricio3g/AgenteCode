import { describe, it } from 'node:test';
import assert from 'node:assert';

import { runAgentLoop } from '../../shared/agent-core/agent-loop.ts';
import { defineTool } from '../../main/agente/tools/define-tool.ts';
import { z } from 'zod';

function fakeStreamFn(responses) {
  let call = 0;
  const seen = [];
  const fn = async (request) => {
    seen.push(request.messages);
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { role: 'assistant', ts: Date.now(), ...next };
  };
  fn.calls = () => seen;
  return fn;
}

function noopEmit() {}

const baseArgs = (overrides = {}) => ({
  messages: [{ role: 'user', content: 'go', ts: 1 }],
  config: { maxTurns: 10 },
  tools: new Map(),
  enabledTools: new Set(),
  streamFn: fakeStreamFn([]),
  systemPrompt: 'sys',
  emit: noopEmit,
  signal: new AbortController().signal,
  drainSteered: () => [],
  drainFollowUps: () => [],
  ...overrides
});

describe('agente agent loop', () => {
  it('stops after a plain assistant reply', async () => {
    const streamFn = fakeStreamFn([{ content: 'hello', stopReason: 'stop' }]);
    const result = await runAgentLoop(baseArgs({ streamFn }));
    assert.strictEqual(result.stopReason, 'stop');
    assert.strictEqual(result.turns, 1);
    assert.strictEqual(result.messages.at(-1).role, 'assistant');
  });

  it('executes tool calls and feeds results back until the model stops', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
      async execute(args) {
        return { content: `echo:${args.text}` };
      }
    });
    const streamFn = fakeStreamFn([
      { content: '', stopReason: 'toolUse', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }] },
      { content: 'done', stopReason: 'stop' }
    ]);
    const result = await runAgentLoop(
      baseArgs({ streamFn, tools: new Map([['echo', echo]]), enabledTools: new Set(['echo']) })
    );

    assert.strictEqual(result.turns, 2);
    const toolResult = result.messages.find((m) => m.role === 'tool');
    assert.ok(toolResult);
    assert.strictEqual(toolResult.content, 'echo:hi');
    assert.strictEqual(toolResult.isError, false);
    // The second stream call must see the tool result message.
    const secondCallMessages = streamFn.calls()[1];
    assert.ok(secondCallMessages.some((m) => m.role === 'tool' && m.content === 'echo:hi'));
  });

  it('preserves tool result order when tools run in parallel', async () => {
    const tools = new Map();
    let counter = 0;
    for (const name of ['slow_a', 'fast_b']) {
      tools.set(name, defineTool({
        name,
        description: name,
        schema: z.object({}),
        async execute() {
          // b finishes first even though it was called second.
          if (name === 'slow_a') await new Promise((r) => setTimeout(r, 30));
          else await new Promise((r) => setTimeout(r, 5));
          counter += 1;
          return { content: `${name}:${counter}` };
        }
      }));
    }
    const streamFn = fakeStreamFn([
      {
        content: '',
        stopReason: 'toolUse',
        toolCalls: [
          { id: 't1', name: 'slow_a', arguments: {} },
          { id: 't2', name: 'fast_b', arguments: {} }
        ]
      },
      { content: 'ok', stopReason: 'stop' }
    ]);
    const result = await runAgentLoop(baseArgs({ streamFn, tools, enabledTools: new Set(['slow_a', 'fast_b']) }));

    const toolResults = result.messages.filter((m) => m.role === 'tool');
    assert.deepStrictEqual(toolResults.map((r) => r.toolCallId), ['t1', 't2']);
  });

  it('fails tool calls with unsafe truncated arguments on stopReason length', async () => {
    const events = [];
    const streamFn = fakeStreamFn([
      { content: 'partial', stopReason: 'length', toolCalls: [{ id: 'c9', name: 'echo', arguments: { text: 'cut' } }] }
    ]);
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
      async execute() {
        throw new Error('must not run');
      }
    });
    const result = await runAgentLoop(
      baseArgs({
        streamFn,
        tools: new Map([['echo', echo]]),
        enabledTools: new Set(['echo']),
        emit: (e) => events.push(e)
      })
    );
    assert.strictEqual(result.stopReason, 'length');
    const failed = result.messages.find((m) => m.role === 'tool');
    assert.ok(failed?.isError);
  });

  it('blocks a tool call through the beforeToolCall hook', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      schema: z.object({}),
      async execute() {
        return { content: 'ran' };
      }
    });
    const streamFn = fakeStreamFn([
      { content: '', stopReason: 'toolUse', toolCalls: [{ id: 'b1', name: 'echo', arguments: {} }] },
      { content: 'ok', stopReason: 'stop' }
    ]);
    const result = await runAgentLoop(
      baseArgs({
        streamFn,
        tools: new Map([['echo', echo]]),
        enabledTools: new Set(['echo']),
        hooks: { beforeToolCall: async () => ({ block: 'not allowed' }) }
      })
    );
    const blocked = result.messages.find((m) => m.role === 'tool');
    assert.match(blocked.content, /Blocked: not allowed/);
  });

  it('reports unknown tools as errors instead of throwing', async () => {
    const streamFn = fakeStreamFn([
      { content: '', stopReason: 'toolUse', toolCalls: [{ id: 'u1', name: 'nope', arguments: {} }] },
      { content: 'ok', stopReason: 'stop' }
    ]);
    const result = await runAgentLoop(baseArgs({ streamFn }));
    const missing = result.messages.find((m) => m.role === 'tool');
    assert.match(missing.content, /unknown tool "nope"/);
  });

  it('respects the turn limit and appends a limit notice', async () => {
    const streamFn = fakeStreamFn([{ content: '', stopReason: 'toolUse', toolCalls: [{ id: `c`, name: 'x', arguments: {} }] }]);
    const result = await runAgentLoop(baseArgs({ streamFn, config: { maxTurns: 2 } }));
    assert.strictEqual(result.turns, 2);
    const last = result.messages.at(-1);
    assert.strictEqual(last.role, 'assistant');
    assert.match(last.content, /turn limit/);
  });

  it('ends the run before executing when beforeToolBatch says stop', async () => {
    let ran = 0;
    const echo = { name: 'echo', description: 'e', parameters: { type: 'object' }, execute: async () => { ran += 1; return { content: 'x' }; } };
    const streamFn = fakeStreamFn([
      { content: '', stopReason: 'toolUse', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] }
    ]);
    const seen = [];
    const result = await runAgentLoop(baseArgs({
      streamFn,
      tools: new Map([['echo', echo]]),
      enabledTools: new Set(['echo']),
      hooks: { beforeToolBatch: async (calls, turn) => { seen.push([calls.map((c) => c.name), turn]); return { stop: true }; } }
    }));
    assert.strictEqual(result.stopReason, 'stop');
    assert.strictEqual(ran, 0);
    assert.deepStrictEqual(seen, [[['echo'], 1]]);
  });

  it('gives the model another turn when reviewFinalReply rejects a reply', async () => {
    const streamFn = fakeStreamFn([
      { content: 'draft', stopReason: 'stop' },
      { content: 'final', stopReason: 'stop' }
    ]);
    let reviews = 0;
    const result = await runAgentLoop(baseArgs({
      streamFn,
      hooks: {
        reviewFinalReply: async (message) => {
          reviews += 1;
          return message.content === 'draft' ? { retry: [{ role: 'user', content: 'try again', ts: 2 }] } : undefined;
        }
      }
    }));
    assert.strictEqual(result.turns, 2);
    assert.strictEqual(reviews, 2);
    assert.strictEqual(result.messages.at(-1).content, 'final');
    assert.ok(streamFn.calls()[1].some((m) => m.role === 'user' && m.content === 'try again'));
  });

  it('propagates abort through stopReason', async () => {
    const controller = new AbortController();
    controller.abort();
    const streamFn = fakeStreamFn([{ content: 'x', stopReason: 'stop' }]);
    const result = await runAgentLoop(baseArgs({ streamFn, signal: controller.signal }));
    assert.strictEqual(result.stopReason, 'aborted');
  });
});

describe('defineTool validation', () => {
  it('rejects invalid arguments with a helpful message', async () => {
    const tool = defineTool({
      name: 't',
      description: 't',
      schema: z.object({ n: z.number() }),
      async execute(args) {
        return { content: String(args.n) };
      }
    });
    const result = await tool.execute('call1', { n: 'not-a-number' }, { signal: new AbortController().signal });
    assert.ok(result.isError);
    assert.match(result.content, /Invalid arguments/);
  });
});
