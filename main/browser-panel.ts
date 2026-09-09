import { WebContentsView, session, shell } from 'electron';
import { getMainWindow } from './window-manager.ts';

export const AGENT_BROWSER_PARTITION = 'persist:agent-browser';
export const AGENT_BROWSER_MAX_TABS = 5;

export type AgentBrowserViewportPreset = 'desktop' | 'laptop' | 'tablet' | 'mobile';

export const AGENT_BROWSER_VIEWPORTS: Record<
  AgentBrowserViewportPreset,
  { width: number; height: number; mobile: boolean; label: string }
> = {
  desktop: { width: 1280, height: 720, mobile: false, label: 'Desktop' },
  laptop: { width: 1440, height: 900, mobile: false, label: 'Laptop' },
  tablet: { width: 834, height: 1112, mobile: true, label: 'Tablet' },
  mobile: { width: 390, height: 844, mobile: true, label: 'Mobile' }
};

interface PanelTab {
  id: string;
  view: WebContentsView;
  preset: AgentBrowserViewportPreset;
  debuggerAttached: boolean;
}

const tabs = new Map<string, PanelTab>();
let tabSeq = 0;
let activeTabId: string | null = null;
let panelVisible = false;
let panelBounds: { x: number; y: number; width: number; height: number } | null = null;

function guestSession() {
  return session.fromPartition(AGENT_BROWSER_PARTITION);
}

function hardenGuestSession() {
  const ses = guestSession();
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const anySes = ses as unknown as Record<string, unknown>;
  if (typeof anySes['setDevicePermissionHandler'] === 'function') {
    (anySes['setDevicePermissionHandler'] as (h: () => boolean) => void)(() => false);
  }
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        callback({ cancel: true });
        return;
      }
    } catch {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });
}

function pushState() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('browser_panel_state', {
    visible: panelVisible,
    activeTabId,
    tabs: [...tabs.values()].map((t) => ({
      id: t.id,
      url: safeUrl(t.view),
      title: safeTitle(t.view),
      preset: t.preset
    }))
  });
}

function safeUrl(tab: PanelTab): string;
function safeUrl(view: WebContentsView): string;
function safeUrl(target: PanelTab | WebContentsView): string {
  try {
    const wc = 'view' in target ? target.view.webContents : target.webContents;
    return wc.getURL() || '';
  } catch {
    return '';
  }
}

function safeTitle(view: WebContentsView): string {
  try {
    return view.webContents.getTitle() || '';
  } catch {
    return '';
  }
}

function attachToMainWindow(view: WebContentsView) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) throw new Error('Main window not available');
  const contentView = (win as unknown as { contentView: { addChildView: (v: unknown) => void } }).contentView;
  contentView.addChildView(view);
}

function applyBounds() {
  const entry = activeTabId ? tabs.get(activeTabId) : null;
  for (const tab of tabs.values()) {
    try {
      tab.view.setVisible(false);
    } catch { /* ignore */ }
  }
  if (!entry || !panelVisible || !panelBounds) return;
  try {
    entry.view.setBounds({ ...panelBounds });
    entry.view.setVisible(true);
  } catch { /* ignore */ }
}

function wireGuestEvents(tab: PanelTab) {
  const wc = tab.view.webContents;
  const refresh = () => pushState();
  wc.on('did-navigate', refresh);
  wc.on('did-navigate-in-page', refresh);
  wc.on('did-finish-load', refresh);
  wc.on('did-fail-load', refresh);
  wc.on('did-start-loading', refresh);
  wc.on('did-stop-loading', refresh);
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url).catch(() => {});
      }
    } catch { /* ignore */ }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  wc.on('will-frame-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
}

