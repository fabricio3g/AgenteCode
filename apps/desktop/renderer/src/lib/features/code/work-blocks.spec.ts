import { describe, expect, it } from 'vitest';
import type { AgentStep } from '$lib/types/chat';
import type { CodeTodoItem } from '$shared/agente-protocol';
import { applyCodeAgentEvent, createCodeRunState, orderedEntries } from './code-run';
import { disclosureKey, DisclosureStore } from './disclosure.svelte';
import { changedFiles, currentTodo, editedFiles, liveStatus, planRows, replyBlocks, workBlockKey, QUIET_MS } from './work-blocks';

const step = (id: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id, type: 'tool', label: 'Edit', toolName: 'edit', status: 'done', ...extra });

describe('work block keys', () => {
  it('never borrows a row key, so folding the first child cannot fold the block', () => {
    const store = new DisclosureStore();
    const rowKey = disclosureKey('c', 'm', 's-task-1');
    const blockKey = disclosureKey('c', 'm', workBlockKey('s-task-1'));

    store.toggle(rowKey, false);

    expect(store.isOpen(rowKey, false)).toBe(true);
    expect(store.isOpen(blockKey, false)).toBe(false);
  });

  it('still keys a block by its first row, so a message keeps one block state', () => {
    expect(workBlockKey('s-task-1')).toBe(workBlockKey('s-task-1'));
    expect(workBlockKey(undefined)).toBe('block-work');
  });
});

describe('reply blocks', () => {
  it('keeps thoughts where they happened and groups them with the work around them', () => {
    const run = createCodeRunState();
    const chatId = 'c';
    applyCodeAgentEvent(run, { type: 'thinking_delta', chatId, delta: 'Look first.' });
    applyCodeAgentEvent(run, { type: 'tool_start', chatId, toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } });
    applyCodeAgentEvent(run, { type: 'tool_end', chatId, toolCallId: 't1', result: 'x', isError: false });
    applyCodeAgentEvent(run, { type: 'text_delta', chatId, delta: 'Found it.' });
    applyCodeAgentEvent(run, { type: 'thinking_delta', chatId, delta: 'Now edit.' });
    const entries = orderedEntries({ agentSteps: run.steps, content: run.content }, run.timeline);
    const blocks = replyBlocks(entries);
    expect(blocks.map((block) => (block.text !== undefined ? 'text' : (block.items ?? []).map((item) => (item.thinking ? 'thought' : 'step')).join('+')))).toEqual(['thought+step', 'text', 'thought']);
  });

  it('puts the reasoning of older saved runs first', () => {
    const entries = orderedEntries({ content: 'Done.', reasoning: 'Plan it.', agentSteps: [] });
    expect(entries.map((entry) => entry.thinking ?? entry.text)).toEqual(['Plan it.', 'Done.']);
  });

  it('puts one plan card where the reply last changed its todos, not a step row', () => {
    const entries = orderedEntries({ content: '', agentSteps: [step('a', { toolName: 'todo' }), step('c'), step('b', { toolName: 'todo_write' }), step('d')] });
    expect(entries.map((entry) => (entry.plan ? 'plan' : entry.step?.id))).toEqual(['c', 'plan', 'd']);
    expect(replyBlocks(entries).map((block) => (block.plan ? 'plan' : block.items?.length))).toEqual([1, 'plan', 1]);
  });

  it('folds a long plan to the task before the current one, the current one and the next', () => {
    const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status });
    const todos = [todo('a', 'completed'), todo('b', 'completed'), todo('c', 'in_progress'), todo('d', 'pending'), todo('e', 'pending'), todo('f', 'pending')];
    expect(planRows(todos).map((item) => item.content)).toEqual(['b', 'c', 'd']);
    expect(planRows(todos, true)).toHaveLength(6);
    expect(planRows(todos.slice(0, 5))).toHaveLength(5);
    expect(planRows(todos.map((item) => ({ ...item, status: 'completed' as const }))).map((item) => item.content)).toEqual(['d', 'e', 'f']);
  });
});

