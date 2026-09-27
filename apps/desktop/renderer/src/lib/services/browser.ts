import { invoke, listen } from '$lib/services/bridge';

import type { BrowserViewportPreset } from '$shared/browser-viewports';

export type { BrowserViewportPreset } from '$shared/browser-viewports';

export interface BrowserPanelTab {
  id: string;
  url: string;
  title: string;
  preset: BrowserViewportPreset;
}

export interface BrowserPanelState {
  visible: boolean;
  activeTabId: string | null;
  tabs: BrowserPanelTab[];
  /** An agent used the browser in the last few seconds. */
  agentDriving?: boolean;
  /** The user took control; agent actions are refused. */
  takeover?: boolean;
}

export async function openBrowserTab(url?: string): Promise<{ id: string; url: string }> {
  return invoke('browser_open_tab', { url });
}

export async function listBrowserTabs(): Promise<BrowserPanelTab[]> {
  return invoke('browser_list_tabs');
}

export async function setActiveBrowserTab(tabId: string): Promise<void> {
  await invoke('browser_set_active', { tabId });
}

export async function closeBrowserTab(tabId?: string): Promise<void> {
  await invoke('browser_close_tab', { tabId });
}

export async function closeAllBrowserTabs(): Promise<void> {
  await invoke('browser_close_all');
}

export async function setBrowserPanelVisible(visible: boolean): Promise<void> {
  await invoke('browser_panel_visible', { visible });
}

export async function syncBrowserPanelBounds(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  await invoke('browser_panel_bounds', rect);
}

export async function setBrowserViewport(preset: BrowserViewportPreset, tabId?: string): Promise<void> {
  await invoke('browser_viewport', { preset, tabId });
}

export async function setBrowserTakeover(on: boolean): Promise<void> {
  await invoke('browser_takeover', { on });
}

export async function browserHistory(action: 'back' | 'forward' | 'reload', tabId?: string): Promise<void> {
  await invoke('browser_history', { action, tabId });
}

export async function browserNavigate(url: string, tabId?: string): Promise<unknown> {
  return invoke('browser_navigate', { url, tabId });
}

export function onBrowserPanelState(handler: (state: BrowserPanelState) => void): Promise<() => void> {
  return listen<BrowserPanelState>('browser_panel_state', handler);
}
