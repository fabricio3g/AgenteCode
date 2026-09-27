import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import katex from 'katex';
import { CODE_COPY_BUTTON_HTML } from './code-copy';

marked.setOptions({
  breaks: true,
  gfm: true
});

/**
 * `highlight: false` always takes the lazy path. Streaming tails re-render on
 * every flush, and `hljs.highlightAuto` runs language auto-detection across every
 * registered grammar — synchronously, per code block, per flush. Deferring it to
 * `observeLazyHighlight` (which only attaches once the message settles) keeps that
 * cost off the streaming path entirely.
 */
function makeCodeRenderer(highlight: boolean) {
  return ({ text, lang }: Tokens.Code): string => {
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    // For large code blocks, defer highlighting to avoid blocking the main thread
    const LAZY_THRESHOLD = 2000;
    const langLabel = language || (lang ? lang.toLowerCase() : '');
    const header = langLabel
      ? `<div class="code-block-header"><span class="code-lang">${langLabel}</span>${CODE_COPY_BUTTON_HTML}</div>`
      : `<div class="code-block-header code-block-header--bare">${CODE_COPY_BUTTON_HTML}</div>`;

    if (!highlight || text.length > LAZY_THRESHOLD) {
      // Render plain escaped text initially; a post-render DOM observer will highlight it
      const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const langAttr = language ? ` data-lang="${language}"` : '';
      return `<div class="code-block-wrapper">${header}<pre><code class="hljs${language ? ` language-${language}` : ''}" data-lazy-highlight="true"${langAttr}>${escapedText}</code></pre></div>`;
    }

    const highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
    return `<div class="code-block-wrapper">${header}<pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre></div>`;
  };
}

const renderer = new marked.Renderer();
renderer.code = makeCodeRenderer(true);

const plainCodeRenderer = new marked.Renderer();
plainCodeRenderer.code = makeCodeRenderer(false);

