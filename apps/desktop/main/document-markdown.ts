/**
 * Document → Markdown conversion.
 *
 * Everything the app ingests becomes Markdown before it reaches RAG, the
 * viewer, or the model. Markdown keeps the structure that plain-text extraction
 * throws away — headings, lists, tables — which is what makes retrieved chunks
 * readable and citable instead of a wall of runs-on text.
 *
 * Pure JS on purpose: this ships inside Electron, so a Python sidecar
 * (MarkItDown/Docling) would mean bundling a runtime per platform.
 */

import fs from 'node:fs';
import path from 'node:path';

export type MarkdownConversion = {
  markdown: string;
  /** Coarse type recorded on the RAG document row. */
  fileType: string;
  /** Set when a format was recognised but yielded nothing useful. */
  warning?: string;
};

/** Extensions we can read as text without mangling them. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.csv', '.tsv', '.ini', '.env', '.rst', '.tex'
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.sql',
  '.svelte', '.vue', '.css', '.scss'
]);

const CODE_FENCE_LANG: Record<string, string> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx', '.jsx': 'jsx', '.py': 'python',
  '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c',
  '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php',
  '.sh': 'bash', '.bash': 'bash', '.sql': 'sql', '.svelte': 'svelte',
  '.vue': 'vue', '.css': 'css', '.scss': 'scss'
};

/**
 * Heuristic binary sniff.
 *
 * The previous ingestion path read every unrecognised extension as UTF-8, so
 * dropping a .xlsx or .pptx indexed a page of replacement characters. Anything
 * with NUL bytes or a high share of undecodable bytes is refused outright.
 */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return true;
  if (!sample.length) return false;

  let suspicious = 0;
  for (const byte of sample) {
    // Control characters outside tab/newline/carriage-return/form-feed/escape.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

function escapeTableCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * `options.rowNumbers` prepends a `#` column holding each row's own number — the
 * coordinate a reader of a spreadsheet actually uses, and what lets a retrieved
 * chunk be cited as `sheet Sales · rows 4–9`.
 */
function toMarkdownTable(rows: unknown[][], options: { rowNumbers?: number[] } = {}): string {
  const numbers = options.rowNumbers;
  const cleaned = rows
    .map((cells, index) => ({ cells, number: numbers?.[index] }))
    .filter((entry) => entry.cells.some((cell) => String(cell ?? '').trim() !== ''));
  if (!cleaned.length) return '';

  const width = Math.max(...cleaned.map((entry) => entry.cells.length)) + (numbers ? 1 : 0);
  const pad = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < width) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };
  const body = (entry: { cells: unknown[]; number?: number }) => pad([
    ...(numbers ? [String(entry.number ?? '')] : []),
    ...entry.cells.map(escapeTableCell)
  ]);

  const [header, ...rest] = cleaned;
  return [
    pad([...(numbers ? ['#'] : []), ...header.cells.map(escapeTableCell)]),
    pad(Array.from({ length: width }, () => '---')),
    ...rest.map(body)
  ].join('\n');
}

function parseDelimited(text: string, delimiter: string): unknown[][] {
  // Minimal RFC-4180 handling: quoted fields may contain the delimiter,
  // newlines, and doubled quotes.
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function convertDocx(filePath: string): Promise<MarkdownConversion> {
  const mammoth = (await import('mammoth')).default;
  await loadHtmlParser();

  // Via HTML rather than mammoth's own convertToMarkdown: that flattens tables
  // into a run of loose paragraphs, losing the row/column structure entirely.
  // The HTML walker below reconstructs real Markdown tables.
  const html = await mammoth.convertToHtml({ path: filePath });
  const markdown = htmlToMarkdown(String(html?.value || '')).trim();
  if (markdown) return { markdown, fileType: 'docx' };

  const fallback = await mammoth.extractRawText({ path: filePath });
  return {
    markdown: String(fallback?.value || '').trim(),
    fileType: 'docx',
    warning: 'Structured conversion produced nothing; fell back to raw text.'
  };
}

async function convertXlsx(filePath: string): Promise<MarkdownConversion> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sections: string[] = [];
  workbook.eachSheet((sheet, sheetId) => {
    const rows: unknown[][] = [];
    const rowNumbers: number[] = [];
    sheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rowNumbers.push(row.number);
      rows.push(values.map((cell) => {
        if (cell && typeof cell === 'object') {
          const rich = cell as { text?: string; result?: unknown; hyperlink?: string };
          return rich.text ?? rich.result ?? rich.hyperlink ?? '';
        }
        return cell ?? '';
      }));
    });
    const table = toMarkdownTable(rows, { rowNumbers });
    if (table) sections.push(`## Sheet ${sheetId}: ${sheet.name}\n\n${table}`);
  });

  return {
    markdown: sections.join('\n\n'),
    fileType: 'xlsx',
    warning: sections.length ? undefined : 'Workbook contained no readable cells.'
  };
}

