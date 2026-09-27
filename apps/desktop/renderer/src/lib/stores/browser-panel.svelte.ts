import {
  openBrowserTab,
  closeBrowserTab,
  setActiveBrowserTab,
  setBrowserPanelVisible,
  setBrowserViewport,
  setBrowserTakeover,
  browserHistory,
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
const WIDTH_KEY = 'flaxeo.browserPanel.width';

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= 360 ? value : 600;
  } catch {
    return 600;
  }
}

class BrowserPanelStore {
  open = $state(false);
  tabs = $state<BrowserPanelTab[]>([]);
  activeTabId = $state<string | null>(null);
  addressInput = $state('');
  viewport = $state<BrowserViewportPreset>('fit');
  /** An agent used the browser in the last few seconds (pushed by main). */
  agentDriving = $state(false);
  /** The user took control: main refuses agent actions until handed back. */
  userTakeover = $state(false);
  /** Panel width in px, remembered across launches. */
  width = $state(readWidth());
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
      this.agentDriving = !!state.agentDriving;
      this.userTakeover = !!state.takeover;
      if (!state.tabs.length) {
        this.open = false;
        return;
      }
      // Main decides visibility: a page event after Hide must not bring the
      // frame back without its page.
      this.open = state.visible;
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
      else await browserNavigate(normalized, this.activeTabId).catch(() => {});
    } finally {
      this.loading = false;
    }
  }

  async selectTab(tabId: string) {
    await setActiveBrowserTab(tabId);
  }

  /** Pause agent actions on the browser until the user hands it back. */
  async setTakeover(on: boolean) {
    this.userTakeover = on;
    await setBrowserTakeover(on);
  }

  async history(action: 'back' | 'forward' | 'reload') {
    await browserHistory(action, this.activeTabId || undefined).catch(() => {});
  }

  setWidth(px: number) {
    this.width = Math.round(Math.max(360, Math.min(px, Math.floor(window.innerWidth * 0.7))));
    try {
      localStorage.setItem(WIDTH_KEY, String(this.width));
    } catch {
      // Blocked storage: the width lasts for this session.
    }
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
