// ── Agent browser driver ───────────────────────────────────────────────
// What an LLM needs to use the in-app browser: a compact snapshot where every
// interactive element has a ref (`e12`), actions that take those refs, waits,
// history, the page's console/network errors, and screenshots it can see.
// Shared by the Code agent's tools (main process) and the Home agent's tools
// (through IPC). The panel itself (tabs, bounds, CDP) lives in browser-panel.

import { nativeImage, type NativeImage } from 'electron';
import { SNAPSHOT_SCRIPT } from '../shared/browser/snapshot.ts';
import { describeLoadError, type BrowserSnapshot } from '../shared/browser/format.ts';
import {
  panelCdp,
  panelCloseTab,
  panelListTabs,
  panelPointer,
  panelSetActive,
  panelHistory,
  panelIsTakenOver,
  panelMarkAgentDriving,
  panelNavigate,
  panelOpenTab,
  panelShow,
  panelTab,
  type PanelConsoleEntry,
  type PanelTab
} from './browser-panel.ts';

/** Refuse agent input while the user has the wheel; show the panel otherwise. */
function begin(tabId?: string): PanelTab {
  if (panelIsTakenOver()) {
    throw new Error('The user has taken control of the browser. Wait, or ask them to hand it back, before using it again.');
  }
  panelMarkAgentDriving();
  panelShow();
  return panelTab(tabId);
}

async function evaluate<T>(tab: PanelTab, expression: string, timeoutMs = 10_000): Promise<T> {
  // A navigation can tear down the context mid-call, and CDP then never
  // answers: bound every call so an action cannot hang the agent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The page did not respond (it may be navigating). Try browser_snapshot again.')), timeoutMs);
  });
  try {
    const result = await Promise.race([
      panelCdp<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
        tab,
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true }
      ),
      timeout
    ]);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Script failed in the page');
    }
    return result.result?.value as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for the page to settle after an action: loading done, or a short pause. */
async function settle(tab: PanelTab, timeoutMs = 5000): Promise<void> {
  const wc = tab.view.webContents;
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (!wc.isLoading()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    }
    wc.once('did-stop-loading', done);
  });
}

const lastSeenError = new WeakMap<PanelTab, number>();

function newErrorCount(tab: PanelTab): number {
  const seen = lastSeenError.get(tab) ?? 0;
  return tab.console.filter((entry) => entry.seq > seen && entry.level === 'error').length;
}

export async function snapshot(tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  let raw: Omit<BrowserSnapshot, 'newErrors'>;
  try {
    raw = await evaluate<Omit<BrowserSnapshot, 'newErrors'>>(tab, SNAPSHOT_SCRIPT, 5000);
  } catch {
    // Most often the page was still navigating: let it land, then read again.
    await settle(tab, 10_000);
    raw = await evaluate<Omit<BrowserSnapshot, 'newErrors'>>(tab, SNAPSHOT_SCRIPT);
  }
  return { ...raw, newErrors: newErrorCount(tab) };
}

function refSelector(ref: string): string {
  // A CSS selector the user picked in the panel ("css:button#buy") is accepted too.
  if (ref.startsWith('css:')) return ref.slice(4);
  if (!/^e\d{1,4}$/.test(ref)) throw new Error(`"${ref}" is not an element ref. Take a browser_snapshot and use a ref like "e12".`);
  return `[data-agent-ref="${ref}"]`;
}

/** Scroll the element into view and return its center, or fail with a useful message. */
async function locate(tab: PanelTab, ref: string): Promise<{ x: number; y: number }> {
  const point = await evaluate<{ x: number; y: number } | null>(
    tab,
    `(() => {
      const el = document.querySelector(${JSON.stringify(refSelector(ref))});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`
  );
  if (!point) throw new Error(`No element ${ref} on the page anymore. Take a new browser_snapshot — refs change when the page changes.`);
  return point;
}