/** PPTX is a zip of `ppt/slides/slideN.xml`; each `<a:t>` node is a text run. */
async function convertPptx(filePath: string): Promise<MarkdownConversion> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));

  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const num = (s: string) => Number(s.match(/slide(\d+)\.xml$/)?.[1] || 0);
      return num(a) - num(b);
    });

  const sections: string[] = [];
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async('string');
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => m[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim())
      .filter(Boolean);
    if (!runs.length) continue;

    // First run on a slide is nearly always its title.
    const [title, ...body] = runs;
    const lines = [`## Slide ${i + 1}: ${title}`];
    if (body.length) lines.push('', ...body.map((line) => `- ${line}`));
    sections.push(lines.join('\n'));
  }

  return {
    markdown: sections.join('\n\n'),
    fileType: 'pptx',
    warning: sections.length ? undefined : 'No slide text found.'
  };
}

/**
 * HTML → Markdown. Shared by .html files and by DOCX, which mammoth renders to
 * HTML first. Handles the block structure that matters for retrieval —
 * headings, lists, tables, code, quotes — and flattens everything else to text.
 */
let cachedParseHTML: ((html: string) => { document: Document }) | null = null;

function htmlToMarkdown(html: string): string {
  if (!cachedParseHTML) throw new Error('htmlToMarkdown called before linkedom was loaded');

  // mammoth hands back a bare fragment (`<h1>…</h1><p>…</p>`). Parsed as-is,
  // `documentElement` is just the first element, so every following sibling is
  // dropped. Wrapping guarantees a real body to walk.
  const wrapped = /<body[\s>]/i.test(html) ? html : `<body>${html}</body>`;
  const { document } = cachedParseHTML(wrapped);

  document.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

  const walk = (node: Element): string => {
    const tag = node.tagName?.toLowerCase();
    const text = () => (node.textContent || '').replace(/\s+/g, ' ').trim();

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

    return [...node.children].map(walk).join('') ||
      (node.children.length === 0 && text() ? `${text()}\n\n` : '');
  };

  const body = document.querySelector('body') || document.documentElement;
  return walk(body as unknown as Element).replace(/\n{3,}/g, '\n\n').trim();
}

async function loadHtmlParser(): Promise<void> {
  if (cachedParseHTML) return;
  const { parseHTML } = await import('linkedom');
  cachedParseHTML = parseHTML as unknown as (html: string) => { document: Document };
}

async function convertHtml(filePath: string): Promise<MarkdownConversion> {
  await loadHtmlParser();
  return { markdown: htmlToMarkdown(fs.readFileSync(filePath, 'utf8')), fileType: 'html' };
}

type PdfTextPage = { getTextContent: (options?: unknown) => Promise<{ items: Array<{ str: string; transform: number[] }> }> };

/** pdf.js lays text out run by run; a new y coordinate is a new line. */
async function pdfPageText(page: PdfTextPage): Promise<string> {
  const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  let lastY: number | undefined;
  let text = '';
  for (const item of content.items) {
    text += lastY === undefined || lastY === item.transform[5] ? item.str : `\n${item.str}`;
    lastY = item.transform[5];
  }
  return text;
}

