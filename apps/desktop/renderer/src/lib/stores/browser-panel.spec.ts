// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPanelStore } from './browser-panel.svelte';
import type { BrowserPanelState } from '$lib/services/browser';
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn().mockResolvedValue(() => {}), isElectron: () => true }));
vi.mock('$lib/services/bridge', () => bridge);
const state = (scope: string, url: string): BrowserPanelState => ({ scope, activeTabId: scope, tabs: [{ id: scope, url, title: url, preset: 'fit' }], visible: true });
beforeEach(() => { vi.clearAllMocks(); bridge.invoke.mockImplementation(async (_name, args) => ({ scope: args.scope, activeTabId: null, tabs: [], visible: false })); });
describe('browser conversation ownership', () => {
  it('ignores background updates and restores the owning tabs and takeover', async () => {
    const store = new BrowserPanelStore(); await store.selectScope('chat:a'); store.receive({ ...state('chat:a', 'https://a.test'), takeover: true }); store.receive(state('chat:b', 'https://b.test'));
    expect(store.activeTab?.url).toBe('https://a.test'); expect(store.userTakeover).toBe(true);
    bridge.invoke.mockImplementation(async (_name, args) => state(args.scope, `https://${args.scope.slice(5)}.test`)); await store.selectScope('chat:b'); expect(store.activeTab?.url).toBe('https://b.test');
    bridge.invoke.mockImplementation(async () => ({ ...state('chat:a', 'https://a.test'), takeover: true })); await store.selectScope('chat:a'); expect(store.activeTab?.id).toBe('chat:a'); expect(store.userTakeover).toBe(true);
  });
  it('a late selection response cannot replace the active conversation', async () => {
    let finish!: (value: BrowserPanelState) => void; bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const store = new BrowserPanelStore(); const pending = store.selectScope('chat:a'); await store.selectScope('chat:b'); store.receive(state('chat:b', 'https://b.test')); finish(state('chat:a', 'https://a.test')); await pending;
    expect(store.scope).toBe('chat:b'); expect(store.activeTab?.url).toBe('https://b.test');
  });
  it('captures the owner before async navigation and leaves the new chat chrome alone', async () => {
    const store = new BrowserPanelStore(); await store.selectScope('chat:a'); let finish!: (value: unknown) => void; bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.openUrl('localhost:5173'); await store.selectScope('chat:b'); store.receive(state('chat:b', 'https://b.test')); finish({ id: 'a-tab' }); await pending;
    expect(bridge.invoke).toHaveBeenCalledWith('browser_open_tab', { scope: 'chat:a', url: 'http://localhost:5173' }); expect(store.addressInput).toBe('https://b.test'); expect(store.loading).toBe(false);
    await store.hide(); expect(bridge.invoke).toHaveBeenLastCalledWith('browser_panel_visible', { scope: 'chat:b', visible: false });
  });
  it('lets two live pane handles receive and navigate their own browser', async () => {
    const store = new BrowserPanelStore(); const a = store.forScope('chat:a'), b = store.forScope('chat:b');
    await Promise.resolve(); await Promise.resolve();
    store.receive(state('chat:a', 'https://a.test')); store.receive(state('chat:b', 'https://b.test'));
    expect(a.activeTab?.url).toBe('https://a.test'); expect(b.activeTab?.url).toBe('https://b.test');
    await a.openUrl('https://new-a.test');
    expect(bridge.invoke).toHaveBeenLastCalledWith('browser_open_tab', { scope: 'chat:a', url: 'https://new-a.test' });
    await a.hide(); expect(a.open).toBe(false); expect(b.open).toBe(true);
  });

});
