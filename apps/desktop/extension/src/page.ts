// ── Functions that run inside the page ────────────────────────────────
// Each is handed to `scripting.executeScript({ func, args })`, which ships its
// source text to the tab: they must be self-contained — no imports, no
// module-level names, nothing captured from outside the function body.
//
// Refs are the `data-agent-ref` attributes the snapshot script stamps.

export interface PageResult {
  ok: boolean;
  text: string;
}

export function pageClick(ref: string): PageResult {
  const el = document.querySelector<HTMLElement>(`[data-agent-ref="${ref}"]`);
  if (!el) return { ok: false, text: `No element ${ref} on the page — take a new snapshot; refs change when the page does.` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.click();
  return { ok: true, text: '' };
}

export function pageFill(ref: string, text: string, submit: boolean): PageResult {
  const el = document.querySelector<HTMLElement>(`[data-agent-ref="${ref}"]`);
  if (!el) return { ok: false, text: `No element ${ref} on the page — take a new snapshot.` };
  if (el instanceof HTMLInputElement && el.type === 'password') {
    return { ok: false, text: 'Password fields are never filled by the agent. Ask the user to type it themselves.' };
  }
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // The native setter, so frameworks that track the value (React) notice.
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    getSelection()?.selectAllChildren(el);
    document.execCommand('insertText', false, text);
  } else {
    return { ok: false, text: `${ref} is not a text field.` };
  }
  if (submit) {
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    const handled = !el.dispatchEvent(enter);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    const form = (el as HTMLInputElement).form;
    if (!handled && form) form.requestSubmit();
  }
  return { ok: true, text: '' };
}

export function pageSelect(ref: string, value: string): PageResult {
  const el = document.querySelector(`[data-agent-ref="${ref}"]`);
  if (!(el instanceof HTMLSelectElement)) return { ok: false, text: `${ref} is not a <select>. For custom dropdowns, click it and then click the option.` };
  const wanted = value.trim().toLowerCase();
  const option = [...el.options].find((o) => o.value === value) ?? [...el.options].find((o) => o.text.trim().toLowerCase() === wanted);
  if (!option) return { ok: false, text: `No option "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(', ')}` };
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, text: '' };
}

export function pagePress(key: string): PageResult {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const scrolls: Record<string, number> = { PageDown: innerHeight * 0.85, PageUp: -innerHeight * 0.85, Space: innerHeight * 0.85 };
  const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
  if (!editing && key in scrolls) {
    scrollBy({ top: scrolls[key], behavior: 'instant' as ScrollBehavior });
    return { ok: true, text: '' };
  }
  if (!editing && (key === 'Home' || key === 'End')) {
    scrollTo({ top: key === 'Home' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior });
    return { ok: true, text: '' };
  }
  const name = key === 'Space' ? ' ' : key;
  const init = { key: name, code: key, bubbles: true, cancelable: true };
  const handled = !target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  if (key === 'Enter' && !handled) {
    const form = (target as HTMLInputElement).form;
    if (form) form.requestSubmit();
    else if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) target.click();
  }
  if (key === 'Escape') (target as HTMLElement).blur?.();
  return { ok: true, text: '' };
}

export function pageHover(ref: string): PageResult {
  const el = document.querySelector<HTMLElement>(`[data-agent-ref="${ref}"]`);
  if (!el) return { ok: false, text: `No element ${ref} on the page — take a new snapshot.` };
  el.scrollIntoView({ block: 'center' });
  const rect = el.getBoundingClientRect();
  const init = { bubbles: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
  }
  return { ok: true, text: '' };
}

export function pageScroll(direction: string, pages: number, ref: string): PageResult {
  if (ref) {
    const el = document.querySelector(`[data-agent-ref="${ref}"]`);
    if (!el) return { ok: false, text: `No element ${ref} on the page — take a new snapshot.` };
    el.scrollIntoView({ block: 'center' });
    return { ok: true, text: '' };
  }
  const amount = innerHeight * 0.85 * Math.max(0.25, Math.min(10, pages || 1));
  scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'instant' as ScrollBehavior });
  return { ok: true, text: '' };
}