async function convertPdf(filePath: string): Promise<MarkdownConversion> {
  const pdfParse = (await import('pdf-parse')).default;
  // The pdf.js build inside pdf-parse duck-types a Node Buffer as an ArrayBuffer
  // and reads its whole backing pool, so a classic xref table fails with
  // "bad XRef entry"; a Uint8Array of exactly the file's bytes parses cleanly.
  // pdf-parse 1.1.x also joins the pages with a blank line and inserts no separator
  // of its own, so the page headings below never appeared and every citation
  // carried Markdown line numbers that mean nothing inside a PDF. Marking the
  // boundary inside `pagerender` is the only seam the library leaves open.
  const data = await pdfParse(new Uint8Array(fs.readFileSync(filePath)), {
    pagerender: async (page: PdfTextPage) => `\f${await pdfPageText(page)}`
  });
  const raw = String(data?.text || '').replace(/ /g, ' ');

  // Each marked page becomes a heading, so a retrieved chunk is cited as
  // `page 3` instead of a line range that does not exist in the document.
  const pages = raw.split('\f').map((page) => page.trim()).filter(Boolean);
  const markdown = pages.length > 1
    ? pages.map((page, i) => `## Page ${i + 1}\n\n${page}`).join('\n\n')
    : (pages[0] || '');

  const words = markdown.match(/[\p{L}\p{N}]{2,}/gu) || [];
  if (markdown.length < 80 || words.length < 20) {
    throw new Error('PDF parser returned insufficient readable text');
  }
  const expectedPages = Number(data?.numpages) || 0;
  return {
    markdown,
    fileType: 'pdf',
    warning: expectedPages > pages.length
      ? `Read ${pages.length} of ${expectedPages} pages; the rest had no extractable text.`
      : undefined
  };
}

function convertPlainText(filePath: string, ext: string): MarkdownConversion {
  const buffer = fs.readFileSync(filePath);
  if (looksBinary(buffer)) {
    throw new Error(`Unsupported binary file: ${path.basename(filePath)}`);
  }
  const text = buffer.toString('utf8');

  if (ext === '.md' || ext === '.markdown') return { markdown: text, fileType: 'markdown' };

  if (ext === '.csv' || ext === '.tsv') {
    const table = toMarkdownTable(parseDelimited(text, ext === '.tsv' ? '\t' : ','));
    return { markdown: table || text, fileType: 'csv' };
  }

  if (CODE_EXTENSIONS.has(ext)) {
    return {
      markdown: `\`\`\`${CODE_FENCE_LANG[ext] || ''}\n${text.trim()}\n\`\`\``,
      fileType: 'code'
    };
  }

  if (ext === '.json' || ext === '.jsonl') {
    return { markdown: `\`\`\`json\n${text.trim()}\n\`\`\``, fileType: 'json' };
  }

  return { markdown: text, fileType: 'text' };
}

/**
 * Converts any supported document to Markdown.
 *
 * Throws for formats we cannot read rather than returning decoded binary — a
 * garbage document indexed into RAG poisons retrieval far more quietly than a
 * visible failure.
 */
export async function convertFileToMarkdown(filePath: string): Promise<MarkdownConversion> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.docx') return convertDocx(filePath);
  if (ext === '.xlsx' || ext === '.xlsm') return convertXlsx(filePath);
  if (ext === '.pptx') return convertPptx(filePath);
  if (ext === '.html' || ext === '.htm') return convertHtml(filePath);
  if (ext === '.pdf') return convertPdf(filePath);

  if (TEXT_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) {
    return convertPlainText(filePath, ext);
  }

  // Unknown extension: allow it only if it really is text.
  const buffer = fs.readFileSync(filePath);
  if (looksBinary(buffer)) {
    throw new Error(`Unsupported file type: ${ext || path.basename(filePath)}`);
  }
  return { markdown: buffer.toString('utf8'), fileType: 'text' };
}

/** Extensions `convertFileToMarkdown` handles as a structured format. */
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.html', '.htm',
  ...TEXT_EXTENSIONS, ...CODE_EXTENSIONS
];