describe('changed files', () => {
  it('sums each file once and names it by its basename', () => {
    const items = [
      { key: '1', step: step('1', { diffStats: [{ path: 'src/a.ts', kind: 'modified', additions: 2, deletions: 1 }] }) },
      { key: '2', step: step('2', { diffStats: [{ path: 'src/a.ts', kind: 'modified', additions: 3, deletions: 0 }, { path: 'b.ts', kind: 'created', additions: 4, deletions: 0 }] }) },
      { key: '3', thinking: 'hm' }
    ];
    expect(changedFiles(items)).toEqual([
      { path: 'src/a.ts', name: 'a.ts', additions: 5, deletions: 1 },
      { path: 'b.ts', name: 'b.ts', additions: 4, deletions: 0 }
    ]);
  });

  it('keeps every edit\'s patch in order for the Changes pane, and skips approvals', () => {
    const edits = editedFiles([
      step('1', { diffStats: [{ path: 'a.ts', kind: 'modified', additions: 1, deletions: 1, patch: '@@ first' }] }),
      step('2', { type: 'approval', diffStats: [{ path: 'a.ts', kind: 'modified', additions: 9, deletions: 9, patch: '@@ asked' }] }),
      step('3', { diffStats: [{ path: 'a.ts', kind: 'modified', additions: 2, deletions: 0, patch: '@@ second' }] })
    ]);
    expect(edits).toEqual([{ path: 'a.ts', name: 'a.ts', kind: 'modified', additions: 3, deletions: 1, patches: ['@@ first', '@@ second'] }]);
  });
});

describe('live status', () => {
  const base = () => ({ ...createCodeRunState(), lastEventAt: 1_000 });

  it('names a tool call while the model is still writing it', () => {
    const run = base();
    applyCodeAgentEvent(run, { type: 'runtime_event', chatId: 'c', event: { type: 'generation_progress', output_bytes: 100, tool_name: 'edit' } });
    applyCodeAgentEvent(run, { type: 'runtime_event', chatId: 'c', event: { type: 'generation_progress', output_bytes: 3_300, tool_name: 'edit' } });
    expect(liveStatus(run, false, run.lastEventAt!)).toEqual({ kind: 'preparing', toolName: 'edit', bytes: 3_200 });
    applyCodeAgentEvent(run, { type: 'tool_start', chatId: 'c', toolCallId: 't', toolName: 'edit', args: { path: 'a.ts' } });
    expect(liveStatus(run, false, run.lastEventAt!).kind).toBe('running');
  });

  it('follows what streamed last, and admits silence', () => {
    const run = base();
    applyCodeAgentEvent(run, { type: 'thinking_delta', chatId: 'c', delta: 'hm' });
    expect(liveStatus(run, false, run.lastEventAt!).kind).toBe('thinking');
    applyCodeAgentEvent(run, { type: 'text_delta', chatId: 'c', delta: 'Ok' });
    expect(liveStatus(run, false, run.lastEventAt!).kind).toBe('writing');
    expect(liveStatus(run, false, run.lastEventAt! + QUIET_MS).kind).toBe('writing');
    applyCodeAgentEvent(run, { type: 'runtime_event', chatId: 'c', event: { type: 'thinking' } });
    expect(liveStatus(run, false, run.lastEventAt! + QUIET_MS).kind).toBe('requesting');
    expect(liveStatus(run, true, run.lastEventAt!).kind).toBe('approval');
  });
});

describe('current todo', () => {
  const todos = (...states: CodeTodoItem['status'][]): CodeTodoItem[] => states.map((status, index) => ({ content: `t${index}`, status }));
  it('names the task in progress, else the next one, else the last', () => {
    expect(currentTodo(todos('completed', 'in_progress', 'pending'))?.content).toBe('t1');
    expect(currentTodo(todos('completed', 'pending', 'pending'))?.content).toBe('t1');
    expect(currentTodo(todos('completed', 'completed'))?.content).toBe('t1');
    expect(currentTodo([])).toBeUndefined();
  });
});
