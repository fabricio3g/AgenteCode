import { invoke, listen } from '$lib/services/bridge';

export type BrowserViewportPreset = 'desktop' | 'laptop' | 'tablet' | 'mobile';

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
}

export const BROWSER_VIEWPORTS: Record<BrowserViewportPreset, { width: number; height: number; mobile: boolean; label: string }> = {
  desktop: { width: 1280, height: 720, mobile: false, label: 'Desktop' },
  laptop: { width: 1440, height: 900, mobile: false, label: 'Laptop' },
  tablet: { width: 834, height: 1112, mobile: true, label: 'Tablet' },
  mobile: { width: 390, height: 844, mobile: true, label: 'Mobile' }
};

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

export async function browserNavigate(url: string, tabId?: string): Promise<unknown> {
  return invoke('browser_navigate', { url, tabId });
}

export function onBrowserPanelState(handler: (state: BrowserPanelState) => void): Promise<() => void> {
  return listen<BrowserPanelState>('browser_panel_state', handler);
}
