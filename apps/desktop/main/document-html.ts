import { escapeTableCell, toMarkdownTable } from './document-tables.ts';

/**
 * HTML → Markdown. Shared by .html files and by DOCX, which mammoth renders to
 * HTML first. Handles the block structure that matters for retrieval —
 * headings, lists, tables, code, quotes — and flattens everything else to text.
 */
let cachedParseHTML: ((html: string) => { document: Document }) | null = null;

export function htmlToMarkdown(html: string): string {
  if (!cachedParseHTML) throw new Error('htmlToMarkdown called before linkedom was loaded');

  // mammoth hands back a bare fragment (`<h1>…</h1><p>…</p>`). Parsed as-is,
  // `documentElement` is just the first element, so every following sibling is
  // dropped. Wrapping guarantees a real body to walk.
  const wrapped = /<body[\s>]/i.test(html) ? html : `<body>${html}</body>`;
  const { document } = cachedParseHTML(wrapped);

  document.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

  const inline = (node: Element): string => [...node.childNodes].map((child) => {
    if (child.nodeType === 3) return (child.textContent || '').replace(/\s+/g, ' ');
    const element = child as Element;
    const tag = element.tagName?.toLowerCase();
    const value = inline(element);
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return value ? `**${value}**` : '';
    if (tag === 'em' || tag === 'i') return value ? `*${value}*` : '';
    if (tag === 'a') {
      const href = element.getAttribute('href') || '';
      return /^https?:\/\//i.test(href) ? `[${value}](${href.replace(/\)/g, '%29')})` : value;
    }
    return value;
  }).join('');

  const walk = (node: Element): string => {
    const tag = node.tagName?.toLowerCase();
    const text = () => inline(node).trim();

    if (/^h[1-6]$/.test(tag || '')) {
      const value = text();
      return value ? `${'#'.repeat(Number(tag!.slice(1)))} ${value}\n\n` : '';
    }
    if (tag === 'li') { const v = text(); return v ? `- ${v}\n` : ''; }
    if (tag === 'pre') {
      const v = (node.textContent || '').trim();
      return v ? `\`\`\`\n${v}\n\`\`\`\n\n` : '';
    }
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')]
        .map((tr) => [...tr.children].map((cell) => escapeTableCell(cell.textContent)))
        .filter((cells) => cells.length);
      return rows.length ? `${toMarkdownTable(rows)}\n\n` : '';
    }
    if (tag === 'p' || tag === 'blockquote') {
      const v = text();
      return v ? `${tag === 'blockquote' ? '> ' : ''}${v}\n\n` : '';
    }
    if (tag === 'br') return '\n';

    // Walk text nodes too: mixed containers used to silently discard prose
    // beside inline elements ("Hello <strong>world</strong>!").
    return [...node.childNodes].map((child) => child.nodeType === 3
      ? (child.textContent || '').replace(/\s+/g, ' ')
      : walk(child as Element)).join('');
  };

  const body = document.querySelector('body') || document.documentElement;
  return walk(body as unknown as Element).replace(/\n{3,}/g, '\n\n').trim();
}

export async function loadHtmlParser(): Promise<void> {
  if (cachedParseHTML) return;
  const { parseHTML } = await import('linkedom');
  cachedParseHTML = parseHTML as unknown as (html: string) => { document: Document };
}

