// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
import { parseWorkspaceLayout } from '$lib/components/layout/workspace-layout';
import { CodeWorkspaceStore } from './workspace.svelte';

const bridge = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('$lib/services/bridge', () => bridge);
const plan = { title: 'Plan', path: '.agente/plans/plan.md', body: '# Plan\nDo the work.' };
beforeEach(() => { localStorage.clear(); workspaceLayout.layouts = {}; workspaceLayout.selectScope('chat:a'); workspaceLayout.layout = parseWorkspaceLayout(null); vi.clearAllMocks(); });

describe('workspace panel lifecycle', () => {
  it('keeps a dismissed plan closed across conversations and restart, and allows reopening', () => {
    const store = new CodeWorkspaceStore();
    store.offerPlan('a', plan); expect(workspaceLayout.isOpen('plan')).toBe(true);
    store.closePlan(); store.offerPlan('b', plan); expect(workspaceLayout.isOpen('plan')).toBe(false);
    workspaceLayout.selectScope('chat:b'); store.closePlan(); workspaceLayout.selectScope('chat:a'); store.offerPlan('a', plan);
    expect(workspaceLayout.isOpen('plan')).toBe(false);
    const restored = new CodeWorkspaceStore(); restored.offerPlan('a', plan);
    expect(workspaceLayout.isOpen('plan')).toBe(false);
    restored.togglePlan('a', plan); expect(restored.plan).toEqual({ chatId: 'a', plan });
    restored.closePlan(); workspaceLayout.selectScope('chat:b'); restored.togglePlan('b', null);
    expect(restored.plan).toEqual({ chatId: 'b', plan: null });
    restored.closePlan(); workspaceLayout.selectScope('chat:a'); restored.offerPlan('a', { ...plan, body: 'Revised plan' });
    expect(workspaceLayout.isOpen('plan')).toBe(true);
  });
  it('hides a terminal and running process without killing them; termination stays explicit', async () => {
    const store = new CodeWorkspaceStore();
    store.terminals = [{ id: 'test', title: 'Shell', cwd: '/project', scope: 'chat:a', exited: false }];
    store.processes = [{ id: 'p', chatId: 'a', command: 'server', cwd: '/project', status: 'running' }] as typeof store.processes;
    store.showBottom('terminal:test'); store.showBottom('processes');
    await store.toggleBottom('terminal', '/project'); await store.toggleBottom('processes', '/project');
    expect(store.terminals).toHaveLength(1); expect(store.runningCount('a')).toBe(1); expect(bridge.invoke).not.toHaveBeenCalled();
    store.closeTerminal('test'); expect(bridge.invoke).toHaveBeenCalledWith('terminal_kill', { id: 'test' });
    expect(workspaceLayout.has('terminal:test')).toBe(false);
  });
  it('keeps a terminal with its creator while creation is pending', async () => {
    const store = new CodeWorkspaceStore(); let finish!: (value: { id: string; shell: string }) => void;
    bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.newTerminal('/project/a'); workspaceLayout.selectScope('chat:b'); finish({ id: 'owned', shell: 'bash' }); await pending;
    expect(store.terminalsForScope()).toHaveLength(0); expect(workspaceLayout.isOpen('terminal:owned')).toBe(false);
    workspaceLayout.selectScope('chat:a'); expect(store.terminalsForScope()[0].id).toBe('owned'); expect(workspaceLayout.isOpen('terminal:owned')).toBe(true);
  });

});
