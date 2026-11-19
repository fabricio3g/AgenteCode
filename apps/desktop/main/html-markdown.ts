// ── HTML → readable markdown ───────────────────────────────────────────
// What Mozilla Readability (Firefox's Reader View) hands back is clean
// article HTML; this renders it — or, when Readability finds no article, the
// page's own content region with its chrome removed — as markdown a model
// reads well: headings, paragraphs, lists, tables, code and links, with the
// spaces between words kept. The core's `web_fetch` (Rust, `tools/web/
// extract.rs`) follows the same rules, so both surfaces read a page alike.
//
// Works on linkedom documents (no layout, so "hidden" means the `hidden`
// attribute, `aria-hidden` or an inline `display:none`).

type El = Element;

/** Tags that never carry content worth reading. */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'nav', 'footer', 'aside', 'form', 'button', 'select', 'input', 'textarea', 'label', 'dialog',
  'menu', 'head', 'link', 'meta', 'video', 'audio', 'map', 'img', 'picture', 'source',
]);

/** Removed before Readability runs: never content, and noise in its scoring. */
const NOISE_SELECTOR = 'script, style, noscript, template, iframe, object, embed, svg, canvas, link, meta[http-equiv]';

const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'dialog', 'search', 'menu', 'alertdialog']);

/** Class/id words of page chrome (after Mozilla Readability's list). */
const UNLIKELY = /(^|[\s_-])(ads?|advert\w*|banner|breadcrumbs?|comments?|community|cookie\w*|consent|disqus|gdpr|menu|modal|navbar|newsletter|outbrain|pagination|pager|popup|promo\w*|related|replies|share|sharing|shoutbox|sidebar|skip-?link|skyscraper|social|sponsor\w*|subscribe|taboola|toolbar|tooltip|site-header|site-footer|masthead)($|[\s_-])/i;
/** Names that mean content even when they also match UNLIKELY. */
const MAYBE_CONTENT = /(^|[\s_-])(article|body|column|content|main|post|entry|markdown|prose)($|[\s_-])/i;
const NEVER_CHROME = new Set(['body', 'main', 'article', 'table', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const BLOCK_TAGS = new Set([
  'address', 'article', 'blockquote', 'body', 'center', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'html', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Elements that usually hold a page's content. */
const CONTENT_SELECTOR = 'main, [role=main], article, #content, #main, #main-content, .content, .main-content, '
  + '.post-content, .entry-content, .article-body, .article-content, .markdown-body, .post-body, '
  + '.documentation, .docs-content, .prose';

const tagOf = (el: El) => String(el.localName || el.tagName || '').toLowerCase();

function isHidden(el: El): boolean {
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return true;
  const style = String(el.getAttribute?.('style') || '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

/** Chrome: hidden, navigational, or named like a banner, menu or share bar. */
export function isChrome(el: El): boolean {
  const tag = tagOf(el);
  if (DROP_TAGS.has(tag) || isHidden(el)) return true;
  const role = el.getAttribute?.('role');
  if (role && CHROME_ROLES.has(role)) return true;
  if (tag === 'header' && el.querySelector?.('nav')) return true;
  if (NEVER_CHROME.has(tag)) return false;
  const names = `${el.getAttribute?.('class') || ''} ${el.getAttribute?.('id') || ''}`.trim();
  return !!names && UNLIKELY.test(names) && !MAYBE_CONTENT.test(names);
}

/** Strip scripts, styles and hidden elements in place (before Readability). */
export function removeNoise(document: Document): void {
  for (const el of Array.from(document.querySelectorAll(NOISE_SELECTOR))) el.remove();
  for (const el of Array.from(document.querySelectorAll('[hidden], [aria-hidden="true"], [style]'))) {
    if (isHidden(el)) el.remove();
  }
}

/** Readable characters under `el`, link text counted at a third. */
export function contentScore(el: El): number {
  let prose = 0;
  let links = 0;
  const walk = (node: El, inLink: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const n = String(child.textContent || '').trim().length;
        if (inLink) links += n; else prose += n;
      } else if (child.nodeType === 1 && !isChrome(child as El)) {
        walk(child as El, inLink || tagOf(child as El) === 'a');
      }
    }
  };
  walk(el, false);
  return prose + Math.floor(links / 3);
}

/**
 * The element to render when Readability finds no article: the most
 * specific content candidate that holds most of the best one's text, or the
 * body when none holds much of it (a sidebar `<article>` card must not win).
 */
export function pickContentRoot(document: Document): El | null {
  const body = document.body as El | null;
  if (!body) return null;
  const bodyScore = contentScore(body);
  const candidates = Array.from(document.querySelectorAll(CONTENT_SELECTOR))
    .filter((el) => !isChrome(el))
    .map((el) => ({ el, score: contentScore(el) }));
  const best = Math.max(0, ...candidates.map((c) => c.score));
  if (best < 200 || best * 3 < bodyScore) return body;
  const depth = (el: El) => { let d = 0; for (let p = el.parentElement; p; p = p.parentElement) d += 1; return d; };
  const strong = candidates.filter((c) => c.score * 5 >= best * 4);
  strong.sort((a, b) => depth(b.el) - depth(a.el));
  return strong[0]?.el ?? body;
}

// ── Rendering ─────────────────────────────────────────────────────────

/** Source whitespace (newlines included) is one space; `<br>` is '\n'. */
function pushText(out: string[], text: string) {
  const collapsed = String(text || '').replace(/\s+/g, ' ');
  if (collapsed) out.push(collapsed);
}

/** Collapse spaces, keep `<br>` newlines, trim each line. */
function tidyInline(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

function wrap(inner: string, marker: string): string {
  const core = inner.trim();
  if (!core) return inner;
  const lead = /^\s/.test(inner) ? ' ' : '';
  const trail = /\s$/.test(inner) ? ' ' : '';
  return `${lead}${marker}${core}${marker}${trail}`;
}

function hasBlockChild(el: El): boolean {
  return Array.from(el.children).some((child) => BLOCK_TAGS.has(tagOf(child)) && !isChrome(child));
}

function codeBlock(el: El): string {
  const code = Array.from(el.children).find((c) => tagOf(c) === 'code');
  const classes = `${el.getAttribute('class') || ''} ${code?.getAttribute('class') || ''}`;
  const language = classes.split(/\s+/).map((c) => c.match(/^(?:language|lang)-(.+)$/)?.[1]).find(Boolean) || '';
  const text = String(el.textContent || '').replace(/^\n+|\s+$/g, '');
  if (!text) return '';
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text}\n${fence}`;
}

class Writer {
  blocks: string[] = [];
  line: string[] = [];

  constructor(private readonly base: string, private readonly plain: boolean) {}

  flush() {
    const text = tidyInline(this.line.join(''));
    this.line = [];
    if (hasWords(text)) this.blocks.push(text);
  }

  block(text: string) {
    this.flush();
    if (hasWords(text)) this.blocks.push(text);
  }

  finish(): string {
    const out: string[] = [];
    for (const block of this.blocks) if (out[out.length - 1] !== block) out.push(block);
    return out.join('\n\n');
  }

  children(el: El) {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) pushText(this.line, child.textContent || '');
      else if (child.nodeType === 1) this.element(child as El);
    }
  }

  sub(el: El): string {
    const writer = new Writer(this.base, this.plain);
    writer.children(el);
    writer.flush();
    return writer.finish();
  }

  element(el: El) {
    if (isChrome(el)) return;
    const tag = tagOf(el);
    if (/^h[1-6]$/.test(tag)) {
      const text = tidyInline(this.inlineChildren(el)).replace(/\n/g, ' ');
      if (hasWords(text)) this.block(`${'#'.repeat(Number(tag[1]))} ${text}`);
      return;
    }
    switch (tag) {
      case 'br': this.line.push('\n'); return;
      case 'hr': this.block('---'); return;
      case 'pre': this.block(codeBlock(el)); return;
      case 'ul':
      case 'ol': {
        const list = this.list(el, tag === 'ol');
        if (list) this.block(list);
        else { this.flush(); this.children(el); this.flush(); }
        return;
      }
      case 'table': {
        const table = this.table(el);
        if (table) this.block(table);
        else { this.flush(); this.children(el); this.flush(); }
        return;
      }
      case 'blockquote': {
        const inner = this.sub(el);
        this.block(inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
        return;
      }
      case 'dt':
      case 'summary': {
        const text = tidyInline(this.inlineChildren(el));
        if (hasWords(text)) this.block(this.plain ? text : `**${text}**`);
        return;
      }
      default:
        if (BLOCK_TAGS.has(tag) || hasBlockChild(el)) {
          this.flush();
          this.children(el);
          this.flush();
        } else {
          this.line.push(this.inline(el));
        }
    }
  }

  inlineChildren(el: El): string {
    const out: string[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) pushText(out, child.textContent || '');
      else if (child.nodeType === 1) out.push(this.inline(child as El));
    }
    return out.join('');
  }

  inline(el: El): string {
    if (isChrome(el)) return '';
    const tag = tagOf(el);
    if (tag === 'br') return '\n';
    if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') {
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || this.plain) return text;
      return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
    }
    if (tag === 'strong' || tag === 'b') return this.plain ? this.inlineChildren(el) : wrap(this.inlineChildren(el), '**');
    if (tag === 'em' || tag === 'i') return this.plain ? this.inlineChildren(el) : wrap(this.inlineChildren(el), '_');
    if (tag === 'a') {
      const text = tidyInline(this.inlineChildren(el)).replace(/\n/g, ' ');
      if (!hasWords(text)) return '';
      const href = this.plain ? '' : this.link(el.getAttribute('href') || '');
      return href && href !== text ? `[${text}](${href})` : text;
    }
    if (BLOCK_TAGS.has(tag)) return ` ${this.inlineChildren(el)} `;
    return this.inlineChildren(el);
  }

  link(href: string): string {
    const raw = href.trim();
    if (!raw || raw.startsWith('#')) return '';
    try {
      const url = new URL(raw, this.base || undefined);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
    } catch {
      return '';
    }
  }

  list(el: El, ordered: boolean): string {
    let n = Number.parseInt(el.getAttribute('start') || '1', 10) || 1;
    const items: string[] = [];
    for (const li of Array.from(el.children)) {
      if (tagOf(li) !== 'li' || isChrome(li)) continue;
      const body = this.sub(li);
      if (!body) continue;
      const marker = ordered ? `${n}.` : '-';
      n += 1;
      const indent = ' '.repeat(marker.length + 1);
      const [first, ...rest] = body.split('\n').filter(Boolean);
      items.push([`${marker} ${first}`, ...rest.map((line) => indent + line)].join('\n'));
    }
    return items.join('\n');
  }

  /** A data table as markdown; '' for layout tables (one row or column, nested tables). */
  table(el: El): string {
    if (el.querySelector('table')) return '';
    const rows: El[] = [];
    for (const child of Array.from(el.children)) {
      const tag = tagOf(child);
      if (tag === 'tr') rows.push(child);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        rows.push(...Array.from(child.children).filter((row) => tagOf(row) === 'tr'));
      }
    }
    const grid = rows
      .map((row) => Array.from(row.children)
        .filter((cell) => tagOf(cell) === 'td' || tagOf(cell) === 'th')
        .map((cell) => this.sub(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()))
      .filter((row) => row.some(Boolean));
    const columns = Math.max(0, ...grid.map((row) => row.length));
    if (grid.length < 2 || columns < 2) return '';
    const line = (row: string[]) => `| ${Array.from({ length: columns }, (_, i) => row[i] ?? '').join(' | ')} |`;
    return [line(grid[0]), `|${' --- |'.repeat(columns)}`, ...grid.slice(1).map(line)].join('\n');
  }
}

/** Render `root` as markdown (or plain text: no link targets or emphasis). */
export function elementToMarkdown(root: El, baseUrl = '', options: { plain?: boolean } = {}): string {
  const writer = new Writer(baseUrl, !!options.plain);
  writer.children(root);
  writer.flush();
  return writer.finish();
}
