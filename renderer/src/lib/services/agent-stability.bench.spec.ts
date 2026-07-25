/**
 * Functional tests + lightweight micro-benchmarks for Auto routing,
 * tool-pair sanitization, and human-readable errors.
 *
 * Run: npx vitest run src/lib/services/agent-stability.bench.spec.ts
 */
import { describe, expect, it } from 'vitest';
import {
  ensureToolCallPairs,
  trimContext
} from '$lib/services/agent-message-context';
import {
  resolveComposerRoute,
  shouldUseToolLoop
} from '$lib/services/composer-route';
import { humanizeAgentError } from '$lib/utils/errors';
import { appendToolResultMessage } from '$lib/services/agent-tool-result';
import type { RequestMessage } from '$lib/services/chat-api';
import type { ToolCall } from '$lib/services/agent-types';

function bench(name: string, iterations: number, fn: () => void): { name: string; iterations: number; totalMs: number; perOpUs: number; opsPerSec: number } {
  // Warmup
  for (let i = 0; i < Math.min(200, iterations); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - t0;
  const perOpUs = (totalMs * 1000) / iterations;
  const opsPerSec = iterations / (totalMs / 1000);
  return { name, iterations, totalMs, perOpUs, opsPerSec };
}

function makePairedLoop(pairs: number): RequestMessage[] {
  const msgs: RequestMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  for (let i = 0; i < pairs; i++) {
    const id = `call_${i}`;
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'get_weather', arguments: '{"location":"X"}' } }]
    });
    msgs.push({ role: 'tool', content: JSON.stringify({ ok: true, i }), tool_call_id: id, name: 'get_weather' });
  }
  return msgs;
}

describe('functional: Auto routing matrix', () => {
  const cases: Array<{ prompt: string; expect: ReturnType<typeof resolveComposerRoute> }> = [
    { prompt: 'hi', expect: 'conversation' },
    { prompt: 'Thanks a lot!', expect: 'conversation' },
    { prompt: 'What is the weather in Tokyo?', expect: 'tools' },
    { prompt: 'convert 50 eur to usd', expect: 'tools' },
    { prompt: 'BTC price right now', expect: 'tools' },
    { prompt: 'latest news about AI regulation', expect: 'tools' },
    { prompt: 'Create a PDF report of Q3 results', expect: 'agent' },
    { prompt: 'fix the TypeScript error in agent.ts', expect: 'agent' },
    { prompt: 'build me a website with three pages', expect: 'agent' }
  ];

  for (const c of cases) {
    it(`route("${c.prompt.slice(0, 40)}") → ${c.expect}`, () => {
      expect(resolveComposerRoute({ prompt: c.prompt })).toBe(c.expect);
    });
  }

  it('auto conversation does not start tool loop; tools/agent do', () => {
    expect(shouldUseToolLoop({ control: 'auto', composerMode: 'chat', route: 'conversation' })).toBe(false);
    expect(shouldUseToolLoop({ control: 'auto', composerMode: 'chat', route: 'tools' })).toBe(true);
    expect(shouldUseToolLoop({ control: 'auto', composerMode: 'chat', route: 'agent' })).toBe(true);
  });

  it('tabs Agent always uses tool loop even for greetings', () => {
    expect(shouldUseToolLoop({ control: 'tabs', composerMode: 'agent', route: 'conversation' })).toBe(true);
  });
});

describe('functional: tool_calls pair integrity', () => {
  it('fills missing tool results so chat_complete would accept the sequence', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: 'weather' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{}' } }
        ]
      },
      { role: 'tool', content: '{}', tool_call_id: 'a', name: 'get_weather' }
    ];
    ensureToolCallPairs(messages, 'fill');
    const ids = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('trim keeps history and leaves valid pairs only', () => {
    const history: RequestMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }
    ];
    const loop = makePairedLoop(8).slice(2); // drop sys+user from helper
    const messages: RequestMessage[] = [{ role: 'system', content: 'sys' }, ...history, ...loop];
    trimContext(messages, { historyCount: history.length, maxLoopMessages: 6 });

    // Validate no orphan tools / missing results
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const needed = new Set(m.tool_calls.map((c) => c.id));
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          needed.delete(String(messages[j].tool_call_id || ''));
          j += 1;
        }
        expect([...needed]).toEqual([]);
      }
      if (m.role === 'tool') {
        let j = i - 1;
        while (j >= 0 && messages[j].role === 'tool') j -= 1;
        const parent = messages[j];
        expect(parent?.role).toBe('assistant');
        expect(parent?.tool_calls?.some((c) => c.id === m.tool_call_id)).toBe(true);
      }
    }
  });

  it('appendToolResultMessage always emits role=tool with id', () => {
    const messages: RequestMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]
      }
    ];
    const toolCall: ToolCall = { id: 'call_x', name: 'get_weather', arguments: { location: 'Madrid' } };
    appendToolResultMessage({
      toolCall,
      result: { success: true, output: { ok: true } },
      messages,
      nativeActive: false, // even if "failed native", still tool role when pair expected
      nativeFailed: true,
      maxToolResultChars: 4000
    });
    expect(messages[1].role).toBe('tool');
    expect(messages[1].tool_call_id).toBe('call_x');
  });
});

