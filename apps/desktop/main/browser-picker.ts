import { panelCdp, panelTab } from './browser-panel.ts';

export interface BrowserPick {
  selector: string;
  tag: string;
  role: string;
  text: string;
  attributes: Record<string, string>;
  outerHTML: string;
  rect: { x: number; y: number; width: number; height: number };
  url: string;
  title: string;
  image?: string;
}

/** Page-side element picker: shadow-DOM overlay, resolves with the picks, always cleans up. */
function pickerScript(multi: boolean): string {
  return `new Promise((resolve) => {
  const MULTI = ${multi ? 'true' : 'false'};
  window.__agentPickCancel?.();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>.box{position:fixed;border:2px solid #e8793a;background:rgba(232,121,58,.12);border-radius:3px;pointer-events:none;display:none}.box.done{background:rgba(232,121,58,.2)}.tag{position:fixed;font:11px/1.3 ui-monospace,monospace;color:#fff;background:#e8793a;padding:2px 6px;border-radius:3px;pointer-events:none;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}.bar{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);font:12px system-ui,sans-serif;color:#fff;background:rgba(30,30,30,.92);padding:6px 12px;border-radius:8px}</style><div class="box"></div><div class="tag"></div><div class="bar"></div>';
  const box = root.querySelector('.box'), tag = root.querySelector('.tag'), bar = root.querySelector('.bar');
  const picked = [], marks = [];
  const hint = () => { bar.textContent = MULTI ? (picked.length ? picked.length + ' selected - Enter to finish - Esc to cancel' : 'Click an element - Shift-click for several - Esc to cancel') : 'Click an element - Esc to cancel'; };
  hint();
  document.documentElement.appendChild(host);
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  const cssPath = (el) => {
    const esc = (v) => CSS.escape(v);
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'aria-label', 'name']) {
      const v = el.getAttribute(a);
      const sel = el.tagName.toLowerCase() + '[' + a + '=' + JSON.stringify(v) + ']';
      if (v && unique(sel)) return sel;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && unique('#' + esc(node.id))) { parts.unshift('#' + esc(node.id)); break; }
      const sibs = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [];
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const attributes = {};
    for (const a of ['href', 'src', 'name', 'type', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v) attributes[a] = v.slice(0, 200); }
    return { selector: cssPath(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 300), attributes, outerHTML: el.outerHTML.slice(0, 1500), rect: { x: r.left, y: r.top, width: r.width, height: r.height }, url: location.href, title: document.title };
  };
  const place = (el, b, label) => {
    const r = el.getBoundingClientRect();
    b.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    if (label) {
      tag.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + '  ' + Math.round(r.width) + 'x' + Math.round(r.height);
      tag.style.cssText = 'display:block;left:' + Math.max(0, r.left) + 'px;top:' + (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px';
    }
  };
  const target = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el !== host && el !== document.documentElement && el !== document.body ? el : el; };
  const finish = (value) => {
    for (const k of ['mousemove', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'scroll']) window.removeEventListener(k, handlers[k], true);
    document.documentElement.style.cursor = prevCursor;
    host.remove();
    delete window.__agentPickCancel;
    resolve(value);
  };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const handlers = {
    mousemove: (e) => { const el = target(e); if (el) place(el, box, true); },
    scroll: () => {},
    mousedown: swallow, mouseup: swallow, pointerdown: swallow, pointerup: swallow,
    click: (e) => {
      swallow(e);
      const el = target(e);
      if (!el) return;
      if (!MULTI) return finish([describe(el)]);
      if (!e.shiftKey && !picked.length) return finish([describe(el)]);
      if (!e.shiftKey) { picked.push(describe(el)); return finish(picked); }
      picked.push(describe(el));
      const m = document.createElement('div'); m.className = 'box done'; root.appendChild(m); place(el, m, false); marks.push(m); hint();
    },
    keydown: (e) => {
      if (e.key === 'Escape') { swallow(e); finish([]); }
      else if (e.key === 'Enter' && MULTI) { swallow(e); finish(picked); }
    }
  };
  for (const k of ['mousemove', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown']) window.addEventListener(k, handlers[k], true);
  window.__agentPickCancel = () => finish([]);
})`;
}

export async function panelPickElement(tabId?: string, multi = false): Promise<BrowserPick[]> {
  const tab = panelTab(tabId);
  const result = await panelCdp<{ result?: { value?: BrowserPick[] }; exceptionDetails?: { text?: string } }>(tab, 'Runtime.evaluate', {
    expression: pickerScript(multi), awaitPromise: true, returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Element picker failed');
  const picks = result.result?.value ?? [];
  for (const pick of picks) {
    const { x, y, width, height } = pick.rect;
    if (width < 1 || height < 1) continue;
    const pad = 12;
    const shot = await panelCdp<{ data?: string }>(tab, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(width + pad * 2, 1600), height: Math.min(height + pad * 2, 1600), scale: 1 }
    }).catch(() => null);
    if (shot?.data) pick.image = `data:image/png;base64,${shot.data}`;
  }
  return picks;
}

export async function panelPickCancel(tabId?: string): Promise<void> {
  const tab = panelTab(tabId);
  await panelCdp(tab, 'Runtime.evaluate', { expression: 'window.__agentPickCancel?.(); true', returnByValue: true }).catch(() => {});
}