async function mouse(tab: PanelTab, type: string, x: number, y: number) {
  await panelCdp(tab, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GLIDE_MS = 230;

/** Move the real mouse and the visible pointer to (x, y), and let the user watch it travel. */
async function glide(tab: PanelTab, x: number, y: number) {
  await mouse(tab, 'mouseMoved', x, y);
  await sleep(GLIDE_MS);
}

export async function click(ref: string, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  const { x, y } = await locate(tab, ref);
  // A real pointer click (hover styles, focus, pointer events)… but a page
  // that is not painted (window minimized) ignores synthetic input, so check
  // the element actually got it and fall back to a DOM click if not.
  const selector = JSON.stringify(refSelector(ref));
  await evaluate(tab, `(() => {
    window.__agentClickLanded = false;
    const el = document.querySelector(${selector});
    el && el.addEventListener('click', () => { window.__agentClickLanded = true; }, { once: true, capture: true });
    return true;
  })()`);
  await glide(tab, x, y);
  await mouse(tab, 'mousePressed', x, y);
  await mouse(tab, 'mouseReleased', x, y);
  const landed = await evaluate<boolean>(tab, 'window.__agentClickLanded === true').catch(() => true);
  if (!landed) await evaluate(tab, `(() => { document.querySelector(${selector})?.click(); return true; })()`).catch(() => {});
  await settle(tab);
  return snapshot(tab.id);
}

export async function hover(ref: string, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  const { x, y } = await locate(tab, ref);
  await glide(tab, x, y);
  await settle(tab, 1000);
  return snapshot(tab.id);
}

/** Replace a field's content with `text`; optionally press Enter to submit. */
export async function fill(ref: string, text: string, options: { submit?: boolean } = {}, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  const point = await locate(tab,ref);
  await glide(tab, point.x, point.y);
  const focused = await evaluate<boolean>(
    tab,
    `(() => {
      const el = document.querySelector(${JSON.stringify(refSelector(ref))});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return true;
    })()`
  );
  if (!focused) throw new Error(`No element ${ref} on the page anymore. Take a new browser_snapshot.`);
  await panelPointer(tab, point.x, point.y, false, true);
  if (text) await panelCdp(tab, 'Input.insertText', { text });
  else await key(tab, 'Backspace');
  if (options.submit) await key(tab, 'Enter');
  await panelPointer(tab, point.x, point.y, false, false);
  await settle(tab);
  return snapshot(tab.id);
}

export async function selectOption(ref: string, value: string, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  const point = await locate(tab, ref);
  await glide(tab, point.x, point.y);
  const chosen = await evaluate<string | null>(
    tab,
    `(() => {
      const el = document.querySelector(${JSON.stringify(refSelector(ref))});
      if (!el || el.tagName !== 'SELECT') return null;
      const want = ${JSON.stringify(value)}.toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want)
        || [...el.options].find((o) => o.text.toLowerCase().includes(want));
      if (!option) return null;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return option.text;
    })()`
  );
  if (chosen === null) throw new Error(`Could not select "${value}" in ${ref}: not a select element, or no matching option.`);
  await settle(tab, 1500);
  return snapshot(tab.id);
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 }
};

async function key(tab: PanelTab, name: string) {
  const spec = KEYS[name];
  if (!spec) throw new Error(`Unsupported key "${name}". Use one of: ${Object.keys(KEYS).join(', ')}.`);
  const keyValue = name === 'Space' ? ' ' : name;
  await evaluate(tab, `(() => {
    window.__agentKeyLanded = false;
    window.addEventListener('keydown', () => { window.__agentKeyLanded = true; }, { once: true, capture: true });
    return true;
  })()`);
  const base = { key: keyValue, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  await panelCdp(tab, 'Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, ...(spec.text ? { text: spec.text } : {}) });
  await panelCdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  // An unpainted page (window minimized) ignores synthetic input: replay the
  // key as DOM events, and let Enter submit the focused field's form.
  const landed = await evaluate<boolean>(tab, 'window.__agentKeyLanded === true').catch(() => true);
  if (landed) return;
  await evaluate(tab, `(() => {
    const target = document.activeElement || document.body;
    const init = { key: ${JSON.stringify(keyValue)}, code: ${JSON.stringify(spec.code)}, bubbles: true, cancelable: true };
    const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    if (proceed && ${JSON.stringify(name)} === 'Enter' && target.form) target.form.requestSubmit();
    return true;
  })()`).catch(() => {});
}

export async function press(name: string, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  const focus = await evaluate<{ x: number; y: number } | null>(tab, `(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`).catch(() => null);
  if (focus) await panelPointer(tab, focus.x, focus.y, false, true);
  await key(tab, name);
  await settle(tab, 2000);
  return snapshot(tab.id);
}

export async function scroll(options: { direction?: 'up' | 'down'; pages?: number; ref?: string }, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  if (options.ref) {
    const point = await locate(tab, options.ref);
    await glide(tab, point.x, point.y);
  } else {
    const center = await evaluate<{ x: number; y: number }>(tab, '({ x: innerWidth / 2, y: innerHeight / 2 })').catch(() => null);
    if (center) await glide(tab, center.x, center.y);
    const pages = Math.max(0.25, Math.min(options.pages ?? 1, 10));
    const sign = options.direction === 'up' ? -1 : 1;
    await evaluate(tab, `window.scrollBy({ top: ${sign} * innerHeight * ${pages} * 0.9 }), true`);
    if (center) await mouse(tab, 'mouseMoved', center.x, center.y);
  }
  await settle(tab, 800);
  return snapshot(tab.id);
}

/** Poll until text/selector appears or the URL matches; fails with what it saw. */
export async function waitFor(
  options: { text?: string; selector?: string; url?: string; timeoutMs?: number },
  tabId?: string
): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 8000, 30_000));
  const check = `(() => {
    const text = ${JSON.stringify(options.text ?? '')};
    const selector = ${JSON.stringify(options.selector ?? '')};
    const url = ${JSON.stringify(options.url ?? '')};
    if (text && !(document.body && document.body.innerText.includes(text))) return false;
    if (selector && !document.querySelector(selector)) return false;
    if (url && !location.href.includes(url)) return false;
    return true;
  })()`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!tab.view.webContents.isLoading() && (await evaluate<boolean>(tab, check).catch(() => false))) {
      return snapshot(tab.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const what = [options.text && `text "${options.text}"`, options.selector && `selector ${options.selector}`, options.url && `URL containing "${options.url}"`]
    .filter(Boolean)
    .join(' and ') || 'the page to finish loading';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
}

/** Open a URL in the active tab (or a new one), and return what loaded. */
export async function open(url: string, options: { newTab?: boolean } = {}): Promise<BrowserSnapshot> {
  if (panelIsTakenOver()) begin();
  panelMarkAgentDriving();
  try {
    if (options.newTab) {
      const { id } = panelOpenTab(url);
      const tab = panelTab(id);
      await settle(tab, 15_000);
      return snapshot(id);
    }
    await panelNavigate(url);
  } catch (err: unknown) {
    throw new Error(describeLoadError(url, err));
  }
  const tab = panelTab();
  await settle(tab, 15_000);
  return snapshot(tab.id);
}

export async function history(action: 'back' | 'forward' | 'reload', tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  await panelHistory(action, tab.id);
  await settle(tab, 10_000);
  return snapshot(tab.id);
}

/** Console lines, uncaught exceptions and failed requests since `sinceSeq`. */
export function consoleEntries(options: { level?: 'error' | 'warning' | 'all'; sinceSeq?: number } = {}, tabId?: string): PanelConsoleEntry[] {
  const tab = panelTab(tabId);
  const since = options.sinceSeq ?? 0;
  const entries = tab.console.filter((entry) => {
    if (entry.seq <= since) return false;
    if (options.level === 'error') return entry.level === 'error';
    if (options.level === 'warning') return entry.level === 'error' || entry.level === 'warning';
    return true;
  });
  lastSeenError.set(tab, tab.consoleSeq);
  return entries.slice(-80);
}

/** Widest screenshot sent to a model: more pixels add upload and tokens, not legibility. */
const SCREENSHOT_MAX_WIDTH = 1280;

/**
 * A screenshot as the model gets it: at most {@link SCREENSHOT_MAX_WIDTH}
 * wide and JPEG. A full-resolution PNG of a HiDPI page ran past 1.5 MB, and
 * every one rides in the request.
 */
function forModel(image: NativeImage): { data: string; mimeType: string } {
  const { width } = image.getSize();
  const scaled = width > SCREENSHOT_MAX_WIDTH ? image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: 'good' }) : image;
  return { data: scaled.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' };
}