function createTab(url?: string): PanelTab {
  hardenGuestSession();
  const view = new WebContentsView({
    webPreferences: {
      partition: AGENT_BROWSER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  try {
    (view.webContents as unknown as { setAudioMuted?: (m: boolean) => void }).setAudioMuted?.(false);
  } catch { /* ignore */ }
  tabSeq += 1;
  const tab: PanelTab = { id: `btab-${Date.now()}-${tabSeq}`, view, preset: 'desktop', debuggerAttached: false };
  wireGuestEvents(tab);
  attachToMainWindow(view);
  tabs.set(tab.id, tab);
  activeTabId = tab.id;
  if (url) {
    void view.webContents.loadURL(url).catch(() => {});
  }
  applyBounds();
  pushState();
  return tab;
}

function requireTab(tabId?: string): PanelTab {
  const id = tabId || activeTabId || '';
  const tab = tabs.get(id);
  if (!tab) throw new Error('No browser tab open');
  return tab;
}

async function ensureDebugger(tab: PanelTab) {
  if (tab.debuggerAttached) return;
  try {
    tab.view.webContents.debugger.attach('1.3');
    tab.debuggerAttached = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already attached/i.test(message)) throw err;
    tab.debuggerAttached = true;
  }
}

async function cdp<T>(tab: PanelTab, method: string, params?: Record<string, unknown>): Promise<T> {
  await ensureDebugger(tab);
  return tab.view.webContents.debugger.sendCommand(method, params) as Promise<T>;
}

const SNAPSHOT_EXPR = `(() => ({
  url: location.href,
  title: document.title,
  text: document.body?.innerText?.slice(0, 10000) || '',
  links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
    text: a.innerText?.trim().slice(0, 100) || '',
    href: a.href
  })),
  inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 30).map((el, i) => ({
    index: i,
    kind: el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''),
    name: el.name || '',
    placeholder: el.placeholder || ''
  })),
  buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0, 30).map((el, i) => ({
    index: i,
    text: (el.innerText?.trim().slice(0, 100) || el.value || '')
  }))
}))()`;

async function readSnapshot(tab: PanelTab) {
  const result = await cdp<{ result?: { value?: unknown } }>(tab, 'Runtime.evaluate', {
    expression: SNAPSHOT_EXPR,
    returnByValue: true
  });
  return result.result?.value ?? null;
}

export function panelOpenTab(url?: string) {
  if (url && typeof url === 'string') {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs allowed');
    }
  }
  if (tabs.size >= AGENT_BROWSER_MAX_TABS) {
    const oldest = [...tabs.values()][0];
    if (oldest) closeTabEntry(oldest.id);
  }
  panelVisible = true;
  const tab = createTab(url);
  return { id: tab.id, url: url || '' };
}

export function panelListTabs() {
  return [...tabs.values()].map((t) => ({ id: t.id, url: safeUrl(t), title: safeTitle(t.view), preset: t.preset }));
}

export function panelSetActive(tabId: string) {
  if (!tabs.has(tabId)) throw new Error('Unknown browser tab');
  activeTabId = tabId;
  applyBounds();
  pushState();
  return { id: tabId };
}

function closeTabEntry(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  try {
    if (tab.debuggerAttached) tab.view.webContents.debugger.detach();
  } catch { /* ignore */ }
  tab.debuggerAttached = false;
  try {
    const win = getMainWindow();
    const contentView = win as unknown as { contentView?: { removeChildView?: (v: unknown) => void } } | null;
    contentView?.contentView?.removeChildView?.(tab.view);
  } catch { /* ignore */ }
  try {
    tab.view.webContents.close();
  } catch { /* ignore */ }
  tabs.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = [...tabs.keys()].pop() || null;
  }
  if (!tabs.size) panelVisible = false;
}

export function panelCloseTab(tabId?: string) {
  const tab = requireTab(tabId);
  closeTabEntry(tab.id);
  applyBounds();
  pushState();
  return { closed: tab.id };
}

export function panelCloseAll() {
  for (const id of [...tabs.keys()]) closeTabEntry(id);
  activeTabId = null;
  panelVisible = false;
  pushState();
  return { closed: true };
}

export function panelSetVisible(visible: boolean) {
  panelVisible = visible;
  applyBounds();
  pushState();
  return { visible };
}

export function panelSetBounds(rect: { x: number; y: number; width: number; height: number }) {
  panelBounds = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(200, Math.round(rect.width)),
    height: Math.max(200, Math.round(rect.height))
  };
  applyBounds();
  return { ok: true };
}

export async function panelNavigate(url: string, tabId?: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs allowed');
  }
  panelVisible = true;
  const tab = tabId ? requireTab(tabId) : activeTabId ? requireTab(activeTabId) : createTab();
  activeTabId = tab.id;
  await tab.view.webContents.loadURL(url);
  applyBounds();
  pushState();
  return readSnapshot(tab);
}

export async function panelSnapshot(tabId?: string) {
  return readSnapshot(requireTab(tabId));
}

export async function panelClick(text: string, tabId?: string) {
  const tab = requireTab(tabId);
  const point = await cdp<{ result?: { value?: { x: number; y: number } | null } }>(tab, 'Runtime.evaluate', {
    expression: `(() => {
      const needle = ${JSON.stringify(String(text).toLowerCase())};
      const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
      const match = els.find(el => ((el.innerText || el.value || '').trim().toLowerCase().includes(needle)));
      if (!match) return null;
      const r = match.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
    returnByValue: true
  });
  const coords = point.result?.value;
  if (!coords) throw new Error('No matching control found');
  await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1200));
  return readSnapshot(tab);
}

export async function panelTypeText(selector: string, text: string, tabId?: string) {
  const tab = requireTab(tabId);
  await cdp(tab, 'Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.focus(); return !!el; })()`
  });
  await cdp(tab, 'Input.insertText', { text });
  return 'ok';
}

export async function panelEvaluate(script: string, tabId?: string) {
  const tab = requireTab(tabId);
  const result = await cdp<{ result?: { value?: unknown } }>(tab, 'Runtime.evaluate', {
    expression: String(script).slice(0, 20000),
    returnByValue: true
  });
  return String(result.result?.value ?? '');
}

export async function panelScreenshot(tabId?: string) {
  const tab = requireTab(tabId);
  const shot = await cdp<{ data?: string }>(tab, 'Page.captureScreenshot', { format: 'png' });
  return `data:image/png;base64,${shot.data || ''}`;
}

export function panelCurrentUrl(tabId?: string) {
  return safeUrl(requireTab(tabId));
}

export async function panelSetViewport(preset: AgentBrowserViewportPreset, tabId?: string) {
  const tab = requireTab(tabId);
  const config = AGENT_BROWSER_VIEWPORTS[preset] || AGENT_BROWSER_VIEWPORTS.desktop;
  tab.preset = preset;
  await ensureDebugger(tab);
  if (config.mobile) {
    await cdp(tab, 'Emulation.setDeviceMetricsOverride', {
      width: config.width,
      height: config.height,
      deviceScaleFactor: 2,
      mobile: true
    });
    await cdp(tab, 'Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: true });
  } else {
    await cdp(tab, 'Emulation.clearDeviceMetricsOverride', {});
    await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  }
  pushState();
  return { preset, ...config };
}
