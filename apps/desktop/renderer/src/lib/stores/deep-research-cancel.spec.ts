// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    invokes: [] as Array<{ command: string; args?: Record<string, unknown> }>,
    handlers: new Map<string, (args?: Record<string, unknown>) => Promise<unknown>>(),
    listeners,
    emit(channel: string, payload: unknown) {
      for (const fn of listeners.get(channel) ?? []) fn(payload);
    }
  };
});

vi.mock('$lib/services/bridge', () => ({
  isElectron: () => true,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    bridge.invokes.push({ command, args });
    const handler = bridge.handlers.get(command);
    if (handler) return handler(args);
    return undefined;
  },
  listen: async (channel: string, cb: (payload: unknown) => void) => {
    const list = bridge.listeners.get(channel) ?? [];
    list.push(cb);
    bridge.listeners.set(channel, list);
    return () => {
      bridge.listeners.set(channel, (bridge.listeners.get(channel) ?? []).filter((fn) => fn !== cb));
    };
  }
}));

vi.mock('$lib/services/chat-api', () => ({
  completeAssistantReply: vi.fn(async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    const system = messages[0]?.content ?? '';
    if (system.includes('clarifying options')) {
      return { content: JSON.stringify({ questions: [{ q: 'Scope?', h: 'Timeframe', a: 'Focus on 2026 changes only' }] }) };
    }
    if (system.includes('search query planner')) {
      return { content: 'sub query one' };
    }
    return { content: 'Synthesized report.' };
  }),
  extractJsonFromResponse: (raw: string) => {
    try { return { parsed: true, data: JSON.parse(raw) }; } catch { return { parsed: false, data: null }; }
  }
}));

import { deepResearchStore } from './deep-research.svelte';

describe('DeepResearchStore cancellation and operation-scoped progress (#30)', () => {
  beforeEach(() => {
    localStorage.clear();
    bridge.invokes.length = 0;
    bridge.handlers.clear();
    bridge.listeners.clear();
    deepResearchStore.destroy();
    deepResearchStore.tasks = [];
    deepResearchStore.activeTaskId = null;
  });

  it('invokes search_cancel for active operations on Stop and ignores late progress from a stopped job', async () => {
    const job1Ops: string[] = [];
    const job1Rejects: Array<(err: unknown) => void> = [];
    const job2Ops: string[] = [];
    const job2Resolves: Array<(val: unknown) => void> = [];

    bridge.handlers.set('web_search', (args) => {
      const opId = String(args?.operationId || '');
      const query = String(args?.query || '');
      if (query.includes('second topic') || job2Ops.length > 0 || deepResearchStore.tasks[0]?.query === 'second topic') {
        job2Ops.push(opId);
        return new Promise((resolve) => { job2Resolves.push(resolve); });
      }
      job1Ops.push(opId);
      return new Promise((_resolve, reject) => { job1Rejects.push(reject); });
    });
    bridge.handlers.set('search_cancel', async () => ({ cancelled: 1 }));
    bridge.handlers.set('crawl_web', async () => ({
      results: [],
      context: '',
      stats: { pages_crawled: 0, pages_discovered: 0, truncated: false, max_depth_reached: 0 }
    }));

    const firstPromise = deepResearchStore.runTask({
      chatId: 'c1',
      messageId: 'm1',
      chatTitle: 'Job 1',
      query: 'first topic',
      mode: 'deep'
    });

    await vi.waitFor(() => expect(deepResearchStore.tasks[0]?.status).toBe('awaiting_input'));
    const task1Id = deepResearchStore.tasks[0]!.id;
    deepResearchStore.submitTaskAnswers(task1Id, {}, true);

    await vi.waitFor(() => expect(job1Ops.length).toBeGreaterThan(0));
    const firstOpId = job1Ops[0]!;
    deepResearchStore.cancelTask(task1Id);
    for (const rej of job1Rejects) rej(new DOMException('Aborted', 'AbortError'));
    await expect(firstPromise).rejects.toThrow();

    const cancelCall = bridge.invokes.find((call) => call.command === 'search_cancel');
    expect(cancelCall?.args?.operationIds).toContain(firstOpId);

    // Start a second research job in the same window.
    const secondPromise = deepResearchStore.runTask({
      chatId: 'c1',
      messageId: 'm2',
      chatTitle: 'Job 2',
      query: 'second topic',
      mode: 'deep'
    });

    await vi.waitFor(() => expect(deepResearchStore.tasks[0]?.id).not.toBe(task1Id));
    const task2Id = deepResearchStore.tasks[0]!.id;
    deepResearchStore.submitTaskAnswers(task2Id, {}, true);
    await vi.waitFor(() => expect(job2Ops.length).toBeGreaterThan(0));
    const secondOpId = job2Ops[0]!;

    // Deliver late progress for the stopped first job and an unrelated window search: neither should hit Job 2.
    bridge.emit('search-progress', { step: 'fetching_page', detail: 'Stale job 1 page', operationId: firstOpId });
    bridge.emit('search-progress', { step: 'fetching_page', detail: 'Unrelated search', operationId: 'other-op' });
    bridge.emit('search-progress', { step: 'fetching_page', detail: 'Legit job 2 page', operationId: secondOpId });

    const task2 = deepResearchStore.tasks.find((t) => t.id === task2Id)!;
    const details = task2.progressLog.map((entry) => entry.detail);
    expect(details).not.toContain('Stale job 1 page');
    expect(details).not.toContain('Unrelated search');
    expect(details).toContain('Legit job 2 page');

    for (const resolve of job2Resolves) resolve({ results: [], context: '', provider_used: 'aggregator' });
    await secondPromise;
  });
});
