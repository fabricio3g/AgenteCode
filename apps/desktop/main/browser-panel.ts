import { WebContentsView, session, shell } from 'electron';
import { getMainWindow } from './window-manager.ts';
import { BROWSER_VIEWPORTS, type BrowserViewportPreset } from '../shared/browser-viewports.ts';

export const AGENT_BROWSER_PARTITION = 'persist:agent-browser';
export const AGENT_BROWSER_MAX_TABS = 5;

export type AgentBrowserViewportPreset = BrowserViewportPreset;

/** One console line, uncaught exception or failed request seen in a tab. */
export interface PanelConsoleEntry {
  seq: number;
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  source: 'console' | 'exception' | 'network';
  text: string;
  at: number;
}

export interface PanelTab {
  id: string;
  view: WebContentsView;
  preset: AgentBrowserViewportPreset;
  debuggerAttached: boolean;
  /** Ring buffer of the last console / exception / network entries. */
  console: PanelConsoleEntry[];
  consoleSeq: number;
}

const CONSOLE_LIMIT = 200;

const tabs = new Map<string, PanelTab>();
let tabSeq = 0;
let activeTabId: string | null = null;
let panelVisible = false;
let panelBounds: { x: number; y: number; width: number; height: number } | null = null;
/** An agent tool touched the browser in the last few seconds. */
let agentDriving = false;
let agentDrivingTimer: ReturnType<typeof setTimeout> | null = null;
/** The user took control: agent actions are refused until they hand it back. */
let userTakeover = false;

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
    agentDriving,
    takeover: userTakeover,
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
  if (!entry || !panelVisible || !panelBounds || panelOccluded) return;
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
  // Rounded like the box it sits in, inside the right dock's card.
  (view as unknown as { setBorderRadius?: (radius: number) => void }).setBorderRadius?.(8);
  tabSeq += 1;
  const tab: PanelTab = { id: `btab-${Date.now()}-${tabSeq}`, view, preset: 'fit', debuggerAttached: false, console: [], consoleSeq: 0 };
  wireGuestEvents(tab);
  attachToMainWindow(view);
  // Attach before the first load so the page's console is captured from the start.
  void ensureDebugger(tab).catch(() => {});
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

function pushConsole(tab: PanelTab, entry: Omit<PanelConsoleEntry, 'seq' | 'at'>) {
  tab.consoleSeq += 1;
  tab.console.push({ ...entry, text: entry.text.slice(0, 2000), seq: tab.consoleSeq, at: Date.now() });
  if (tab.console.length > CONSOLE_LIMIT) tab.console.splice(0, tab.console.length - CONSOLE_LIMIT);
}

type CdpParams = Record<string, unknown>;

function onDebuggerMessage(tab: PanelTab, method: string, params: CdpParams) {
  if (method === 'Runtime.consoleAPICalled') {
    const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
    const text = args.map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? '')).join(' ');
    const type = String(params.type ?? 'log');
    const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type === 'debug' ? 'debug' : type === 'info' ? 'info' : 'log';
    pushConsole(tab, { level, source: 'console', text });
  } else if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    pushConsole(tab, { level: 'error', source: 'exception', text: details?.exception?.description ?? details?.text ?? 'Uncaught exception' });
  } else if (method === 'Network.loadingFailed') {
    if (params.canceled) return;
    pushConsole(tab, { level: 'error', source: 'network', text: `${String(params.errorText ?? 'Request failed')} (${String(params.type ?? 'request')})` });
  } else if (method === 'Network.responseReceived') {
    const response = params.response as { status?: number; url?: string } | undefined;
    if (response?.status && response.status >= 400) {
      pushConsole(tab, { level: 'error', source: 'network', text: `HTTP ${response.status} ${response.url ?? ''}` });
    }
  }
}

