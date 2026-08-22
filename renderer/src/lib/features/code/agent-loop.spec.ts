import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  isTransientStreamError,
  type AgentLoopArgs,
  type AgentLoopResult
} from '../../../../../main/agente/core/agent-loop';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AssistantMessage
} from '../../../../../main/agente/core/types';
import { normalizeTodos } from '../../../../../main/agente/tools/todo';

function makeTool(name = 'echo'): AgentTool {
  return {
    name,
    description: 'returns its args',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    async execute(_id, args) {
      return { content: `ok:${JSON.stringify(args)}` };
    }
  };
}

function assistant(partial: Partial<AssistantMessage>): AssistantMessage {
  return { role: 'assistant', content: '', ts: Date.now(), ...partial };
}

interface LoopHarness {
  result: Promise<AgentLoopResult>;
  events: AgentEvent[];
}

function runLoop(
  responses: AssistantMessage[],
  overrides: Partial<AgentLoopArgs> = {}
): LoopHarness {
  const events: AgentEvent[] = [];
  let call = 0;
  const args: AgentLoopArgs = {
    messages: [],
    config: { maxTurns: 12 },
    tools: new Map([[makeTool().name, makeTool()]]),
    enabledTools: new Set(['echo']),
    streamFn: async () => {
      const next = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return next;
    },
    systemPrompt: 'test',
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    drainSteered: () => [],
    drainFollowUps: () => [],
    ...overrides
  };
  return { result: runAgentLoop(args), events };
}

