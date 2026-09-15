import { describe, it, expect } from 'vitest';
import { applyCodeAgentEvent, createCodeRunState } from './code-run';
import type { CodeAgentEvent } from '$shared/agente-protocol';

function run(events: CodeAgentEvent[]) {
  const state = createCodeRunState();
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

  it('completes the run on agent_end and closes stray running steps', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'agent_end', chatId: 'c', stopReason: 'stop' }
    ]);
    expect(state.done).toBe(true);
    expect(state.stopReason).toBe('stop');
    // No error was reported, so the stray step is closed as done — not
    // punished as a failure.
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('done');
  });

  it('marks a stray running step error when the run failed', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'error', chatId: 'c', message: 'provider unreachable' },
      { type: 'agent_end', chatId: 'c', stopReason: 'error' }
    ]);
    expect(state.done).toBe(true);
    expect(state.error).toBe('provider unreachable');
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('records error events', () => {
    const state = run([{ type: 'error', chatId: 'c', message: 'no model' }]);
    expect(state.error).toBe('no model');
  });

  it('finalizes the run on error even when agent_end never follows', () => {
    // The engine's prompt() rejection path emits `error` as the last event.
    // Without finalizing here the assistant placeholder streamed forever.
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'error', chatId: 'c', message: 'prompt failed' }
    ]);
    expect(state.done).toBe(true);
    expect(state.stopReason).toBe('error');
    expect(state.error).toBe('prompt failed');
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('captures the end-of-run stop reason', () => {
    const state = run([{ type: 'agent_end', chatId: 'c', stopReason: 'length' }]);
    expect(state.stopReason).toBe('length');
  });

  it('shows and clears the retry notice around content', () => {
    const state = run([
      { type: 'llm_retry', chatId: 'c', attempt: 1, delayMs: 1000 }
    ]);
    expect(state.retrying).toEqual({ attempt: 1, delayMs: 1000 });
    applyCodeAgentEvent(state, { type: 'text_delta', chatId: 'c', delta: 'back online' });
    expect(state.retrying).toBeNull();
  });

  it('records a truncated turn that was auto-continued', () => {
    const state = run([
      { type: 'length_continue', chatId: 'c', turnIndex: 2 }
    ]);
    expect(state.truncatedOnce).toBe(true);
    expect(state.steps.find((s) => s.id === 'turn-2')?.label).toContain('output cap');
  });

  it('replaces the todo list on todo_update', () => {
    const state = run([
      {
        type: 'todo_update',
        chatId: 'c',
        todos: [
          { content: 'read files', status: 'completed' },
          { content: 'edit config', status: 'in_progress' },
          { content: 'run tests', status: 'pending' }
        ]
      }
    ]);
    expect(state.todos).toHaveLength(3);
    expect(state.todos[1]).toEqual({ content: 'edit config', status: 'in_progress' });
  });
});
