// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceLayoutStore } from './workspace-layout.svelte';
import { panelIds } from '$lib/components/layout/workspace-layout';
beforeEach(() => localStorage.clear());
describe('conversation workspace ownership', () => {
  it('restores independent visibility, placement and sizes after switching and restart', () => {
    const store = new WorkspaceLayoutStore(); store.selectScope('chat:a'); store.show('changes'); store.layout.rightWidth = 477;
    store.float('changes', { x: 80, y: 40, width: 350, height: 260 }, { x: 0, y: 0, width: 1200, height: 800 }); const first = store.snapshot();
    store.selectScope('chat:b'); expect(store.isOpen('changes')).toBe(false); store.show('plan'); store.layout.rightWidth = 311; store.save(); const second = store.snapshot();
    store.selectScope('chat:a'); expect(store.snapshot()).toEqual(first);
    const restored = new WorkspaceLayoutStore(); restored.selectScope('chat:b'); expect(restored.snapshot()).toEqual(second); restored.selectScope('chat:a'); expect(restored.snapshot()).toEqual(first);
  });
  it('migrates the old global layout into the first conversation only', () => {
    localStorage.setItem('agente.workspaceLayout', JSON.stringify({ version: 1, rightWidth: 492, open: ['changes'] }));
    const store = new WorkspaceLayoutStore(); store.selectScope('space:code'); store.selectScope('chat:a');
    expect(store.layout.rightWidth).toBe(492); expect(store.isOpen('changes')).toBe(true);
    store.selectScope('chat:b'); expect(store.isOpen('changes')).toBe(false); expect(store.layout.rightWidth).not.toBe(492);
  });
  it('background panel events update only their owner', () => {
    const store = new WorkspaceLayoutStore(); store.selectScope('chat:a'); store.show('changes'); store.forScope('chat:b', (owner) => owner.show('processes', 'bottom'));
    expect(store.scope).toBe('chat:a'); expect(store.isOpen('processes')).toBe(false); store.selectScope('chat:b'); expect(store.isOpen('processes')).toBe(true); expect(store.isOpen('changes')).toBe(false);
  });
  it('drops unavailable terminal IDs and invalid persisted panels', () => {
    localStorage.setItem('agente.workspaceLayout', JSON.stringify({ version: 2, scopes: { 'chat:a': { version: 1, right: { kind: 'group', id: 'g', panels: ['browser', 'terminal:dead', 'invalid'], active: 'browser' }, open: ['browser', 'terminal:dead'] } } }));
    const store = new WorkspaceLayoutStore(); store.selectScope('chat:a'); expect(panelIds(store.layout.right)).toEqual(['browser']); expect(store.layout.open).toEqual(['browser']);
  });
});
