/**
 * Invariants the agent loop has to hold but had no coverage for.
 *
 * Nothing here executes `runAgentTask` — it needs a provider, a config and an Electron
 * host. These test the specific properties whose absence produced the bugs, at the
 * level where they can actually be asserted.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RequestMessage } from '$lib/services/chat/types';
import { ensureToolCallPairs } from '$lib/services/agent-message-context';
import { executeWithTimeoutAndRetries } from '$lib/services/agent-tool-runtime';

function assistantWithToolCalls(...ids: string[]): RequestMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'web_search', arguments: '{}' } }))
  };
}

/** The check every provider request must pass: no tool_calls block left unanswered. */
function hasUnpairedToolCalls(messages: RequestMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].tool_calls;
    if (messages[i].role !== 'assistant' || !calls?.length) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
      if (messages[j].tool_call_id) answered.add(String(messages[j].tool_call_id));
    }
    if (calls.some((call) => !answered.has(String(call.id)))) return true;
  }
  return false;
}

describe('forced final answer pairing', () => {
  /*
   * Every early break in the loop — tool budget reached, explore-only cap, stagnation
   * guard, research force-write — happens after the assistant message carrying
   * `tool_calls` is pushed and before any tool runs. The forced-synthesis retry then
   * called the provider directly *without* repairing pairs, so all attempts 400'd and
   * a bare `catch {}` hid it. Hitting any limit silently produced generic fallback
   * text instead of a real answer.
   */
  it('history after an early break is unpaired, which is why the repair is mandatory', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'compare these' },
      assistantWithToolCalls('call_a', 'call_b')
    ];
    expect(hasUnpairedToolCalls(messages)).toBe(true);
  });

  it('ensureToolCallPairs makes that same history sendable', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'compare these' },
      assistantWithToolCalls('call_a', 'call_b'),
      { role: 'user', content: 'You have reached the step limit. Do NOT call tools.' }
    ];

    ensureToolCallPairs(messages, 'fill');

    expect(hasUnpairedToolCalls(messages)).toBe(false);
    // The synthesized results have to sit directly after their parent block.
    expect(messages[3]?.role).toBe('tool');
    expect(messages[4]?.role).toBe('tool');
  });

  it('leaves already-paired history untouched', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      assistantWithToolCalls('call_a'),
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_a', name: 'web_search' }
    ];
    const before = JSON.stringify(messages);
    ensureToolCallPairs(messages, 'fill');
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe('tool timeout and abort', () => {
  const runtime = <T extends { success: boolean; error?: string }>(over: Partial<Parameters<typeof executeWithTimeoutAndRetries<T>>[0]>) => ({
    name: 'bash',
    args: {},
    timeoutMs: 50,
    maxRetries: 0,
    debug: false,
    onDebug: () => {},
    makeFailure: (message: string) => ({ success: false, error: message }) as T,
    toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    ...over
  }) as Parameters<typeof executeWithTimeoutAndRetries<T>>[0];

  it('rejects on abort instead of hanging forever', async () => {
    /*
     * The abort handler used to only `clearTimeout`, so nothing in the race could
     * settle unless the tool itself finished — and most handlers ignore the signal.
     * The promise leaked, and since the run was already ended by `stopStreaming`, a
     * late resolution wrote to a message the user had explicitly stopped.
     */
    const controller = new AbortController();
    const neverSettles = new Promise<{ success: boolean; error?: string }>(() => {});

    const pending = executeWithTimeoutAndRetries(runtime({
      signal: controller.signal,
      timeoutMs: 60_000,
      runTool: () => neverSettles
    }));

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeWithTimeoutAndRetries(runtime({
      signal: controller.signal,
      timeoutMs: 60_000,
      runTool: () => new Promise<{ success: boolean; error?: string }>(() => {})
    }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('still converts a genuine timeout into a failure result, not a throw', async () => {
    const result = await executeWithTimeoutAndRetries(runtime({
      timeoutMs: 10,
      runTool: () => new Promise<{ success: boolean; error?: string }>(() => {})
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('does not retry once a tool has been told not to', async () => {
    const runTool = vi.fn(async () => ({ success: false, error: 'network unavailable' }));
    await executeWithTimeoutAndRetries(runtime({ maxRetries: 0, runTool }));
    expect(runTool).toHaveBeenCalledTimes(1);
  });
});