export async function screenshot(tabId?: string): Promise<{ data: string; mimeType: string }> {
  const tab = begin(tabId);
  const shot = await panelCdp<{ data?: string }>(tab, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) return forModel(nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')));
  // CDP cannot capture a page that is not being painted; Electron sometimes can.
  const contents = tab.view.webContents;
  const image = contents && !contents.isDestroyed() ? await contents.capturePage().catch(() => null) : null;
  if (image && !image.isEmpty()) return forModel(image);
  throw new Error('The page could not be captured — the app window must be visible (not minimized) to take a screenshot. Use browser_snapshot to read the page instead.');
}

const READ_LIMIT = 8000;

/** The page's readable text, or one element's text/value, truncated to a sensible length. */
export async function read(ref?: string, tabId?: string): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  const tab = begin(tabId);
  const selector = ref ? JSON.stringify(refSelector(ref)) : 'null';
  const out = await evaluate<{ url: string; title: string; text: string; missing?: boolean } | null>(tab, `(() => {
    const sel = ${selector};
    const el = sel ? document.querySelector(sel) : (document.querySelector('main, article, [role=main]') || document.body);
    if (!el) return { url: location.href, title: document.title, text: '', missing: true };
    const raw = el.value !== undefined && typeof el.value === 'string' && !el.isContentEditable ? el.value : el.innerText || el.textContent || '';
    return { url: location.href, title: document.title, text: String(raw).replace(/\\n{3,}/g, '\\n\\n').trim() };
  })()`);
  if (!out || out.missing) throw new Error(`No element ${ref} on the page anymore. Take a new browser_snapshot — refs change when the page changes.`);
  const truncated = out.text.length > READ_LIMIT;
  return { url: out.url, title: out.title, text: truncated ? out.text.slice(0, READ_LIMIT) : out.text, truncated };
}

/** List, switch to, or close the agent browser's tabs. */
export async function tabs(action: 'list' | 'switch' | 'close', tabId?: string): Promise<{ tabs: { id: string; url: string; title: string; active: boolean }[]; message: string }> {
  if (panelIsTakenOver()) begin();
  panelMarkAgentDriving();
  let message = '';
  if (action === 'switch') {
    if (!tabId) throw new Error('browser_tabs switch needs tab_id (from browser_tabs list).');
    panelSetActive(tabId);
    message = `Switched to ${tabId}.`;
  } else if (action === 'close') {
    const closed = panelCloseTab(tabId);
    message = `Closed ${closed.closed}.`;
  }
  const active = (() => { try { return panelTab().id; } catch { return ''; } })();
  const list = panelListTabs().map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === active }));
  return { tabs: list, message };
}
