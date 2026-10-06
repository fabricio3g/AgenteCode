import {
  selectBrowserScope,
  getBrowserState,
  openBrowserTab,
  closeBrowserTab,
  setActiveBrowserTab,
  setBrowserPanelVisible,
  setBrowserViewport,
  setBrowserTakeover,
  browserHistory,
  browserNavigate,
  onBrowserPanelState,
  type BrowserPanelState,
  type BrowserPanelTab,
  type BrowserViewportPreset
} from '$lib/services/browser';
import { conversationScope } from '$shared/workspace-scope';
import { isElectron } from '$lib/services/bridge';

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/**
 * Floating agent browser panel store.
 *
 * Owns panel chrome state (tabs, address bar, viewport preset,
 * takeover). The page itself lives in a main-process WebContentsView;
 * this store never touches guest content.
 */
export class BrowserPanelStore {
  scope = $state('unassigned');
  #states = new Map<string, BrowserPanelState>();
  #addresses = new Map<string, string>();
  #selection = 0;
  open = $state(false);
  tabs = $state<BrowserPanelTab[]>([]);
  activeTabId = $state<string | null>(null);
  addressInput = $state('');
  viewport = $state<BrowserViewportPreset>('fit');
  /** An agent used the browser in the last few seconds (pushed by main). */
  agentDriving = $state(false);
  /** The user took control: main refuses agent actions until handed back. */
  userTakeover = $state(false);
  loading = $state(false);
  #subscribed = false;

  get activeTab(): BrowserPanelTab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  }

  init() {
    if (this.#subscribed || !isElectron()) return;
    this.#subscribed = true;
    void onBrowserPanelState((state) => this.receive(state));
  }

  #owners = new Map<string, BrowserPanelStore>();
  forScope(scope: string): BrowserPanelStore {
    let owner = this.#owners.get(scope);
    if (!owner) {
      owner = new BrowserPanelStore(); owner.scope = scope;
      this.#owners.set(scope, owner);
      if (isElectron()) void getBrowserState(scope).then((state) => owner!.receive(state)).catch(() => {});
    }
    return owner;
  }
  receive(state: BrowserPanelState) {
    this.#owners.get(state.scope)?.receive(state);
    this.#states.set(state.scope, state);
    if (state.scope !== this.scope) return;
    this.tabs = state.tabs; this.activeTabId = state.activeTabId;
    this.agentDriving = !!state.agentDriving; this.userTakeover = !!state.takeover;
    this.open = state.visible;
    const active = this.activeTab;
    if (active && document.activeElement?.id !== 'browser-address-input') this.addressInput = active.url;
    this.viewport = active?.preset ?? 'fit';
  }

  async selectScope(scope: string) {
    if (scope === this.scope) return;
    this.#addresses.set(this.scope, this.addressInput);
    this.scope = scope; this.loading = false;
    this.receive(this.#states.get(scope) ?? { scope, tabs: [], activeTabId: null, visible: false });
    this.addressInput = this.#addresses.get(scope) ?? this.activeTab?.url ?? '';
    const selection = ++this.#selection;
    if (!isElectron()) return;
    const state = await selectBrowserScope(scope).catch(() => null);
    if (state && this.#selection === selection && this.scope === scope) this.receive(state);
  }

  stopDriving(chatId: string) {
    const scope = conversationScope(chatId);
    const state = this.#states.get(scope);
    if (state) this.#states.set(scope, { ...state, agentDriving: false });
    if (this.scope === scope) this.agentDriving = false;
  }

  async openUrl(url: string) {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    const scope = this.scope;
    this.loading = true;
    try {
      const tab = await openBrowserTab(scope, normalized);
      if (this.scope === scope) this.addressInput = normalized;
      return tab;
    } finally {
      if (this.scope === scope) this.loading = false;
    }
  }

  async newTab() {
    const scope = this.scope;
    this.loading = true;
    try {
      await openBrowserTab(scope);
      if (this.scope === scope) this.addressInput = '';
    } finally {
      if (this.scope === scope) this.loading = false;
    }
  }

  async go() {
    const normalized = normalizeUrl(this.addressInput);
    if (!normalized) return;
    const scope = this.scope;
    this.loading = true;
    try {
      if (!this.activeTabId) await this.openUrl(normalized);
      else await browserNavigate(scope, normalized, this.activeTabId).catch(() => {});
    } finally {
      if (this.scope === scope) this.loading = false;
    }
  }

  async selectTab(tabId: string) {
    await setActiveBrowserTab(this.scope, tabId);
  }

  /** Pause agent actions on the browser until the user hands it back. */
  async setTakeover(on: boolean) {
    this.userTakeover = on;
    await setBrowserTakeover(this.scope, on);
  }

  async history(action: 'back' | 'forward' | 'reload') {
    await browserHistory(this.scope, action, this.activeTabId || undefined).catch(() => {});
  }

  async closeTab(tabId: string) {
    await closeBrowserTab(this.scope, tabId);
  }

  async hide() {
    const scope = this.scope;
    this.open = false;
    await setBrowserPanelVisible(scope, false);
  }

  async toggle() {
    if (this.open) {
      await this.hide();
      return;
    }
    if (!isElectron()) return;
    if (this.tabs.length) {
      this.open = true;
      await setBrowserPanelVisible(this.scope, true);
      return;
    }
    await this.newTab();
  }

  async setViewport(preset: BrowserViewportPreset) {
    this.viewport = preset;
    await setBrowserViewport(this.scope, preset, this.activeTabId || undefined);
  }
}

export const browserPanelStore = new BrowserPanelStore();
