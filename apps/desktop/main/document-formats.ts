/** Structured readers for open document formats, using the bundled ZIP/XML tools. */
import fs from 'node:fs';
import path from 'node:path';
import type { MarkdownConversion } from './document-conversion-types.ts';

const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_CELLS = 1_000_000;

async function archive(filePath: string) {
  const { default: JSZip } = await import('jszip');
  return JSZip.loadAsync(fs.readFileSync(filePath));
}

async function entryText(zip: Awaited<ReturnType<typeof archive>>, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`Document is missing ${name}.`);
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declared && declared > MAX_ENTRY_BYTES) throw new Error('Document section exceeds the 32 MB reading limit.');
  const text = await entry.async('string');
  if (text.length > MAX_ENTRY_BYTES) throw new Error('Document section exceeds the 32 MB reading limit.');
  return text;
}

async function xmlDocument(xml: string): Promise<Document> {
  const { DOMParser } = await import('linkedom');
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

const tagOf = (node: Element) => node.tagName?.split(':').pop() || '';
const cellText = (value: string) => value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

function odfText(node: Element): string {
  const tag = tagOf(node);
  if (tag === 's') return ' '.repeat(Math.min(100, Number(node.getAttribute('text:c')) || 1));
  if (tag === 'tab') return '\t';
  if (tag === 'line-break') return '\n';
  const text = [...node.childNodes].map((child) => child.nodeType === 3 ? child.textContent : odfText(child as Element)).join('');
  if (tag === 'h') return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.getAttribute('text:outline-level')) || 1)))} ${text.trim()}\n\n`;
  if (tag === 'p') return `${text.trim()}\n\n`;
  return text;
}

function odfTable(table: Element, spreadsheet = false): string {
  const rows: string[][] = [];
  const numbers: number[] = [];
  let sourceRow = 1;
  let cellsRead = 0;
  for (const row of [...table.getElementsByTagName('table:table-row')]) {
    const repeatedRows = Number(row.getAttribute('table:number-rows-repeated')) || 1;
    const cells: string[] = [];
    for (const cell of [...row.children].filter((child) => ['table-cell', 'covered-table-cell'].includes(tagOf(child)))) {
      const value = cellText(odfText(cell)) || cell.getAttribute('office:string-value') ||
        cell.getAttribute('office:value') || cell.getAttribute('office:date-value') || cell.getAttribute('office:boolean-value') || '';
      const repeated = Number(cell.getAttribute('table:number-columns-repeated')) || 1;
      if (repeated < 1 || repeated > 16384) throw new Error('Spreadsheet column repetition exceeds the reading limit.');
      for (let i = 0; i < repeated; i++) cells.push(value);
    }
    // ODS pads unused sheet space with huge repeats. Empty tails are not data.
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (!cells.length) { sourceRow += repeatedRows; continue; }
    const repeated = repeatedRows;
    if (repeated < 1 || repeated * cells.length + cellsRead > MAX_CELLS) throw new Error('Spreadsheet exceeds the one million cell reading limit.');
    for (let i = 0; i < repeated; i++) { rows.push([...cells]); numbers.push(sourceRow++); }
    cellsRead += repeated * cells.length;
  }
  if (!rows.length) return '';
  if (spreadsheet) rows.forEach((row, i) => row.unshift(i === 0 ? '#' : String(numbers[i])));
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

export async function convertOpenDocument(filePath: string): Promise<MarkdownConversion> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const xml = await xmlDocument(await entryText(await archive(filePath), 'content.xml'));
  const body = xml.getElementsByTagName('office:body')[0];
  if (!body) throw new Error('OpenDocument has no readable body.');
  let markdown: string;
  if (ext === 'ods') {
    markdown = [...body.getElementsByTagName('table:table')].map((table, i) => {
      const text = odfTable(table, true);
      return text ? `## Sheet ${i + 1}: ${table.getAttribute('table:name') || `Sheet ${i + 1}`}\n\n${text}` : '';
    }).filter(Boolean).join('\n\n');
  } else if (ext === 'odp') {
    markdown = [...body.getElementsByTagName('draw:page')].map((page, i) =>
      `## Slide ${i + 1}: ${page.getAttribute('draw:name') || `Slide ${i + 1}`}\n\n${odfText(page).trim()}`).join('\n\n');
  } else {
    const walk = (node: Element): string => tagOf(node) === 'table' ? `${odfTable(node)}\n\n`
      : ['h', 'p'].includes(tagOf(node)) ? odfText(node)
      : [...node.children].map(walk).join('');
    markdown = walk(body).trim();
  }
  return { markdown, fileType: ext };
}

