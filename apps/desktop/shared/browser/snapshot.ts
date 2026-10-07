// ── The page snapshot script (Electron app + browser extension) ────────
// Injected into the page and evaluated there: the Electron panel driver and the
// browser extension run this exact script, so both snapshots carry the same refs
// and the same text limits. It must stay self-contained and side-effect free —
// it is stringified and shipped to the page, so it can only use the two limits
// interpolated above.

export const SNAPSHOT_ELEMENT_LIMIT = 150;
export const SNAPSHOT_TEXT_LIMIT = 3000;


/**
 * Walks the page, tags visible interactive/semantic elements with
 * `data-agent-ref`, and describes them one per line. Runs inside the page.
 */
export const SNAPSHOT_SCRIPT = `(() => {
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
