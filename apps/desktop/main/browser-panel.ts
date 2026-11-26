import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isWorkspaceScope } from '../shared/workspace-scope.ts';
import { getMainWindow } from './window-manager.ts';
import { BROWSER_VIEWPORTS, type BrowserViewportPreset } from '../shared/browser-viewports.ts';
import { debuggerConsoleMessage, type BrowserConsoleMessage } from './browser-console.ts';
import { browserPointerScript } from './browser-pointer.ts';
import { browserViewBounds, sameBrowserBounds, type BrowserPresentation } from '../shared/browser-presentation.ts';

const AGENT_BROWSER_PARTITION = 'persist:agent-browser';
const AGENT_BROWSER_MAX_TABS = 5;

export type AgentBrowserViewportPreset = BrowserViewportPreset;

/** One console line, uncaught exception or failed request seen in a tab. */
export interface PanelConsoleEntry extends BrowserConsoleMessage {
  seq: number;
  at: number;
}

export interface PanelTab {
  scope: string;
  id: string;
  view: WebContentsView;
  preset: AgentBrowserViewportPreset;
  debuggerAttached: boolean;
  /** Target URL while an initial/pending navigation has not yet committed. */
  pendingUrl?: string;
  /** True while the active tab navigation is in progress. */
  loading: boolean;
  /** Last main-frame load failure message, cleared on next navigation. */
  loadError?: string;
  /** Ring buffer of the last console / exception / network entries. */
  console: PanelConsoleEntry[];
  consoleSeq: number;
  viewportVersion?: number;
  /** Settles once the view holds a document; emulation must wait for it. */
  firstLoad?: Promise<void>;
}

const CONSOLE_LIMIT = 200;

type BrowserOwner = {
  host?: BrowserWindow;
  tabs: Map<string, PanelTab>;
  activeTabId: string | null;
  panelVisible: boolean;
  panelExposed: boolean;
  panelBounds: { x: number; y: number; width: number; height: number } | null;
  panelOccluded: boolean;
  agentDriving: boolean;
  agentDrivingTimer: ReturnType<typeof setTimeout> | null;
  userTakeover: boolean;
};
const owners = new Map<string, BrowserOwner>();
const hardenedSessions = new Set<string>();
const scopeContext = new AsyncLocalStorage<string>();
let foregroundScope = 'unassigned';
let tabSeq = 0;
export function browserScope(): string { return scopeContext.getStore() ?? foregroundScope; }
export function withBrowserScope<T>(scope: string, run: () => T): T {
  if (!isWorkspaceScope(scope)) throw new Error('Browser conversation is required');
  return scopeContext.run(scope, run);
}
function state(scope = browserScope()): BrowserOwner {
  let owner = owners.get(scope);
  if (!owner) {
    owner = { tabs: new Map(), activeTabId: null, panelVisible: false, panelExposed: scope === 'unassigned', panelBounds: null, panelOccluded: false, agentDriving: false, agentDrivingTimer: null, userTakeover: false };
    owners.set(scope, owner);
  }
  return owner;
}
function partition(scope = browserScope()): string {
  return scope === 'unassigned' ? AGENT_BROWSER_PARTITION : `${AGENT_BROWSER_PARTITION}-${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`;
}

function guestSession() {
  return session.fromPartition(partition());
}

function hardenGuestSession() {
  const part = partition();
  if (hardenedSessions.has(part)) return;
  hardenedSessions.add(part);
  const ses = session.fromPartition(part);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const anySes = ses as unknown as Record<string, unknown>;
  if (typeof anySes['setDevicePermissionHandler'] === 'function') {
    (anySes['setDevicePermissionHandler'] as (h: () => boolean) => void)(() => false);
  }
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const protocol = new URL(details.url).protocol;
      if (
        protocol === 'http:' ||
        protocol === 'https:' ||
        protocol === 'data:' ||
        protocol === 'blob:' ||
        protocol === 'ws:' ||
        protocol === 'wss:' ||
        protocol === 'about:'
      ) {
        callback({ cancel: false });
        return;
      }
    } catch {
      // cancel invalid URLs
    }
    callback({ cancel: true });
  });
}