export async function convertEpub(filePath: string): Promise<MarkdownConversion> {
  const zip = await archive(filePath);
  const container = await xmlDocument(await entryText(zip, 'META-INF/container.xml'));
  const packagePath = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!packagePath) throw new Error('EPUB has no package document.');
  const pkg = await xmlDocument(await entryText(zip, packagePath));
  const items = new Map([...pkg.getElementsByTagName('item')].map((item) => [item.getAttribute('id'), item.getAttribute('href')]));
  const { loadHtmlParser, htmlToMarkdown } = await import('./document-html.ts');
  await loadHtmlParser();
  const sections: string[] = [];
  let length = 0;
  // Read in spine order, never ZIP/alphabetical order. Resources never execute.
  for (const ref of [...pkg.getElementsByTagName('itemref')]) {
    if (ref.getAttribute('linear') === 'no') continue;
    const href = items.get(ref.getAttribute('idref'));
    if (!href) throw new Error('EPUB spine refers to a missing chapter.');
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(packagePath), decodeURIComponent(href.split('#')[0])));
    const text = htmlToMarkdown(await entryText(zip, name));
    length += text.length;
    if (length > MAX_ENTRY_BYTES) throw new Error('EPUB exceeds the 32 MB reading limit.');
    if (text) sections.push(`## Chapter ${sections.length + 1}\n\n${text}`);
  }
  return { markdown: sections.join('\n\n'), fileType: 'epub' };
}

/** RTF groups/control words are formatting, not text to feed the model. */
export function rtfToText(rtf: string): string {
  if (!/^\{\\rtf\d/.test(rtf.trimStart())) throw new Error('Not a valid RTF document.');
  type State = { skip: boolean; uc: number };
  const states: State[] = [];
  let state: State = { skip: false, uc: 1 }, fallback = 0, out = '';
  const destinations = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'fldinst', 'header', 'footer']);
  const emit = (value: string) => { if (fallback > 0) fallback--; else if (!state.skip) out += value; };
  for (let i = 0; i < rtf.length;) {
    const ch = rtf[i++];
    if (ch === '{') { states.push(state); state = { ...state }; continue; }
    if (ch === '}') { state = states.pop() || state; continue; }
    if (ch !== '\\') { if (ch !== '\r' && ch !== '\n') emit(ch); continue; }
    const next = rtf[i];
    if (next === '*') { state.skip = true; i++; continue; }
    if (next === "'") {
      const byte = parseInt(rtf.slice(i + 1, i + 3), 16);
      if (Number.isFinite(byte)) emit(new TextDecoder('windows-1252').decode(Uint8Array.of(byte)));
      i += 3; continue;
    }
    if (next === '\\' || next === '{' || next === '}') { emit(next); i++; continue; }
    const word = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i));
    if (!word) { if (next === '~') emit(' '); i++; continue; }
    i += word[0].length;
    const cmd = word[1], value = Number(word[2]);
    if (destinations.has(cmd)) state.skip = true;
    else if (cmd === 'uc') state.uc = Math.max(0, Math.min(16, value));
    else if (cmd === 'u') { if (!state.skip) out += String.fromCharCode(value < 0 ? value + 65536 : value); fallback = state.uc; }
    else if (cmd === 'bin') i += Math.max(0, value);
    else if (cmd === 'par' || cmd === 'line') { if (!state.skip) out += '\n'; }
    else if (cmd === 'tab') { if (!state.skip) out += '\t'; }
    else if (['emdash', 'endash', 'bullet', 'lquote', 'rquote', 'ldblquote', 'rdblquote'].includes(cmd)) {
      emit(({ emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”' } as Record<string, string>)[cmd]);
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