// Protect fenced code blocks and inline code from LaTeX processing
function extractCode(source: string): { protected: string; blocks: string[] } {
  const blocks: string[] = [];
  const out = source
    .replace(/```[\s\S]*?```/g, (m) => { blocks.push(m); return `\x00CODE${blocks.length - 1}\x00`; })
    .replace(/`[^`]*`/g, (m) => { blocks.push(m); return `\x00CODE${blocks.length - 1}\x00`; });
  return { protected: out, blocks };
}

function restoreCode(source: string, blocks: string[]): string {
  return source.replace(/\x00CODE(\d+)\x00/g, (_, i) => blocks[Number(i)]);
}

function renderKatex(math: string, displayMode: boolean, raw: string): string {
  try {
    return katex.renderToString(math.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      // Never trust TeX commands: \href{javascript:...} and \htmlData
      // execute in chat origin when trust is on.
      trust: false,
      macros: {
        '\\R': '\\mathbb{R}',
        '\\N': '\\mathbb{N}',
        '\\Z': '\\mathbb{Z}',
        '\\C': '\\mathbb{C}',
        '\\Q': '\\mathbb{Q}',
      },
    });
  } catch {
    return `<span class="katex-error" title="Failed to render LaTeX">${raw}</span>`;
  }
}

/**
 * Sanitize rendered assistant HTML before it reaches `{@html}`.
 *
 * Raw HTML from model output or fetched pages passes marked through
 * untouched, so this is the single choke point for chat-origin XSS:
 * scripts, event handlers, frames, forms and non-http(s) URLs die here.
 * Links opening off-origin get `target=_blank rel=noopener`.
 * Skipped outside browsers (unit tests run in node with no DOM).
 */
let purifyHooksInstalled = false;

export function sanitizeAssistantHtml(html: string): string {
  if (typeof window === 'undefined') return html;
  if (!purifyHooksInstalled) {
    DOMPurify.addHook('uponSanitizeElement', (node) => {
      if (node instanceof Element && node.tagName === 'A') {
        const anchor = node as HTMLAnchorElement;
        const href = anchor.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noreferrer noopener');
        }
      }
    });
    purifyHooksInstalled = true;
  }
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta', 'title', 'textarea', 'slot'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  });
}

function renderLatex(source: string): string {
  const { protected: src, blocks } = extractCode(source);

  let result = src;

  // Display: $$...$$ (multiline)
  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (m, math) => renderKatex(math, true, m));

  // Display: \[...\] (multiline)
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (m, math) => renderKatex(math, true, m));

  // Inline: $...$ (single line, no leading/trailing digit to avoid currency)
  result = result.replace(/(?<!\d)\$([^\n$]+?)\$(?!\d)/g, (m, math) => renderKatex(math, false, m));

  // Inline: \(...\)
  result = result.replace(/\\\((.+?)\\\)/g, (m, math) => renderKatex(math, false, m));

  return restoreCode(result, blocks);
}

const MARKDOWN_CACHE_LIMIT = 240;
const markdownCache = new Map<string, string>();

function getCachedMarkdown(source: string): string | null {
  const hit = markdownCache.get(source);
  if (!hit) return null;
  markdownCache.delete(source);
  markdownCache.set(source, hit);
  return hit;
}

function setCachedMarkdown(source: string, html: string) {
  markdownCache.set(source, html);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) return;
  const oldestKey = markdownCache.keys().next().value;
  if (oldestKey) markdownCache.delete(oldestKey);
}

export type RenderMarkdownOptions = {
  /** Syntax-highlight fenced code inline. Off for streaming tails — see makeCodeRenderer. */
  highlight?: boolean;
  /**
   * Run KaTeX. Off for streaming tails: a half-arrived `$$` renders as an error
   * node that flashes and is replaced on the next flush, and the work is thrown
   * away each time. The block gets full treatment once it settles.
   */
  math?: boolean;
  /**
   * Consult and populate the LRU. Off for streaming tails: every growing prefix
   * is a distinct key, so caching them never hits and evicts settled messages.
   */
  cache?: boolean;
};

export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const { highlight = true, math = true, cache = true } = options;
  const input = source || '';
  if (cache) {
    const cached = getCachedMarkdown(input);
    if (cached != null) return cached;
  }

  // Normalise LLM citation variants before rendering:
  // [REF]2[/REF]  →  [2]
  // [REF](2)[/REF] → [2]
  // [^2] (footnote-style) → [2]
  let cleaned = input
    .replace(/\[REF\]\(?(\d+)\)?\[\/REF\]/gi, '[$1]')
    .replace(/\[\^(\d+)\]/g, '[$1]');
  const withLatex = math ? renderLatex(cleaned) : cleaned;
  const html = marked.parse(withLatex, {
    renderer: highlight ? renderer : plainCodeRenderer
  }) as string;
  const safe = sanitizeAssistantHtml(html);
  if (cache) setCachedMarkdown(input, safe);
  return safe;
}

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * Any leading whitespace. An indented (4-space) code block treats an interior
 * blank line as part of the block, so splitting there would turn one block into
 * two; 1–3 spaces can also be a lazy continuation of a list item. Blockquotes and
 * table rows deliberately are *not* protected — CommonMark and GFM both end those
 * at a blank line anyway, so a split there produces identical output.
 */
const INDENTED = /^[ \t]/;

/**
 * Split a mid-stream markdown string into a prefix that will not change again and
 * a trailing block that still might.
 *
 * The point is DOM stability. `{@html}` with a single child compiles to
 * `innerHTML =`, which destroys and rebuilds every child on assignment, so
 * rendering a whole growing message through one `{@html}` re-creates the entire
 * subtree on every flush — re-parsing, re-highlighting, re-laying-out, and
 * restarting any CSS animation attached to it. Rendering the settled prefix
 * separately means its nodes are written once and then left alone; only the small
 * tail churns.
 *
 * The split is deliberately conservative: it only happens at a blank line that is
 * outside any fenced code block, outside display math, not inside an indented code
 * block, and not between two items of the same list. When no such boundary exists
 * the whole string is returned as the tail, which is correct but unoptimised —
 * never wrong. Rendering `settled` and `tail` separately and concatenating the HTML
 * must always equal rendering the whole string.
 */
export function splitStreamingMarkdown(source: string): { settled: string; tail: string } {
  const text = source || '';
  if (!text) return { settled: '', tail: '' };

  const lines = text.split('\n');

  // Fence state *before* each line, plus where a still-open fence began. An open
  // fence at EOF means the tail has to start at its opening line, or the fence
  // would be split from its content.
  const fenceOpenBefore: boolean[] = new Array(lines.length).fill(false);
  let fenceChar = '';
  let fenceLen = 0;
  let openFenceLine = -1;

  for (let i = 0; i < lines.length; i++) {
    fenceOpenBefore[i] = !!fenceChar;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!match) continue;
    const marker = match[1];
    if (!fenceChar) {
      fenceChar = marker[0];
      fenceLen = marker.length;
      openFenceLine = i;
    } else if (marker[0] === fenceChar && marker.length >= fenceLen && !match[2].trim()) {
      fenceChar = '';
      fenceLen = 0;
      openFenceLine = -1;
    }
  }

  /*
   * Whether a list is open *before* each line. A blank line does not end a list
   * (that is what makes a list "loose"), so splitting between two items would turn
   * one list into two adjacent ones — visibly different spacing. Splitting
   * immediately *before* a list starts is fine, which is the common and useful
   * case: the prose above a list settles while the list itself is still arriving.
   */
  const listOpenBefore: boolean[] = new Array(lines.length).fill(false);
  let listOpen = false;

  for (let i = 0; i < lines.length; i++) {
    listOpenBefore[i] = listOpen;
    if (fenceOpenBefore[i]) continue;
    const line = lines[i];
    if (line.trim() === '') continue;
    if (LIST_ITEM.test(line)) {
      listOpen = true;
      continue;
    }
    if (INDENTED.test(line)) continue;
    listOpen = false;
  }

  const maxTailStart = fenceChar ? openFenceLine : lines.length;

  for (let blank = Math.min(lines.length - 1, maxTailStart); blank > 0; blank--) {
    if (lines[blank].trim() !== '') continue;
    if (fenceOpenBefore[blank]) continue;

    let start = blank + 1;
    while (start < lines.length && lines[start].trim() === '') start++;
    if (start >= lines.length || start > maxTailStart) continue;
    if (INDENTED.test(lines[start])) continue;
    if (LIST_ITEM.test(lines[start]) && listOpenBefore[start]) continue;

    // An odd number of `$$` in the prefix means display math straddles the
    // boundary; splitting there would render two error nodes instead of a formula.
    const settled = lines.slice(0, start).join('\n');
    if ((settled.match(/\$\$/g)?.length ?? 0) % 2 !== 0) continue;

    return { settled, tail: lines.slice(start).join('\n') };
  }

  return { settled: '', tail: text };
}

// Lazy-highlight large code blocks after they're inserted into the DOM.
// Call `observeLazyHighlight(container)` on the wrapper element that holds
// rendered markdown output.
export function observeLazyHighlight(root: HTMLElement): () => void {
  const highlightPending = (el: Element) => {
    const lang = (el as HTMLElement).dataset.lang || undefined;
    const text = el.textContent || '';
    const result = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang })
      : hljs.highlightAuto(text);
    el.innerHTML = result.value;
    el.removeAttribute('data-lazy-highlight');
  };

  // Highlight any already-present lazy blocks
  for (const el of root.querySelectorAll('[data-lazy-highlight]')) {
    const cb = (window as any).requestIdleCallback as typeof requestIdleCallback | undefined;
    if (cb) {
      cb(() => highlightPending(el));
    } else {
      setTimeout(() => highlightPending(el), 1);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          if (node.dataset?.lazyHighlight) {
            const cb = (window as any).requestIdleCallback as typeof requestIdleCallback | undefined;
            if (cb) cb(() => highlightPending(node));
            else setTimeout(() => highlightPending(node), 1);
          }
          for (const child of node.querySelectorAll('[data-lazy-highlight]')) {
            const cb = (window as any).requestIdleCallback as typeof requestIdleCallback | undefined;
            if (cb) cb(() => highlightPending(child));
            else setTimeout(() => highlightPending(child), 1);
          }
        }
      }
    }
  });

  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