export function panelState(scope = browserScope()) {
  const owner = state(scope);
  return {
    scope, visible: owner.panelVisible, activeTabId: owner.activeTabId, agentDriving: owner.agentDriving, takeover: owner.userTakeover,
    tabs: [...owner.tabs.values()].map((t) => ({ id: t.id, url: safeUrl(t), title: safeTitle(t.view), preset: t.preset, loading: t.loading, ...(t.loadError ? { error: t.loadError } : {}) }))
  };
}
function pushState(scope = browserScope()) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('browser_panel_state', panelState(scope));
}

function safeUrl(tab: PanelTab): string;
function safeUrl(view: WebContentsView): string;
function safeUrl(target: PanelTab | WebContentsView): string {
  try {
    const wc = 'view' in target ? target.view.webContents : target.webContents;
    const url = wc.getURL();
    if (url && url !== 'about:blank') return url;
    return 'pendingUrl' in target && target.pendingUrl ? target.pendingUrl : '';
  } catch {
    return 'pendingUrl' in target && target.pendingUrl ? target.pendingUrl : '';
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
  const win = state().host ?? getMainWindow();
  if (!win || win.isDestroyed()) throw new Error('Main window not available');
  const contentView = (win as unknown as { contentView: { addChildView: (v: unknown) => void } }).contentView;
  contentView.addChildView(view);
}

function applyBounds() {
  for (const owner of owners.values()) {
  const entry = owner.activeTabId ? owner.tabs.get(owner.activeTabId) : null;
  const live = !!entry && owner.panelVisible && owner.panelExposed && !!owner.panelBounds && !owner.panelOccluded;
  for (const tab of owner.tabs.values()) {
    try { if ((!live || tab !== entry) && tab.view.getVisible()) tab.view.setVisible(false); } catch { /* Guest may be closing. */ }
  }
  if (!entry || !live || !owner.panelBounds) continue;
  try {
    if (!sameBrowserBounds(entry.view.getBounds(), owner.panelBounds)) entry.view.setBounds({ ...owner.panelBounds });
    if (!entry.view.getVisible()) entry.view.setVisible(true);
  } catch { /* Guest may be closing. */ }
  }
}
export function panelSetHost(sender: WebContents, exposed = true): boolean {
  const host = BrowserWindow.fromWebContents(sender);
  if (!host) return false;
  const owner = state();
  if (owner.host === host) return true;
  if (!exposed) return false;
  for (const tab of owner.tabs.values()) {
    const previous = owner.host ?? getMainWindow();
    if (previous && !previous.isDestroyed()) previous.contentView.removeChildView(tab.view);
    host.contentView.addChildView(tab.view);
  }
  owner.host = host;
  host.once('closed', () => { if (owner.host === host) { owner.panelExposed = false; owner.host = undefined; applyBounds(); } });
  return true;
}
/** Only the renderer selects which conversation may present a live native view. */
export function panelSelectScope(scope: string) {
  if (!isWorkspaceScope(scope)) throw new Error('Browser conversation is required');
  if (foregroundScope !== scope) state(foregroundScope).panelExposed = false;
  foregroundScope = scope;
  state(scope).panelExposed = false;
  applyBounds(); pushState(scope);
  return panelState(scope);
}

function allowWebNavigation(event: { preventDefault(): void }, url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') event.preventDefault();
  } catch {
    event.preventDefault();
  }
}

function wireGuestEvents(tab: PanelTab) {
  const wc = tab.view.webContents;
  const onStart = () => {
    tab.loading = true;
    tab.loadError = undefined;
    pushState(tab.scope);
  };
  const onNavigate = () => {
    tab.pendingUrl = undefined;
    tab.loadError = undefined;
    pushState(tab.scope);
  };
  const onFinish = () => {
    tab.loading = false;
    tab.pendingUrl = undefined;
    pushState(tab.scope);
  };
  const onStop = () => {
    tab.loading = false;
    pushState(tab.scope);
  };
  const onFail = (_e: unknown, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
    if (errorCode === -3) return;
    if (isMainFrame) {
      tab.loading = false;
      tab.loadError = errorDescription || `Failed to load (${errorCode})`;
      pushState(tab.scope);
    }
  };
  wc.on('did-start-loading', onStart);
  wc.on('did-navigate', onNavigate);
  wc.on('did-navigate-in-page', () => pushState(tab.scope));
  wc.on('did-finish-load', onFinish);
  wc.on('did-stop-loading', onStop);
  wc.on('did-fail-load', onFail);
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        withBrowserScope(tab.scope, () => panelOpenTab(parsed.toString()));
      }
    } catch { /* ignore */ }
    return { action: 'deny' };
  });
  wc.on('will-navigate', allowWebNavigation);
  wc.on('will-frame-navigate', (details) => allowWebNavigation(details, details.url));
}

