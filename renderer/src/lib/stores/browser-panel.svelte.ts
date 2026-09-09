import {
  openBrowserTab,
  closeBrowserTab,
  setActiveBrowserTab,
  setBrowserPanelVisible,
  setBrowserViewport,
  browserNavigate,
  onBrowserPanelState,
  type BrowserPanelTab,
  type BrowserViewportPreset
} from '$lib/services/browser';
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
class BrowserPanelStore {
  open = $state(false);
  tabs = $state<BrowserPanelTab[]>([]);
  activeTabId = $state<string | null>(null);
  addressInput = $state('');
  viewport = $state<BrowserViewportPreset>('desktop');
  /** Agent currently driving the active tab. */
  agentDriving = $state(false);
  /** User took manual control; agent input paused on active tab. */
  userTakeover = $state(false);
  loading = $state(false);
  #subscribed = false;

  get activeTab(): BrowserPanelTab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  }

  init() {
    if (this.#subscribed || !isElectron()) return;
    this.#subscribed = true;
    void onBrowserPanelState((state) => {
      this.tabs = state.tabs;
      this.activeTabId = state.activeTabId;
      if (!state.tabs.length) {
        this.open = false;
        this.agentDriving = false;
        return;
      }
      this.open = true;
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      if (active && document.activeElement?.id !== 'browser-address-input') {
        this.addressInput = active.url;
      }
      const preset = active?.preset;
      if (preset) this.viewport = preset;
    });
  }

  async openUrl(url: string) {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    this.loading = true;
    try {
      const tab = await openBrowserTab(normalized);
      this.addressInput = normalized;
      this.userTakeover = false;
      return tab;
    } finally {
      this.loading = false;
    }
  }

  async newTab() {
    this.loading = true;
    try {
      await openBrowserTab();
      this.addressInput = '';
      this.userTakeover = false;
    } finally {
      this.loading = false;
    }
  }

  async go() {
    const normalized = normalizeUrl(this.addressInput);
    if (!normalized) return;
    this.loading = true;
    try {
      if (!this.activeTabId) await this.openUrl(normalized);
      else await browserNavigate(normalized, this.activeTabId);
      this.userTakeover = true;
    } finally {
      this.loading = false;
    }
  }

  async selectTab(tabId: string) {
    await setActiveBrowserTab(tabId);
    this.userTakeover = true;
  }

  async closeTab(tabId: string) {
    await closeBrowserTab(tabId);
  }

  async hide() {
    await setBrowserPanelVisible(false);
    this.open = false;
  }

  async toggle() {
    if (this.open) {
      await this.hide();
      return;
    }
    if (!isElectron()) return;
    if (this.tabs.length) {
      this.open = true;
      await setBrowserPanelVisible(true);
      return;
    }
    await this.newTab();
  }

  async setViewport(preset: BrowserViewportPreset) {
    this.viewport = preset;
    await setBrowserViewport(preset, this.activeTabId || undefined);
  }
}

export const browserPanelStore = new BrowserPanelStore();
