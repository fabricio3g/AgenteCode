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
import { convertOpenDocument, convertEpub, rtfToText } from './document-formats.ts';
import { loadHtmlParser, htmlToMarkdown } from './document-html.ts';
import { toMarkdownTable } from './document-tables.ts';
import { pdfTextLines } from '../shared/pdf-text.ts';

import type { MarkdownConversion } from './document-conversion-types.ts';
export type { MarkdownConversion } from './document-conversion-types.ts';

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
  if (suspicious / sample.length > 0.1) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true }); }
  catch { return true; }
  return false;
}

function readText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  // UTF-16 exports are common in Excel and Windows. Detect the BOM before the
  // binary check; a UTF-16 CSV's NUL bytes are not evidence of a binary file.
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  if (looksBinary(buffer)) throw new Error(`Unsupported binary file: ${path.basename(filePath)}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
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
  if (markdown) return { markdown, fileType: 'docx', warning: /<img\b/i.test(String(html?.value || ''))
    ? 'Embedded images were not analyzed; the extraction contains document text and tables.' : undefined };

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
          if (cell instanceof Date) return cell.toISOString();
          const rich = cell as { text?: string; result?: unknown; hyperlink?: string; richText?: Array<{ text: string }>; formula?: string; error?: string };
          return rich.text ?? rich.result ?? rich.richText?.map((run) => run.text).join('') ??
            (rich.formula ? `=${rich.formula} [result not stored]` : rich.hyperlink ?? rich.error ?? '');
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
  const { DOMParser } = await import('linkedom');
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async('string');
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const tables = [...document.getElementsByTagName('a:tbl')].map((table) => {
      const rows = [...table.getElementsByTagName('a:tr')].map((row) =>
        [...row.getElementsByTagName('a:tc')].map((cell) =>
          [...cell.getElementsByTagName('a:t')].map((run) => run.textContent || '').join(' ')));
      table.remove();
      return toMarkdownTable(rows);
    }).filter(Boolean);
    const runs = [...document.getElementsByTagName('a:t')].map((run) => (run.textContent || '').trim()).filter(Boolean);
    if (!runs.length && !tables.length) continue;

    // First run on a slide is nearly always its title.
    const [title = `Slide ${i + 1}`, ...body] = runs;
    const lines = [`## Slide ${i + 1}: ${title}`];
    if (body.length) lines.push('', ...body.map((line) => `- ${line}`));
    if (tables.length) lines.push('', tables.join('\n\n'));
    sections.push(lines.join('\n'));
  }

  return {
    markdown: sections.join('\n\n'),
    fileType: 'pptx',
    warning: sections.length ? undefined : 'No slide text found.'
  };
}

async function convertHtml(filePath: string): Promise<MarkdownConversion> {
  await loadHtmlParser();
  return { markdown: htmlToMarkdown(fs.readFileSync(filePath, 'utf8')), fileType: 'html' };
}

type PdfTextPage = { getTextContent: (options?: unknown) => Promise<{ items: Array<{ str: string; transform: number[]; width?: number }> }> };

/** pdf.js lays text out run by run; a new y coordinate is a new line. */
async function pdfPageText(page: PdfTextPage): Promise<string> {
  const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  return pdfTextLines(content.items).join('\n');
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
  const raw = String(data?.text || '').replace(/\u0000/g, ' ');

  // Each marked page becomes a heading, so a retrieved chunk is cited as
  // `page 3` instead of a line range that does not exist in the document.
  const pages = raw.split('\f').slice(1).map((page) => page.trim());
  // A single scan in an otherwise digital PDF still needs OCR. Do not drop
  // blank pages then renumber the remaining ones: that corrupts citations.
  if (!pages.length || pages.some((page) => !/[\p{L}\p{N}]/u.test(page))) {
    throw new Error('PDF contains pages without readable text; OCR is needed.');
  }
  const markdown = pages.map((page, i) => `## Page ${i + 1}\n\n${page}`).join('\n\n');
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
  const text = readText(filePath);

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
  if (['.odt', '.ods', '.odp'].includes(ext)) return convertOpenDocument(filePath);
  if (ext === '.epub') return convertEpub(filePath);
  if (ext === '.rtf') return { markdown: rtfToText(fs.readFileSync(filePath, 'latin1')), fileType: 'rtf' };
  if (['.doc', '.xls', '.ppt'].includes(ext)) {
    throw new Error(`Legacy ${ext.slice(1).toUpperCase()} needs an export as ${ext}x, PDF, CSV or OpenDocument before it can be read.`);
  }

  if (TEXT_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) {
    return convertPlainText(filePath, ext);
  }

  // Unknown extension: allow it only if it really is text.
  try { return { markdown: readText(filePath), fileType: 'text' }; }
  catch { throw new Error(`Unsupported file type: ${ext || path.basename(filePath)}`); }
}

/** Extensions `convertFileToMarkdown` handles as a structured format. */
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.html', '.htm', '.odt', '.ods', '.odp', '.epub', '.rtf',
  ...TEXT_EXTENSIONS, ...CODE_EXTENSIONS
];