describe('agent loop resilience', () => {
  it('auto-continues when a turn hits the length cap instead of abandoning the task', async () => {
    const { result, events } = runLoop([
      assistant({ stopReason: 'length', toolCalls: [{ id: 't1', name: 'echo', arguments: { q: 'big' } }] }),
      assistant({ stopReason: 'toolUse', toolCalls: [{ id: 't2', name: 'echo', arguments: { q: 'small' } }] }),
      assistant({ stopReason: 'stop', content: 'done' })
    ]);
    const outcome = await result;
    expect(outcome.stopReason).toBe('stop');
    expect(outcome.turns).toBe(3);
    // The truncated call was failed with a re-issue hint…
    const blocked = outcome.messages.find((m) => m.role === 'tool' && m.isError);
    expect(blocked).toBeTruthy();
    // …and the run announced the continuation.
    expect(events.some((e) => e.type === 'length_continue')).toBe(true);
  });

  it('gives up after repeated truncations and reports length', async () => {
    const truncated = assistant({ stopReason: 'length', toolCalls: [{ id: 't1', name: 'echo', arguments: {} }] });
    const { result, events } = runLoop([truncated]);
    const outcome = await result;
    expect(outcome.stopReason).toBe('length');
    // Cap is 3: continuations announced for streaks 1 and 2, none past the cap.
    expect(events.filter((e) => e.type === 'length_continue')).toHaveLength(2);
  });

  it('keeps the run alive when a steer arrives during the final streaming turn', async () => {
    const steered = [{ role: 'user' as const, content: '[steer] also update the docs', ts: Date.now() }];
    const { result } = runLoop([
      assistant({ stopReason: 'stop', content: 'first answer' }),
      assistant({ stopReason: 'stop', content: 'second answer' })
    ], { drainSteered: () => steered.splice(0) });
    const outcome = await result;
    // Turn 1 ended naturally but the queued steer vetoed the stop.
    expect(outcome.turns).toBe(2);
    expect(outcome.messages.some((m) => m.role === 'user' && m.content.includes('docs'))).toBe(true);
  });

  it('retries transient stream failures that produced no output', async () => {
    let call = 0;
    const { result } = runLoop([], {
      streamFn: async () => {
        call += 1;
        if (call === 1) return assistant({ stopReason: 'error', errorMessage: 'HTTP 429 rate limit exceeded' });
        return assistant({ stopReason: 'stop', content: 'recovered' });
      }
    });
    const outcome = await result;
    expect(outcome.stopReason).toBe('stop');
    expect(outcome.messages.some((m) => m.role === 'assistant' && m.content === 'recovered')).toBe(true);
  });

  it('emits llm_retry with attempt and backoff on transient errors', async () => {
    let call = 0;
    const { result, events } = runLoop([], {
      streamFn: async () => {
        call += 1;
        if (call === 1) return assistant({ stopReason: 'error', errorMessage: 'socket hang up' });
        return assistant({ stopReason: 'stop', content: 'fine' });
      }
    });
    await result;
    const retries = events.filter((e) => e.type === 'llm_retry');
    expect(retries).toEqual([{ type: 'llm_retry', attempt: 1, delayMs: 1000 }]);
  });

  it('does not retry mid-stream failures that already shipped content', async () => {
    const { result, events } = runLoop([], {
      streamFn: async ({ callbacks }) => {
        callbacks?.onTextDelta?.('partial ');
        return assistant({ stopReason: 'error', errorMessage: '503 gateway timeout', content: 'partial ' });
      }
    });
    const outcome = await result;
    expect(outcome.stopReason).toBe('error');
    expect(events.some((e) => e.type === 'llm_retry')).toBe(false);
  });

  it('does not retry permanent failures like auth errors', async () => {
    const { result, events } = runLoop([], {
      streamFn: async () => assistant({ stopReason: 'error', errorMessage: 'Invalid API key provided' })
    });
    const outcome = await result;
    expect(outcome.stopReason).toBe('error');
    expect(events.some((e) => e.type === 'llm_retry')).toBe(false);
  });

  it('injects a change-approach note after three identical calls', async () => {
    const same = () =>
      assistant({ stopReason: 'toolUse', toolCalls: [{ id: `t${Math.random()}`, name: 'echo', arguments: { q: 'same' } }] });
    const { result } = runLoop([same(), same(), same(), assistant({ stopReason: 'stop', content: 'gave up' })]);
    const outcome = await result;
    const notes = outcome.messages.filter((m) => m.role === 'user' && m.content.startsWith('[note]'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain('3 times in a row');
  });

  it('stays silent below the repeat threshold', async () => {
    const same = () =>
      assistant({ stopReason: 'toolUse', toolCalls: [{ id: `t${Math.random()}`, name: 'echo', arguments: { q: 'same' } }] });
    const { result } = runLoop([same(), same(), assistant({ stopReason: 'stop', content: 'done' })]);
    const outcome = await result;
    expect(outcome.messages.some((m) => m.role === 'user' && m.content.startsWith('[note]'))).toBe(false);
  });

  it('reports the final stop reason on agent_end', async () => {
    const { result, events } = runLoop([assistant({ stopReason: 'stop', content: 'bye' })]);
    const outcome = await result;
    const end = events.find((e) => e.type === 'agent_end');
    expect(end).toEqual({ type: 'agent_end', stopReason: 'stop' });
    expect(outcome.stopReason).toBe('stop');
  });
});

describe('isTransientStreamError', () => {
  it.each([
    ['HTTP 429 too many requests', true],
    ['rate limit exceeded', true],
    ['503 service unavailable', true],
    ['request timeout after 30s', true],
    ['socket hang up', true],
    ['fetch failed', true],
    ['ECONNRESET', true],
    ['Invalid API key provided', false],
    ['model not found', false],
    ['invalid_request_error: bad schema', false]
  ])('%s → %s', (message, expected) => {
    expect(isTransientStreamError(message)).toBe(expected);
  });
});

describe('normalizeTodos', () => {
  it('trims content and preserves order', () => {
    expect(normalizeTodos([
      { content: '  read files ', status: 'completed' },
      { content: 'edit', status: 'in_progress' }
    ])).toEqual([
      { content: 'read files', status: 'completed' },
      { content: 'edit', status: 'in_progress' }
    ]);
  });

  it('rejects empty content', () => {
    expect(() => normalizeTodos([{ content: '   ', status: 'pending' }])).toThrow(/non-empty/);
  });

  it('rejects duplicates', () => {
    expect(() => normalizeTodos([
      { content: 'same', status: 'pending' },
      { content: 'same', status: 'completed' }
    ])).toThrow(/duplicate/);
  });

  it('allows at most one in_progress', () => {
    expect(() => normalizeTodos([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' }
    ])).toThrow(/at most one/);
  });

  it('rejects unknown statuses', () => {
    expect(() => normalizeTodos([{ content: 'a', status: 'done' }])).toThrow(/pending \| in_progress \| completed/);
  });
});