describe('functional: humanizeAgentError', () => {
  const cases: Array<{ input: string; mustNotInclude: string[]; mustMatch?: RegExp }> = [
    {
      input: "Error invoking remote method 'chat_complete': Error: 400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'",
      mustNotInclude: ['invoking remote', 'tool_call_id'],
      mustMatch: /try again|glitch|tools/i
    },
    {
      input: 'network ETIMEDOUT while fetching',
      mustNotInclude: ['ETIMEDOUT'],
      mustMatch: /connection|reach|try again/i
    },
    {
      input: '401 Unauthorized invalid api key',
      mustNotInclude: [],
      mustMatch: /api key|settings/i
    },
    {
      input: 'context_length_exceeded maximum context length',
      mustNotInclude: ['context_length_exceeded'],
      mustMatch: /too long|new chat/i
    },
    {
      input: '503 Service Unavailable',
      mustNotInclude: [],
      mustMatch: /outage|try again/i
    }
  ];

  for (const c of cases) {
    it(`humanizes: ${c.input.slice(0, 50)}…`, () => {
      const out = humanizeAgentError(new Error(c.input));
      for (const bad of c.mustNotInclude) {
        expect(out.toLowerCase()).not.toContain(bad.toLowerCase());
      }
      if (c.mustMatch) expect(out).toMatch(c.mustMatch);
    });
  }
});

describe('benchmarks (micro)', () => {
  it('reports throughput for route / pair / humanize', () => {
    const prompts = [
      'hi',
      'weather in Paris',
      'convert 10 USD to EUR',
      'AAPL stock price',
      'create a spreadsheet of sales',
      'explain photosynthesis',
      'fix my build error please'
    ];

    const routeBench = bench('resolveComposerRoute', 50_000, () => {
      resolveComposerRoute({ prompt: prompts[Math.floor(Math.random() * prompts.length)] });
    });

    const base = makePairedLoop(20);
    // Break one pair each run to exercise fill
    const pairBench = bench('ensureToolCallPairs(fill)', 5_000, () => {
      const msgs = structuredClone(base);
      // drop last tool
      msgs.pop();
      ensureToolCallPairs(msgs, 'fill');
    });

    const humanBench = bench('humanizeAgentError', 20_000, () => {
      humanizeAgentError(
        new Error("Error invoking remote method 'chat_complete': Error: 400 tool_calls must be followed by tool messages")
      );
    });

    const trimBench = bench('trimContext+pairs', 2_000, () => {
      const msgs = makePairedLoop(30);
      // prepend history
      msgs.splice(1, 0, { role: 'user', content: 'h1' }, { role: 'assistant', content: 'ha' }, { role: 'user', content: 'h2' });
      trimContext(msgs, { historyCount: 4, maxLoopMessages: 12 });
    });

    const results = [routeBench, pairBench, humanBench, trimBench];
    // Log for human review in CI/local
    console.log('\n=== Agent stability micro-benchmarks ===');
    for (const r of results) {
      console.log(
        `${r.name.padEnd(28)} ${r.iterations.toLocaleString().padStart(8)} iters  ` +
          `${r.totalMs.toFixed(1).padStart(7)} ms  ` +
          `${r.perOpUs.toFixed(2).padStart(8)} µs/op  ` +
          `${Math.round(r.opsPerSec).toLocaleString().padStart(10)} ops/s`
      );
    }
    console.log('========================================\n');

    // Sanity ceilings — these are pure CPU, should be very fast
    expect(routeBench.perOpUs).toBeLessThan(50);
    expect(humanBench.perOpUs).toBeLessThan(50);
    expect(pairBench.perOpUs).toBeLessThan(500);
    expect(trimBench.perOpUs).toBeLessThan(2000);
  });
});