async function ensureDebugger(tab: PanelTab) {
  if (tab.debuggerAttached) return;
  const dbg = tab.view.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already attached/i.test(message)) throw err;
  }
  tab.debuggerAttached = true;
  dbg.on('message', (_event, method, params) => onDebuggerMessage(tab, method, params as CdpParams));
  for (const domain of ['Runtime.enable', 'Network.enable', 'Page.enable']) {
    await dbg.sendCommand(domain).catch(() => {});
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

// ── Hooks for the agent driver (browser-driver.ts) ─────────────────────

/** The tab an agent action targets: the given one, or the active one. */
export function panelTab(tabId?: string): PanelTab {
  return requireTab(tabId);
}

export function panelCdp<T>(tab: PanelTab, method: string, params?: Record<string, unknown>): Promise<T> {
  return cdp<T>(tab, method, params);
}

/** Record that an agent is using the browser; the flag clears after a quiet spell. */
export function panelMarkAgentDriving() {
  if (agentDrivingTimer) clearTimeout(agentDrivingTimer);
  if (!agentDriving) {
    agentDriving = true;
    pushState();
  }
  agentDrivingTimer = setTimeout(() => {
    agentDriving = false;
    agentDrivingTimer = null;
    pushState();
  }, 5000);
}

export function panelSetTakeover(on: boolean) {
  userTakeover = on;
  pushState();
  return { takeover: userTakeover };
}

export function panelIsTakenOver(): boolean {
  return userTakeover;
}

export function panelShow() {
  if (!panelVisible) {
    panelVisible = true;
    applyBounds();
    pushState();
  }
}

export async function panelHistory(action: 'back' | 'forward' | 'reload', tabId?: string) {
  const wc = requireTab(tabId).view.webContents;
  const history = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void } }).navigationHistory;
  if (action === 'reload') wc.reload();
  else if (action === 'back' && history?.canGoBack()) history.goBack();
  else if (action === 'forward' && history?.canGoForward()) history.goForward();
  pushState();
  return { ok: true };
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

/**
 * The page is a native view drawn above the app's DOM, so no z-index can put
 * a menu, dialog or tooltip over it. While one would, the renderer occludes
 * the panel: it gets a still of the page to show in its place and the live
 * view steps aside; un-occluding brings the live page back.
 */
let panelOccluded = false;

export async function panelSetOccluded(occluded: boolean): Promise<{ image: string | null }> {
  if (occluded === panelOccluded) return { image: null };
  let image: string | null = null;
  const entry = activeTabId ? tabs.get(activeTabId) : null;
  if (occluded && entry && panelVisible) {
    try {
      image = (await entry.view.webContents.capturePage()).toDataURL();
    } catch { /* no still: the box just shows empty for a moment */ }
  }
  panelOccluded = occluded;
  applyBounds();
  return { image };
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
  // A fixed-size preset rescales to the new panel size.
  const active = activeTabId ? tabs.get(activeTabId) : null;
  if (active && active.preset !== 'fit') void panelSetViewport(active.preset, active.id).catch(() => {});
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
  tab.preset = preset;
  await ensureDebugger(tab);
  if (preset === 'fit') {
    // Responsive: the page gets the panel's own size.
    await cdp(tab, 'Emulation.clearDeviceMetricsOverride', {});
    await cdp(tab, 'Emulation.setUserAgentOverride', { userAgent: tab.view.webContents.session.getUserAgent() }).catch(() => {});
    await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    pushState();
    return { preset };
  }
  const config = BROWSER_VIEWPORTS[preset] ?? BROWSER_VIEWPORTS.desktop;
  // Real size (Desktop used to just clear the override and render at the
  // ~600px panel width), scaled down so the whole page fits the panel.
  const fit = panelBounds ? Math.min(1, panelBounds.width / config.width, panelBounds.height / config.height) : 1;
  await cdp(tab, 'Emulation.setDeviceMetricsOverride', {
    width: config.width,
    height: config.height,
    deviceScaleFactor: config.mobile ? 2 : 1,
    mobile: config.mobile,
    scale: Math.max(0.1, Math.round(fit * 1000) / 1000)
  });
  await cdp(tab, 'Emulation.setUserAgentOverride', {
    userAgent: config.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : tab.view.webContents.session.getUserAgent()
  }).catch(() => {});
  await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: config.mobile }).catch(() => {});
  pushState();
  return { preset, ...config };
}
