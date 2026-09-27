// ── Agent browser driver ───────────────────────────────────────────────
// What an LLM needs to use the in-app browser: a compact snapshot where every
// interactive element has a ref (`e12`), actions that take those refs, waits,
// history, the page's console/network errors, and screenshots it can see.
// Shared by the Code agent's tools (main process) and the Home agent's tools
// (through IPC). The panel itself (tabs, bounds, CDP) lives in browser-panel.

import { describeLoadError, type BrowserSnapshot } from './browser-format.ts';
import {
  panelCdp,
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

const SNAPSHOT_ELEMENT_LIMIT = 150;
const SNAPSHOT_TEXT_LIMIT = 3000;


/**
 * Walks the page, tags visible interactive/semantic elements with
 * `data-agent-ref`, and describes them one per line. Runs inside the page.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const LIMIT = ${SNAPSHOT_ELEMENT_LIMIT};
  const clip = (value, max = 80) => {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio', 'range'].includes(type)) return type;
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const nameOf = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (text.trim()) return text;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && label.innerText.trim()) return label.innerText;
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping !== el && wrapping.innerText.trim()) return wrapping.innerText;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    return el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.value || '';
  };
  for (const el of document.querySelectorAll('[data-agent-ref]')) el.removeAttribute('data-agent-ref');
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[contenteditable=true],h1,h2,h3';
  const lines = [];
  let count = 0;
  let truncated = false;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    if (count >= LIMIT) { truncated = true; break; }
    count += 1;
    const ref = 'e' + count;
    el.setAttribute('data-agent-ref', ref);
    const role = roleOf(el);
    let line = ref + ' ' + role + ' "' + clip(nameOf(el)) + '"';
    if (role === 'textbox' || role === 'combobox') line += ' value="' + clip(el.isContentEditable ? el.innerText : el.value, 60) + '"';
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && (el.checked || el.getAttribute('aria-checked') === 'true')) line += ' checked';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) line += ' → ' + clip(href, 60);
    }
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) line += ' (offscreen)';
    lines.push(line);
  }
  return {
    url: location.href,
    title: document.title,
    elements: lines,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${SNAPSHOT_TEXT_LIMIT}),
    scrollY: Math.round(scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    viewportHeight: innerHeight,
    truncated
  };
})()`;

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
  await mouse(tab, 'mouseMoved', x, y);
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
  await mouse(tab, 'mouseMoved', x, y);
  await settle(tab, 1000);
  return snapshot(tab.id);
}

/** Replace a field's content with `text`; optionally press Enter to submit. */
export async function fill(ref: string, text: string, options: { submit?: boolean } = {}, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
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
  if (text) await panelCdp(tab, 'Input.insertText', { text });
  else await key(tab, 'Backspace');
  if (options.submit) await key(tab, 'Enter');
  await settle(tab);
  return snapshot(tab.id);
}

export async function selectOption(ref: string, value: string, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
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
  await key(tab, name);
  await settle(tab, 2000);
  return snapshot(tab.id);
}

export async function scroll(options: { direction?: 'up' | 'down'; pages?: number; ref?: string }, tabId?: string): Promise<BrowserSnapshot> {
  const tab = begin(tabId);
  if (options.ref) {
    await locate(tab, options.ref);
  } else {
    const pages = Math.max(0.25, Math.min(options.pages ?? 1, 10));
    const sign = options.direction === 'up' ? -1 : 1;
    await evaluate(tab, `window.scrollBy({ top: ${sign} * innerHeight * ${pages} * 0.9 }), true`);
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

export async function screenshot(tabId?: string): Promise<{ data: string; mimeType: string }> {
  const tab = begin(tabId);
  const shot = await panelCdp<{ data?: string }>(tab, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) return { data: shot.data, mimeType: 'image/png' };
  // CDP cannot capture a page that is not being painted; Electron sometimes can.
  const image = await tab.view.webContents.capturePage().catch(() => null);
  if (image && !image.isEmpty()) return { data: image.toPNG().toString('base64'), mimeType: 'image/png' };
  throw new Error('The page could not be captured — the app window must be visible (not minimized) to take a screenshot. Use browser_snapshot to read the page instead.');
}
