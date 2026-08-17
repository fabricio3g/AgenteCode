import { describe, it, expect } from 'vitest';
import { applyCodeAgentEvent, createAgenteRunState } from './agente-run';
import type { CodeAgentEvent } from './agente-protocol';

function run(events: CodeAgentEvent[]) {
  const state = createAgenteRunState();
  for (const event of events) applyCodeAgentEvent(state, event);
  return state;
}

describe('agente run reducer', () => {
  it('accumulates text and thinking deltas', () => {
    const state = run([
      { type: 'text_delta', chatId: 'c', delta: 'Hello ' },
      { type: 'text_delta', chatId: 'c', delta: 'world' },
      { type: 'thinking_delta', chatId: 'c', delta: 'hmm' }
    ]);
    expect(state.content).toBe('Hello world');
    expect(state.reasoning).toBe('hmm');
  });

  it('tracks a tool call from start to end', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'tool_update', chatId: 'c', toolCallId: 't1', partialResult: 'partial' },
      { type: 'tool_end', chatId: 'c', toolCallId: 't1', result: 'file body', isError: false }
    ]);
    const step = state.steps.find((s) => s.id === 't1');
    expect(step?.status).toBe('done');
    expect(step?.output).toBe('file body');
    expect(step?.detail).toContain('a.ts');
  });

  it('marks errored tools and surfaces the error message', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: { command: 'exit 1' } },
      { type: 'tool_end', chatId: 'c', toolCallId: 't1', result: 'boom', isError: true }
    ]);
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('resolves approval steps when the decision arrives', () => {
    const state = run([
      { type: 'approval_request', chatId: 'c', requestId: 'apr-1', toolName: 'write', args: { path: 'x' }, diff: '+++ x' },
      { type: 'approval_resolved', chatId: 'c', requestId: 'apr-1', decision: 'deny' }
    ]);
    const step = state.steps.find((s) => s.id === 'apr-1');
    expect(step?.status).toBe('error');
    expect(step?.detail).toBe('Denied');
  });

  it('attaches checkpoint diffstats to writing steps', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 'w1', toolName: 'write', args: { path: 'a.ts' } },
      {
        type: 'checkpoint_finalized',
        chatId: 'c',
        turnIndex: 1,
        files: [{ path: 'a.ts', additions: 10, deletions: 2, kind: 'modified' }]
      }
    ]);
    const write = state.steps.find((s) => s.id === 'w1');
    expect(write?.diffStats?.[0]).toMatchObject({ path: 'a.ts', additions: 10, deletions: 2 });
    expect(state.fileChanges).toHaveLength(1);
  });

  it('completes the run on agent_end and stops stray running steps', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'agent_end', chatId: 'c' }
    ]);
    expect(state.done).toBe(true);
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('records error events', () => {
    const state = run([{ type: 'error', chatId: 'c', message: 'no model' }]);
    expect(state.error).toBe('no model');
  });
});
