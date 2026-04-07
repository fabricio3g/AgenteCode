import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';

marked.setOptions({
  breaks: true,
  gfm: true
});

const renderer = new marked.Renderer();

renderer.code = ({ text, lang }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  // For large code blocks, defer highlighting to avoid blocking the main thread
  const LAZY_THRESHOLD = 2000;
  const langLabel = language || (lang ? lang.toLowerCase() : '');
  const header = langLabel
    ? `<div class="code-block-header"><span class="code-lang">${langLabel}</span><button class="code-copy-btn" onclick="(function(btn){var pre=btn.closest('pre');var code=pre?pre.querySelector('code'):null;if(code){navigator.clipboard.writeText(code.innerText||code.textContent||'').then(function(){btn.textContent='Copied!';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},1800)}).catch(function(){btn.textContent='Copy';})}else{btn.textContent='Copy'}})(this)" type="button">Copy</button></div>`
    : `<div class="code-block-header code-block-header--bare"><button class="code-copy-btn" onclick="(function(btn){var pre=btn.closest('pre');var code=pre?pre.querySelector('code'):null;if(code){navigator.clipboard.writeText(code.innerText||code.textContent||'').then(function(){btn.textContent='Copied!';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},1800)}).catch(function(){btn.textContent='Copy';})}else{btn.textContent='Copy'}})(this)" type="button">Copy</button></div>`;

  if (text.length > LAZY_THRESHOLD) {
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
      trust: true,
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

export function renderMarkdown(source: string): string {
  const input = source || '';
  const cached = getCachedMarkdown(input);
  if (cached != null) return cached;

  // Normalise LLM citation variants before rendering:
  // [REF]2[/REF]  →  [2]
  // [REF](2)[/REF] → [2]
  // [^2] (footnote-style) → [2]
  let cleaned = input
    .replace(/\[REF\]\(?(\d+)\)?\[\/REF\]/gi, '[$1]')
    .replace(/\[\^(\d+)\]/g, '[$1]');
  const withLatex = renderLatex(cleaned);
  const html = marked.parse(withLatex, { renderer }) as string;
  setCachedMarkdown(input, html);
  return html;
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
