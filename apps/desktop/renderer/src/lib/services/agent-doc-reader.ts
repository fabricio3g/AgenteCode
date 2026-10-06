/**
 * Document → text/rows for the Home agent's read_document / extract_tables.
 *
 * Reuses the parsers the app already ships: pdfjs-dist (PDF text layer),
 * exceljs (XLSX) and jszip (DOCX/PPTX are zips of XML). No new dependencies.
 * Everything is split into "units" — pages, sheets or slides — so the model can
 * ask for a range instead of a whole file.
 */

export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'text';
export type DocUnit = { label: string; text: string; tables: string[][][] };
export type ParsedDocument = { kind: DocKind; unitName: 'page' | 'sheet' | 'slide' | 'document'; units: DocUnit[] };

export function docKindOf(name: string, mime = ''): DocKind | null {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'pptx') return 'pptx';
  if (['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml', 'rtf'].includes(ext) || mime.startsWith('text/')) return 'text';
  return null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/** Text of one run container: <t> contents, tabs and breaks. `p` is the paragraph tag prefix ("w" or "a"). */
function paragraphText(xml: string, p: 'w' | 'a'): string {
  const textTag = p === 'w' ? 'w:t' : 'a:t';
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|<${p}:tab\\s*/>|<${p}:br\\s*/>`, 'g');
  let out = '';
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    out += m[1] !== undefined ? decodeXml(m[1]) : m[0].startsWith(`<${p}:tab`) ? '\t' : '\n';
  }
  return out;
}

function paragraphsOf(xml: string, p: 'w' | 'a'): string[] {
  const re = new RegExp(`<${p}:p(?:\\s[^>]*)?>([\\s\\S]*?)</${p}:p>`, 'g');
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(paragraphText(m[1], p));
  return out;
}

/** Tables found in `xml` (non-nested), plus the xml with each table replaced by a marker line. */
function pullTables(xml: string, p: 'w' | 'a'): { tables: string[][][]; rest: string } {
  const tbl = p === 'w' ? 'w:tbl' : 'a:tbl';
  const tr = p === 'w' ? 'w:tr' : 'a:tr';
  const tc = p === 'w' ? 'w:tc' : 'a:tc';
  const tables: string[][][] = [];
  const rest = xml.replace(new RegExp(`<${tbl}(?:\\s[^>]*)?>([\\s\\S]*?)</${tbl}>`, 'g'), (_, body: string) => {
    const rows: string[][] = [];
    for (const row of body.matchAll(new RegExp(`<${tr}(?:\\s[^>]*)?>([\\s\\S]*?)</${tr}>`, 'g'))) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(new RegExp(`<${tc}(?:\\s[^>]*)?>([\\s\\S]*?)</${tc}>`, 'g'))) {
        cells.push(paragraphsOf(cell[1], p).join(' ').replace(/\s+/g, ' ').trim());
      }
      rows.push(cells);
    }
    tables.push(rows);
    return `<${p}:p><${p === 'w' ? 'w:r><w:t' : 'a:r><a:t'}>[table ${tables.length}]</${p === 'w' ? 'w:t></w:r' : 'a:t></a:r'}></${p}:p>`;
  });
  return { tables, rest };
}

async function zipOf(bytes: ArrayBuffer) {
  const { default: JSZip } = await import('jszip');
  return JSZip.loadAsync(bytes);
}

async function parseDocx(bytes: ArrayBuffer): Promise<ParsedDocument> {
  const zip = await zipOf(bytes);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Not a valid .docx (word/document.xml missing)');
  const { tables, rest } = pullTables(await file.async('string'), 'w');
  const text = paragraphsOf(rest, 'w').join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { kind: 'docx', unitName: 'document', units: [{ label: 'document', text, tables }] };
}

async function parsePptx(bytes: ArrayBuffer): Promise<ParsedDocument> {
  const zip = await zipOf(bytes);
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((entry) => Number.isFinite(entry.n))
    .sort((a, b) => a.n - b.n);
  if (!slides.length) throw new Error('Not a valid .pptx (no slides found)');
  const units: DocUnit[] = [];
  for (const slide of slides) {
    const { tables, rest } = pullTables(await zip.file(slide.name)!.async('string'), 'a');
    units.push({ label: `slide ${slide.n}`, text: paragraphsOf(rest, 'a').filter((line) => line.trim()).join('\n'), tables });
  }
  return { kind: 'pptx', unitName: 'slide', units };
}

/** RFC 4180-ish CSV/TSV parse, tolerant of quotes and CRLF. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = delimiter ?? ([',', ';', '\t'].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function rowsToText(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n');
}

async function parseXlsx(bytes: ArrayBuffer): Promise<ParsedDocument> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const units: DocUnit[] = [];
  workbook.eachSheet((sheet) => {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') return;
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(String(row.getCell(c).text ?? '').trim());
      rows.push(cells);
    });
    units.push({ label: sheet.name, text: rowsToText(rows), tables: rows.length ? [rows] : [] });
  });
  return { kind: 'xlsx', unitName: 'sheet', units };
}

/** Lines of one PDF page from positioned text items; wide gaps become tabs so columns survive. */
function pdfPageLines(items: Array<{ str?: string; transform?: number[]; width?: number }>): string[] {
  const rows = new Map<number, Array<{ x: number; w: number; s: string }>>();
  for (const item of items) {
    if (!item.str || !item.transform) continue;
    const y = Math.round(item.transform[5] / 3);
    const list = rows.get(y) ?? [];
    list.push({ x: item.transform[4], w: item.width ?? 0, s: item.str });
    rows.set(y, list);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, list]) => {
      list.sort((a, b) => a.x - b.x);
      let line = '';
      let end = 0;
      for (const part of list) {
        if (line) line += part.x - end > 12 ? '\t' : part.x - end > 1 ? ' ' : '';
        line += part.s;
        end = part.x + part.w;
      }
      return line.trim();
    })
    .filter(Boolean);
}

/** Runs of 2+ consecutive lines with 2+ tab-separated cells read as a table (best effort for PDFs). */
export function tablesFromLines(lines: string[]): string[][][] {
  const tables: string[][][] = [];
  let run: string[][] = [];
  const flush = () => { if (run.length >= 2) tables.push(run); run = []; };
  for (const line of lines) {
    const cells = line.split('\t').map((c) => c.trim());
    if (cells.length >= 2) run.push(cells); else flush();
  }
  flush();
  return tables;
}

async function parsePdf(bytes: ArrayBuffer): Promise<ParsedDocument> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const units: DocUnit[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = pdfPageLines(content.items as Array<{ str?: string; transform?: number[]; width?: number }>);
    units.push({ label: `page ${i}`, text: lines.map((line) => line.replace(/\t/g, '  ')).join('\n'), tables: tablesFromLines(lines) });
  }
  return { kind: 'pdf', unitName: 'page', units };
}

export async function parseDocument(name: string, bytes: ArrayBuffer, mime = ''): Promise<ParsedDocument> {
  const kind = docKindOf(name, mime);
  if (!kind) throw new Error(`Unsupported document type: ${name}. Supported: PDF, DOCX, XLSX, CSV, PPTX, TXT/MD.`);
  switch (kind) {
    case 'pdf': return parsePdf(bytes);
    case 'docx': return parseDocx(bytes);
    case 'pptx': return parsePptx(bytes);
    case 'xlsx': return parseXlsx(bytes);
    case 'csv': {
      const rows = parseDelimited(new TextDecoder().decode(bytes), name.toLowerCase().endsWith('.tsv') ? '\t' : undefined);
      return { kind, unitName: 'sheet', units: [{ label: 'sheet 1', text: rowsToText(rows), tables: rows.length ? [rows] : [] }] };
    }
    default:
      return { kind: 'text', unitName: 'document', units: [{ label: 'document', text: new TextDecoder().decode(bytes), tables: [] }] };
  }
}

/** "3", "2-5", "1,4-6" or a sheet name → zero-based unit indexes. */
export function selectUnits(units: DocUnit[], selector: unknown): number[] {
  const all = units.map((_, i) => i);
  const raw = String(selector ?? '').trim();
  if (!raw) return all;
  const byName = units.findIndex((u) => u.label.toLowerCase() === raw.toLowerCase());
  if (byName >= 0) return [byName];
  const picked = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new Error(`Invalid selection "${raw}". Use a number, a range like 2-5, a list like 1,3,5, or a sheet name.`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let n = from; n <= Math.min(to, units.length); n++) if (n >= 1) picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}
