import { invoke, listen } from '$lib/services/bridge';

import type { BrowserViewportPreset } from '$shared/browser-viewports';
import type { BrowserPresentation } from '$shared/browser-presentation';

export type { BrowserViewportPreset } from '$shared/browser-viewports';

export interface BrowserPanelTab {
  id: string;
  url: string;
  title: string;
  preset: BrowserViewportPreset;
}

export interface BrowserPanelState {
  scope: string;
  visible: boolean;
  activeTabId: string | null;
  tabs: BrowserPanelTab[];
  /** An agent used the browser in the last few seconds. */
  agentDriving?: boolean;
  /** The user took control; agent actions are refused. */
  takeover?: boolean;
}

export function selectBrowserScope(scope: string): Promise<BrowserPanelState> {
  return invoke('browser_select_scope', { scope });
}
export function openBrowserTab(scope: string, url?: string): Promise<{ id: string; url: string }> {
  return invoke('browser_open_tab', { scope, url });
}
export function getBrowserState(scope: string): Promise<BrowserPanelState> { return invoke('browser_get_state', { scope }); }
export async function setActiveBrowserTab(scope: string, tabId: string): Promise<void> {
  await invoke('browser_set_active', { scope, tabId });
}
export async function closeBrowserTab(scope: string, tabId?: string): Promise<void> {
  await invoke('browser_close_tab', { scope, tabId });
}
export async function setBrowserPanelVisible(scope: string, visible: boolean): Promise<void> {
  await invoke('browser_panel_visible', { scope, visible });
}
export async function syncBrowserPresentation(scope: string, presentation: BrowserPresentation): Promise<string | null> {
  const result = await invoke<{ image: string | null }>('browser_panel_presentation', { scope, ...presentation });
  return result?.image ?? null;
}
export async function setBrowserViewport(scope: string, preset: BrowserViewportPreset, tabId?: string): Promise<void> {
  await invoke('browser_viewport', { scope, preset, tabId });
}
export async function setBrowserTakeover(scope: string, on: boolean): Promise<void> {
  await invoke('browser_takeover', { scope, on });
}
export async function browserHistory(scope: string, action: 'back' | 'forward' | 'reload', tabId?: string): Promise<void> {
  await invoke('browser_history', { scope, action, tabId });
}
export function browserNavigate(scope: string, url: string, tabId?: string): Promise<unknown> {
  return invoke('browser_navigate', { scope, url, tabId });
}

export function onBrowserPanelState(handler: (state: BrowserPanelState) => void): Promise<() => void> {
  return listen<BrowserPanelState>('browser_panel_state', handler);
}