export async function pageWait(text: string, selector: string, timeoutMs: number): Promise<PageResult> {
  const deadline = Date.now() + Math.max(100, Math.min(30_000, timeoutMs || 8000));
  const found = () =>
    (selector && document.querySelector(selector)) || (text && document.body?.innerText.toLowerCase().includes(text.toLowerCase()));
  while (Date.now() < deadline) {
    try {
      if (found()) return { ok: true, text: '' };
    } catch {
      return { ok: false, text: `"${selector}" is not a valid CSS selector.` };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, text: `Timed out waiting for ${selector ? `"${selector}"` : `"${text}"`}.` };
}

export function pageRead(ref: string): PageResult {
  if (ref) {
    const el = document.querySelector<HTMLElement>(`[data-agent-ref="${ref}"]`);
    if (!el) return { ok: false, text: `No element ${ref} on the page — take a new snapshot.` };
    const value = (el as HTMLInputElement).value;
    return { ok: true, text: (typeof value === 'string' && value) || el.innerText || '' };
  }
  const main = document.querySelector<HTMLElement>('main, article, [role=main]') ?? document.body;
  return { ok: true, text: (main?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 12_000) };
}

/** The whole page, as plain text or light markdown (headings, lists, links, code). */
export function pageExtract(format: string): PageResult {
  const root = document.querySelector<HTMLElement>('main, article, [role=main]') ?? document.body;
  if (!root) return { ok: false, text: 'The page has no body.' };
  const header = `# ${document.title || '(untitled)'}\n${location.href}\n\n`;
  if (format !== 'markdown') return { ok: true, text: header + root.innerText.replace(/\n{3,}/g, '\n\n') };
  const out: string[] = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'BUTTON', 'FORM']);
  const inline = (el: Element): string => {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (node instanceof HTMLElement && !skip.has(node.tagName)) {
        if (node.tagName === 'A' && node.getAttribute('href') && !node.getAttribute('href')!.startsWith('javascript:')) {
          text += `[${node.innerText.trim()}](${(node as HTMLAnchorElement).href})`;
        } else if (node.tagName === 'CODE') text += `\`${node.innerText}\``;
        else if (node.tagName === 'STRONG' || node.tagName === 'B') text += `**${node.innerText.trim()}**`;
        else text += inline(node);
      }
    }
    return text.replace(/\s+/g, ' ');
  };
  const walk = (el: Element) => {
    for (const child of el.children) {
      if (!(child instanceof HTMLElement) || skip.has(child.tagName) || child.hidden) continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${child.innerText.trim()}`);
      else if (tag === 'P' || tag === 'BLOCKQUOTE') out.push((tag === 'BLOCKQUOTE' ? '> ' : '') + inline(child).trim());
      else if (tag === 'LI') out.push(`- ${inline(child).trim()}`);
      else if (tag === 'PRE') out.push('```\n' + child.innerText.replace(/\n$/, '') + '\n```');
      else if (tag === 'TR') out.push(`| ${[...child.children].map((cell) => (cell as HTMLElement).innerText.trim().replace(/\|/g, '\\|')).join(' | ')} |`);
      else walk(child);
    }
  };
  walk(root);
  return { ok: true, text: header + out.filter((line) => line.replace(/[-#>|`*\s]/g, '')).join('\n\n') };
}

export function pageSelection(): string {
  return String(getSelection() ?? '').trim().slice(0, 8000);
}

/** Runs in the page's own world: new console entries since the last read. */
export function pageConsole(level: string, peek: boolean) {
  const store = (window as unknown as { __agenteConsole?: { entries: { seq: number; level: string; source: string; text: string }[]; seen: number } }).__agenteConsole;
  if (!store) return { entries: [], hooked: false };
  const fresh = store.entries.filter((entry) => entry.seq > store.seen && (level === 'all' || level === 'warning' || entry.level === 'error'));
  if (!peek && store.entries.length) store.seen = store.entries[store.entries.length - 1].seq;
  return { entries: peek ? fresh.filter((entry) => entry.level === 'error') : fresh, hooked: true };
}

/** Same-origin fetch from inside a Google tab, with the user's own session. */
export async function pageFetchText(url: string) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, text: response.ok ? await response.text() : '' };
  } catch (error) {
    return { status: 0, type: '', text: String(error) };
  }
}
