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
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;
  const langLabel = language || (lang ? lang.toLowerCase() : '');
  const header = langLabel
    ? `<div class="code-block-header"><span class="code-lang">${langLabel}</span><button class="code-copy-btn" onclick="(function(btn){var pre=btn.closest('pre');var code=pre?pre.querySelector('code'):null;if(code){navigator.clipboard.writeText(code.innerText||code.textContent||'').then(function(){btn.textContent='Copied!';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},1800)}).catch(function(){btn.textContent='Copy';})}else{btn.textContent='Copy'}})(this)" type="button">Copy</button></div>`
    : `<div class="code-block-header code-block-header--bare"><button class="code-copy-btn" onclick="(function(btn){var pre=btn.closest('pre');var code=pre?pre.querySelector('code'):null;if(code){navigator.clipboard.writeText(code.innerText||code.textContent||'').then(function(){btn.textContent='Copied!';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},1800)}).catch(function(){btn.textContent='Copy';})}else{btn.textContent='Copy'}})(this)" type="button">Copy</button></div>`;
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

export function renderMarkdown(source: string): string {
  // Normalise LLM citation variants before rendering:
  // [REF]2[/REF]  →  [2]
  // [REF](2)[/REF] → [2]
  // [^2] (footnote-style) → [2]
  let cleaned = (source || '')
    .replace(/\[REF\]\(?(\d+)\)?\[\/REF\]/gi, '[$1]')
    .replace(/\[\^(\d+)\]/g, '[$1]');
  const withLatex = renderLatex(cleaned);
  return marked.parse(withLatex, { renderer }) as string;
}