function createTab(url?: string): PanelTab {
  hardenGuestSession();
  const view = new WebContentsView({
    webPreferences: {
      partition: partition(),
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
  // No setBorderRadius: on Linux it crashed the whole app (SIGSEGV) when the
  // panel opened from the UI, reproduced and cleared by removing only this call.
  // The panel's card already rounds the box around the box.
  tabSeq += 1;
  view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
  view.setVisible(false);
  const tab: PanelTab = {
    scope: browserScope(),
    id: `btab-${Date.now()}-${tabSeq}`,
    view,
    preset: 'fit',
    debuggerAttached: false,
    pendingUrl: url || undefined,
    loading: !!url,
    console: [],
    consoleSeq: 0
  };
  wireGuestEvents(tab);
  attachToMainWindow(view);
  state().tabs.set(tab.id, tab);
  state().activeTabId = tab.id;
  // Emulation on a view that has never held a document crashes Electron
  // (SIGSEGV on Linux, reproduced with only attach + setDeviceMetricsOverride):
  // viewport emulation waits lazily for the first loaded page.
  tab.firstLoad = new Promise<void>((resolve) => {
    view.webContents.once('did-finish-load', () => resolve());
    view.webContents.on('did-fail-load', (_event, code) => { if (code !== -3) resolve(); });
  });
  void view.webContents.loadURL(url || 'about:blank').catch(() => {});
  applyBounds();
  pushState();
  return tab;
}

function requireTab(tabId?: string): PanelTab {
  const id = tabId || state().activeTabId || '';
  const tab = state().tabs.get(id);
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
  const message = debuggerConsoleMessage(method, params);
  if (message) pushConsole(tab, message);
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

/** Show the decorative agent pointer at viewport point (x, y); it glides from its last position. */
export async function panelPointer(tab: PanelTab, x: number, y: number, pressed = false, pulse = false) {
  const config = tab.preset === 'fit' ? null : BROWSER_VIEWPORTS[tab.preset];
  const bounds = state(tab.scope).panelBounds;
  const scale = config && bounds ? Math.min(1,bounds.width/config.width,bounds.height/config.height) : 1;
  await tab.view.webContents.debugger.sendCommand('Runtime.evaluate', {expression:browserPointerScript(x,y,pressed,scale,pulse),returnByValue:true}).catch(() => {});
}

async function cdp<T>(tab: PanelTab, method: string, params?: Record<string, unknown>): Promise<T> {
  await ensureDebugger(tab);
  if (method === 'Input.dispatchMouseEvent' && typeof params?.x === 'number' && typeof params?.y === 'number') {
    await panelPointer(tab, params.x, params.y, params.type === 'mousePressed');
  }
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
  const scope = browserScope(); const owner = state(scope);
  if (owner.agentDrivingTimer) clearTimeout(owner.agentDrivingTimer);
  if (!owner.agentDriving) { owner.agentDriving = true; pushState(scope); }
  owner.agentDrivingTimer = setTimeout(() => {
    owner.agentDriving = false; owner.agentDrivingTimer = null; pushState(scope);
  }, 5000);
}

export function panelSetTakeover(on: boolean) {
  state().userTakeover = on;
  if(on)for(const tab of state().tabs.values())void tab.view.webContents.executeJavaScript("document.getElementById('__agente_pointer')?.remove()").catch(()=>{});
  pushState();
  return { takeover: state().userTakeover };
}

export function panelIsTakenOver(): boolean {
  return state().userTakeover;
}

export function panelShow() {
  if (!state().panelVisible) {
    state().panelVisible = true;
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
  let normalized: string | undefined;
  if (url && typeof url === 'string') {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs allowed');
    }
    normalized = parsed.toString();
  }
  if (normalized) {
    for (const existing of state().tabs.values()) {
      if (safeUrl(existing) === normalized) {
        state().activeTabId = existing.id;
        state().panelVisible = true;
        applyBounds();
        pushState();
        return { id: existing.id, url: normalized };
      }
    }
    const active = state().activeTabId ? state().tabs.get(state().activeTabId!) : null;
    if (active && !safeUrl(active)) {
      active.pendingUrl = normalized;
      active.loading = true;
      active.loadError = undefined;
      state().panelVisible = true;
      void active.view.webContents.loadURL(normalized).catch(() => {});
      applyBounds();
      pushState();
      return { id: active.id, url: normalized };
    }
  }
  if (state().tabs.size >= AGENT_BROWSER_MAX_TABS) {
    const oldest = [...state().tabs.values()][0];
    if (oldest) closeTabEntry(oldest.id);
  }
  state().panelVisible = true;
  const tab = createTab(normalized);
  return { id: tab.id, url: normalized || '' };
}

export function panelListTabs() {
  return [...state().tabs.values()].map((t) => ({ id: t.id, url: safeUrl(t), title: safeTitle(t.view), preset: t.preset, loading: t.loading, ...(t.loadError ? { error: t.loadError } : {}) }));
}

export function panelSetActive(tabId: string) {
  if (!state().tabs.has(tabId)) throw new Error('Unknown browser tab');
  state().activeTabId = tabId;
  applyBounds();
  pushState();
  return { id: tabId };
}

function tryRelease(action: () => void): void {
  try {
    action();
  } catch { /* ignore */ }
}

function removeTabView(tab: PanelTab): void {
  const win = state(tab.scope).host ?? getMainWindow();
  const contentView = win as unknown as { contentView?: { removeChildView?: (v: unknown) => void } } | null;
  contentView?.contentView?.removeChildView?.(tab.view);
}

function releaseTab(tab: PanelTab): void {
  tryRelease(() => { if (tab.debuggerAttached) tab.view.webContents.debugger.detach(); });
  tab.debuggerAttached = false;
  tryRelease(() => removeTabView(tab));
  tryRelease(() => tab.view.webContents.close());
}

function selectAfterClose(tabId: string): void {
  if (state().activeTabId === tabId) {
    state().activeTabId = [...state().tabs.keys()].pop() || null;
  }
}

function closeTabEntry(tabId: string) {
  const tab = state().tabs.get(tabId);
  if (!tab) return;
  releaseTab(tab);
  state().tabs.delete(tabId);
  selectAfterClose(tabId);
  if (!state().tabs.size) state().panelVisible = false;
}

export function panelCloseTab(tabId?: string) {
  const tab = requireTab(tabId);
  closeTabEntry(tab.id);
  applyBounds();
  pushState();
  return { closed: tab.id };
}

export function panelCloseAll() {
  for (const id of [...state().tabs.keys()]) closeTabEntry(id);
  state().activeTabId = null;
  state().panelVisible = false;
  pushState();
  return { closed: true };
}

/**
 * The page is a native view drawn above the app's DOM, so no z-index can put
 * a menu, dialog or tooltip over it. While one would, the renderer occludes
 * the panel: it gets a still of the page to show in its place and the live
 * view steps aside; un-occluding brings the live page back.
 */


export async function panelSetOccluded(occluded: boolean): Promise<{ image: string | null }> {
  const owner = state();
  if (occluded === owner.panelOccluded) return { image: null };
  const entry = owner.activeTabId ? owner.tabs.get(owner.activeTabId) : null;
  const capture = occluded && entry && owner.panelVisible
    ? entry.view.webContents.capturePage().then(frame => frame.isEmpty() ? null : frame.toDataURL()).catch(() => null)
    : Promise.resolve(null);
  // Start the capture while exposed, then hide synchronously. A slow capture
  // must never keep native content above a menu or another workspace panel.
  owner.panelOccluded = occluded;
  applyBounds();
  const image = await capture;
  return { image: owner.panelOccluded && owner.activeTabId === entry?.id ? image : null };
}

export function panelSetVisible(visible: boolean) {
  state().panelVisible = visible;
  applyBounds();
  pushState();
  return { visible };
}

export function panelSetBounds(rect: { x: number; y: number; width: number; height: number }) {
  const win = state().host ?? getMainWindow();
  state().panelBounds = browserViewBounds(rect, 1, win?.getContentBounds() ?? { width: 10000, height: 10000 });
  applyBounds();
  // A fixed-size preset rescales to the new panel size.
  const active = state().activeTabId ? state().tabs.get(state().activeTabId!) : null;
  if (active && active.preset !== 'fit') void panelSetViewport(active.preset, active.id).catch(() => {});
  return { ok: true };
}

/** Presentation never changes logical openness or broadcasts a browser hide. */
export async function panelSetPresentation(presentation: BrowserPresentation): Promise<{ image: string | null }> {
  const win = state().host ?? getMainWindow();
  const wasOccluded = state().panelOccluded;
  const active = state().activeTabId ? state().tabs.get(state().activeTabId!) : null;
  const capture = presentation.occluded && !wasOccluded && state().panelExposed && active && state().panelVisible
    ? active.view.webContents.capturePage().then((image) => image.isEmpty() ? null : image.toDataURL()).catch(() => null) : Promise.resolve(null);
  state().panelExposed = !!presentation.exposed;
  state().panelOccluded = !!presentation.occluded;
  state().panelBounds = browserViewBounds(presentation.bounds, win?.webContents.getZoomFactor() ?? 1, win?.getContentBounds() ?? { width: 0, height: 0 });
  applyBounds();
  if (active && active.preset !== 'fit' && state().panelBounds) void panelSetViewport(active.preset, active.id).catch(() => {});
  return { image: await capture };
}

export async function panelNavigate(url: string, tabId?: string, opts?: { fast?: boolean }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs allowed');
  }
  const normalized = parsed.toString();
  state().panelVisible = true;
  const tab = tabId ? requireTab(tabId) : state().activeTabId ? requireTab(state().activeTabId!) : createTab();
  state().activeTabId = tab.id;
  tab.pendingUrl = normalized;
  tab.loading = true;
  tab.loadError = undefined;
  applyBounds();
  pushState();
  if (opts?.fast) {
    void tab.view.webContents.loadURL(normalized).catch(() => {});
    return { id: tab.id, url: normalized };
  }
  await tab.view.webContents.loadURL(normalized);
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

export async function panelScreenshot(tabId?: string) {
  const tab = requireTab(tabId);
  const shot = await cdp<{ data?: string }>(tab, 'Page.captureScreenshot', { format: 'png' });
  return `data:image/png;base64,${shot.data || ''}`;
}

export async function panelSetViewport(preset: AgentBrowserViewportPreset, tabId?: string) {
  const tab = requireTab(tabId);
  if (preset !== 'fit' && !Object.hasOwn(BROWSER_VIEWPORTS,preset)) throw new Error('Unknown browser viewport');
  tab.preset = preset;
  const version = (tab.viewportVersion ?? 0) + 1;tab.viewportVersion=version;
  await tab.firstLoad;
  await ensureDebugger(tab);
  if(tab.viewportVersion!==version)return{preset:tab.preset};
  if (preset === 'fit') {
    // Responsive: the page gets the panel's own size.
    await cdp(tab, 'Emulation.clearDeviceMetricsOverride', {});
    await cdp(tab, 'Emulation.setUserAgentOverride', { userAgent: tab.view.webContents.session.getUserAgent() }).catch(() => {});
    await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    if(tab.viewportVersion===version)pushState();
    return { preset };
  }
  const config = BROWSER_VIEWPORTS[preset] ?? BROWSER_VIEWPORTS.desktop;
  // Real size (Desktop used to just clear the override and render at the
  // ~600px panel width), scaled down so the whole page fits the panel.
  const bounds = state().panelBounds;
  const fit = bounds ? Math.min(1, bounds.width / config.width, bounds.height / config.height) : 1;
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
