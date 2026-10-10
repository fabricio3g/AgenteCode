import { normalizeReportDocument, reportSections, reportEndmatter, type ReportDocument } from '$shared/report-document';
export type { ReportDocument } from '$shared/report-document';
import type { PresentationData, SlideData } from '$lib/types/bridge';
import {
  escapeHtml,
  tableData,
  text,
  type SheetInput, type SectionInput
} from '$shared/work-product';
import { ARTIFACT_BRAND, artifactDocumentHtml, type ArtifactAccent, type ArtifactTheme } from '$shared/artifact-theme';
import { renderMarkdown } from '$lib/utils/markdown';
import { normalizeDeck, type DeckSpec } from '$shared/deck';
import { invoke } from './bridge';

export type GeneratedBinary = {
  bytes: number[];
  mime: string;
};

/** What a generated binary was built from; see `specPathFor`. */
export type GeneratedFileSpec =
  | { kind: 'deck'; deck: DeckSpec }
  | { kind: 'report'; report: ReportDocument }
  | { kind: 'workbook'; title: string; sheets: SheetInput[] };

export type GeneratedArtifactFile = {
  path: string;
  mime: string;
  dataUrl: string;
  previewHtml: string;
  spec?: GeneratedFileSpec;
};

export type WorkProductFormat = 'md' | 'html' | 'docx' | 'xlsx' | 'pdf' | 'pptx';

const MIME_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf'
};

function normalizePath(path: unknown, fallback: string): string {
  const raw = text(path, fallback).replace(/^\/+/, '').replace(/\\/g, '/');
  const cleaned = raw.replace(/[/\\:*?"<>|]+/g, '-').replace(/^-+/, '');
  return cleaned || fallback;
}

function ensureExt(path: string, ext: string): string {
  return path.toLowerCase().endsWith(`.${ext}`) ? path : `${path}.${ext}`;
}

function wordCount(value: unknown): number {
  return text(value).split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function sectionBodyWordCount(section: SectionInput): number {
  return wordCount(section.content) + (section.bullets || []).reduce((sum, bullet) => sum + wordCount(bullet), 0);
}

function hasMeaningfulNarrative(report: ReportDocument): boolean {
  if (wordCount(report.executiveSummary) >= 18) return true;
  return (report.sections || []).some((section) => {
    const heading = (section.title || section.heading || '').toLowerCase();
    if (['sources', 'source', 'limitations', 'methodology', 'appendix'].includes(heading)) return false;
    return sectionBodyWordCount(section) >= 18 || (section.bullets || []).filter((bullet) => wordCount(bullet) >= 5).length >= 2;
  });
}

function hasTableRows(report: ReportDocument): boolean {
  return !!report.tables?.some((table) => Array.isArray(table.rows) && table.rows.length > 0);
}

function hasSourceRows(report: ReportDocument): boolean {
  return !!report.sources?.some((source) => source.title || source.url || source.snippet);
}

function hasLimitations(report: ReportDocument): boolean {
  return !!report.limitations?.some((item) => wordCount(item) >= 3);
}

function validateReportForFormats(report: ReportDocument, formats: string[]): string | null {
  const formatSet = new Set(formats.map((format) => format.toLowerCase()));
  const wantsNarrative = ['md', 'html', 'docx', 'pdf'].some((format) => formatSet.has(format));
  const wantsSlides = formatSet.has('pptx');
  const wantsSheet = formatSet.has('xlsx');
  // The report attached a source list, so it claims to be evidence-based.
  // (This was previously `hasSourceRows(report)`, which made the check below
  // `x && !x` — always false, so the rule never actually fired.)
  const claimsEvidence = (report.sources?.length || 0) > 0;

  if ((wantsNarrative || wantsSlides) && !hasMeaningfulNarrative(report) && !(wantsNarrative && !wantsSlides && hasTableRows(report))) {
    return 'Document content is too thin: sections need body content, not only titles.';
  }
  if (claimsEvidence && !hasSourceRows(report) && !hasLimitations(report)) {
    return 'Document content is too thin: include sources or limitations for evidence-based work.';
  }
  if (wantsSheet && !hasTableRows(report) && !hasSourceRows(report) && !hasMeaningfulNarrative(report)) {
    return 'Spreadsheet content is too thin: provide data rows, source rows, or an evidence-backed summary.';
  }
  if (wantsSlides) {
    const contentSlides = reportToSlides(report).slice(1).filter((slide) =>
      Array.isArray(slide.content) && slide.content.some((item) => wordCount(item) >= 4)
    );
    if (!contentSlides.length) return 'Presentation content is too thin: add at least one content slide with meaningful bullets.';
  }
  return null;
}

/** A `create_report` call rendered as a standalone HTML page. */
export function renderReportHtml(args: Record<string, unknown>, options: { theme?: ArtifactTheme; accent?: ArtifactAccent } = {}): string {
  return htmlReport(normalizeReportDocument(args), '', options);
}

/** A `create_report` call rendered as Markdown. */
export function renderReportMarkdown(args: Record<string, unknown>): string {
  return markdownReport(normalizeReportDocument(args));
}

export function validateGeneratedDocumentArgs(args: Record<string, unknown>, formats: string[]): { ok: boolean; error?: string } {
  const report = normalizeReportDocument(args);
  const formatSet = new Set(formats.map((format) => format.toLowerCase()));
  const rawSlides = Array.isArray(args.slides) ? args.slides as Array<Record<string, unknown>> : [];
  const rawRows = Array.isArray(args.rows) ? args.rows : [];
  const rawSheets = Array.isArray(args.sheets) ? args.sheets as Array<Record<string, unknown>> : [];
  const hasMeaningfulRawSlides = rawSlides.some((slide) => {
    // Tables, charts, numbers and quotes are content too, not just bullets.
    if (slide.table || slide.chart || (Array.isArray(slide.stats) && slide.stats.length) || wordCount(slide.quote) >= 4) return true;
    if (slide.left || slide.right) return true;
    const content = Array.isArray(slide.content)
      ? slide.content
      : Array.isArray(slide.bullets)
        ? slide.bullets
        : [slide.content];
    return content.some((item) => wordCount(item) >= 4);
  });
  if (formatSet.size === 1 && formatSet.has('pptx') && hasMeaningfulRawSlides) {
    return { ok: true };
  }
  if (formatSet.size === 1 && formatSet.has('xlsx') && (rawRows.length > 0 || rawSheets.some((sheet) => Array.isArray(sheet.rows) && sheet.rows.length > 0))) {
    return { ok: true };
  }
  const error = validateReportForFormats(report, formats);
  return error ? { ok: false, error } : { ok: true };
}

function assertValidGeneratedDocument(args: Record<string, unknown>, formats: string[]) {
  const result = validateGeneratedDocumentArgs(args, formats);
  if (!result.ok) throw new Error(result.error || 'Document content is too thin.');
}

function markdownReport(report: ReportDocument): string {
  const lines = [`# ${report.title}`];
  if (report.subtitle) lines.push('', report.subtitle);
  lines.push('', `_${reportMeta(report)}_`);
  const addSection = (section: SectionInput) => {
    const heading = section.title || section.heading;
    lines.push('');
    if (heading) lines.push(`## ${heading}`, '');
    if (section.content) lines.push(section.content.trim(), '');
    for (const bullet of section.bullets || []) lines.push(`- ${bullet}`);
    if (section.citations?.length) lines.push('', `Sources: ${section.citations.join(', ')}`);
  }
  for (const section of reportSections(report, true, false)) addSection(section);
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  for (const table of report.tables || []) {
    const { headers, rows } = tableData(table);
    lines.push('', `## ${table.title || table.name || 'Table'}`, '');
    if (table.description) lines.push(table.description, '');
    if (headers.length) {
      lines.push(`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`);
      for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
    }
  }
  for (const section of reportEndmatter(report)) addSection(section);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Section prose is markdown from the model; render it, never show raw `**`. */
function sectionBodyHtml(markdown: string): string {
  return renderMarkdown(markdown, { highlight: false, math: false, cache: false });
}

export function htmlReport(
  report: ReportDocument,
  label = '',
  options: { theme?: ArtifactTheme; accent?: ArtifactAccent } = {}
): string {
  const tables = (report.tables || []).map((table) => {
    const { headers, rows } = tableData(table);
    const heading = table.title || table.name;
    return `<section>${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}${table.description ? `<p>${escapeHtml(table.description)}</p>` : ''}<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
  }).join('');
  const sectionHtml = (section: SectionInput) => {
    const heading = section.title || section.heading;
    const body = section.content ? sectionBodyHtml(section.content) : '';
    const bullets = section.bullets?.length
      ? `<ul>${section.bullets.map((bullet) => `<li>${sectionBodyHtml(bullet).replace(/^<p>|<\/p>\s*$/g, '')}</li>`).join('')}</ul>`
      : '';
    const citations = section.citations?.length
      ? `<p class="citations">${section.citations.map(escapeHtml).join(' · ')}</p>`
      : '';
    return `<section>${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}${body}${bullets}${citations}</section>`;
  };
  const sections = reportSections(report, false, false).map(sectionHtml).join('');
  const endmatter = reportEndmatter(report).map(sectionHtml).join('');
  const metrics = report.metrics?.length
    ? `<div class="metrics">${report.metrics.map((metric) => `<div><strong>${escapeHtml(metric.value ?? '')}</strong><span>${escapeHtml(metric.label || '')}</span>${metric.note ? `<small>${escapeHtml(metric.note)}</small>` : ''}</div>`).join('')}</div>`
    : '';
  return artifactDocumentHtml({
    title: report.title,
    eyebrow: label,
    subtitle: report.subtitle,
    meta: reportMeta(report),
    body: `${metrics}${sections}${tables}${endmatter}`,
    theme: options.theme,
    accent: options.accent
  });
}

/** "Agente · 2026-09-24" — who made it and when, nothing louder. */
function reportMeta(report: ReportDocument): string {
  return [report.author || ARTIFACT_BRAND, report.date].filter(Boolean).join(' · ');
}

function bytesToBase64(bytes: number[]): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

export function bytesToDataUrl(bytes: number[], mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function documentPreviewFromReport(report: ReportDocument, label: string): string {
  return htmlReport(report, label);
}

function spreadsheetPreview(title: string, sheets: SheetInput[]): string {
  const sheetHtml = sheets.map((sheet, sheetIndex) => {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    let columns = Array.isArray(sheet.columns) ? sheet.columns : [];
    if (!columns.length) {
      const objectRow = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown> | undefined;
      if (objectRow) columns = Object.keys(objectRow);
    }
    const headers = columns.map((column) => typeof column === 'string' ? column : text(column?.header || column?.key, 'Column'));
    const keys = columns.map((column, index) => typeof column === 'string' ? column : text(column?.key || column?.header, headers[index]));
    const head = headers.length ? `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>` : '';
    const body = rows.slice(0, 200).map((row) => {
      const cells = Array.isArray(row)
        ? row
        : keys.length
          ? keys.map((key) => (row as Record<string, unknown>)?.[key])
          : Object.values((row || {}) as Record<string, unknown>);
      return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
    }).join('');
    return `<section><h2>${escapeHtml(sheet.name || `Sheet ${sheetIndex + 1}`)}</h2><div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div></section>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Inter,Segoe UI,system-ui,sans-serif;margin:0;padding:32px;background:#f8fafc;color:#172033}
    h1{font-size:28px;margin:0 0 22px} h2{font-size:16px;margin:0 0 10px}
    section{margin-bottom:26px}.table-wrap{overflow:auto;border:1px solid #d8e0ea;background:white}
    table{border-collapse:collapse;min-width:100%;font-size:13px}th,td{border:1px solid #e2e8f0;padding:8px 10px;text-align:left;vertical-align:top}
    th{background:#eef2f7;font-weight:700;color:#334155}td{white-space:pre-wrap}
  </style></head><body><h1>${escapeHtml(title)}</h1>${sheetHtml}</body></html>`;
}

function presentationPreview(title: string, slides: SlideData[]): string {
  const slideHtml = slides.map((slide, index) => `
    <section class="slide">
      <div class="num">${index + 1}</div>
      <h2>${escapeHtml(slide.title)}</h2>
      <ul>${(slide.content || []).map((item) => `<li>${escapeHtml(item.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>
      ${slide.notes ? `<p class="notes">${escapeHtml(slide.notes)}</p>` : ''}
    </section>
  `).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Inter,Segoe UI,system-ui,sans-serif;margin:0;padding:28px;background:#111827;color:#f8fafc}
    h1{font-size:24px;margin:0 0 22px}.deck{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
    .slide{position:relative;aspect-ratio:16/9;border:1px solid rgba(255,255,255,.16);background:#f8fafc;color:#172033;padding:26px;box-sizing:border-box;overflow:hidden}
    .num{position:absolute;right:16px;top:12px;color:#64748b;font-size:12px}.slide h2{font-size:24px;line-height:1.15;margin:12px 0 18px}
    li{margin:9px 0;font-size:15px}.notes{position:absolute;left:26px;right:26px;bottom:16px;margin:0;color:#64748b;font-size:11px}
  </style></head><body><h1>${escapeHtml(title)}</h1><div class="deck">${slideHtml}</div></body></html>`;
}

function pdfPreview(title: string, dataUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#111827;color:#f8fafc;font-family:Inter,Segoe UI,system-ui,sans-serif}
    header{height:42px;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.12);font-size:13px}
    iframe{width:100%;height:calc(100% - 43px);border:0;background:white}
  </style></head><body><header>${escapeHtml(title)}</header><iframe src="${dataUrl}" title="${escapeHtml(title)}"></iframe></body></html>`;
}

function buildFile(path: string, mime: string, bytes: number[], previewHtml: string): GeneratedArtifactFile {
  return { path, mime, dataUrl: bytesToDataUrl(bytes, mime), previewHtml };
}

export async function createDocxArtifactFile(args: Record<string, unknown>): Promise<GeneratedArtifactFile> {
  assertValidGeneratedDocument(args, ['docx']);
  const report = normalizeReportDocument(args);
  const title = report.title;
  const path = ensureExt(normalizePath(args.path, `${title || 'document'}.docx`), 'docx');
  const generated = await invoke<GeneratedBinary>('generate_docx', { data: report });
  return { ...buildFile(path, generated.mime || MIME_BY_EXT.docx, generated.bytes, documentPreviewFromReport(report, '')), spec: { kind: 'report', report } };
}

export async function createXlsxArtifactFile(args: Record<string, unknown>): Promise<GeneratedArtifactFile> {
  assertValidGeneratedDocument(args, ['xlsx']);
  const report = normalizeReportDocument(args);
  const title = report.title || text(args.title, 'Workbook');
  const sheets = Array.isArray(args.sheets) ? args.sheets as SheetInput[] : [{
    name: 'Data',
    columns: Array.isArray(args.columns) ? args.columns as SheetInput['columns'] : undefined,
    rows: Array.isArray(args.rows) ? args.rows as SheetInput['rows'] : []
  }];
  const professionalSheets = buildWorkbookSheets(report, sheets);
  const path = ensureExt(normalizePath(args.path, `${title || 'workbook'}.xlsx`), 'xlsx');
  const generated = await invoke<GeneratedBinary>('generate_xlsx', { data: { title, sheets: professionalSheets } });
  return { ...buildFile(path, generated.mime || MIME_BY_EXT.xlsx, generated.bytes, spreadsheetPreview(title, professionalSheets)), spec: { kind: 'workbook', title, sheets: professionalSheets } };
}

export async function createPptxArtifactFile(args: Record<string, unknown>): Promise<GeneratedArtifactFile> {
  assertValidGeneratedDocument(args, ['pptx']);
  const report = normalizeReportDocument(args);
  const title = report.title || text(args.title, 'Presentation');
  const rawSlides = Array.isArray(args.slides) ? args.slides as Array<Record<string, unknown>> : reportToSlides(report);
  // One deck spec drives the .pptx (main/slides.ts), the in-app slides and later edits.
  const deck = normalizeDeck({ ...args, title, slides: rawSlides });
  const path = ensureExt(normalizePath(args.path, `${title || 'presentation'}.pptx`), 'pptx');
  const bytes = await invoke<number[]>('generate_pptx', { data: deck });
  const outline: SlideData[] = deck.slides.map((slide) => ({ title: slide.title, content: slide.bullets, notes: slide.notes ?? null, layout: slide.layout }));
  return { ...buildFile(path, MIME_BY_EXT.pptx, bytes, presentationPreview(title, outline)), spec: { kind: 'deck', deck } };
}

export async function createPdfArtifactFile(args: Record<string, unknown>): Promise<GeneratedArtifactFile> {
  assertValidGeneratedDocument(args, ['pdf']);
  const report = normalizeReportDocument(args);
  const title = report.title;
  const path = ensureExt(normalizePath(args.path, `${title || 'document'}.pdf`), 'pdf');
  const generated = await invoke<GeneratedBinary>('generate_pdf', { data: { ...report, html: htmlReport(report) } });
  const dataUrl = bytesToDataUrl(generated.bytes, generated.mime || MIME_BY_EXT.pdf);
  return { path, mime: generated.mime || MIME_BY_EXT.pdf, dataUrl, previewHtml: pdfPreview(title, dataUrl), spec: { kind: 'report', report } };
}

function buildWorkbookSheets(report: ReportDocument, fallbackSheets: SheetInput[]): SheetInput[] {
  const rowsFromSources = (report.sources || []).map((source, index) => ({
    '#': source.id || index + 1,
    title: source.title || '',
    url: source.url || '',
    provider: source.provider || '',
    snippet: source.snippet || ''
  }));
  const summaryRows = [
    { field: 'Title', value: report.title },
    { field: 'Subtitle', value: report.subtitle || '' },
    { field: 'Date', value: report.date || '' },
    { field: 'Summary', value: report.executiveSummary || '' },
    { field: 'Limitations', value: (report.limitations || []).join('; ') }
  ];
  const tableSheets = (report.tables?.length ? report.tables : fallbackSheets)
    .map((sheet, index) => ({
      name: sheet.name || `Data ${index + 1}`,
      columns: sheet.columns,
      rows: sheet.rows || []
    }))
    .filter((sheet) => sheet.rows?.length || sheet.columns?.length);
  return [
    { name: 'Summary', columns: ['field', 'value'], rows: summaryRows },
    ...tableSheets,
    ...(report.metrics?.length ? [{ name: 'Key figures', columns: ['Metric', 'Value', 'Note'], rows: report.metrics.map((metric) => [metric.label || '', metric.value ?? '', metric.note || '']) }] : []),
    ...(rowsFromSources.length ? [{ name: 'Sources', columns: ['#', 'title', 'url', 'provider', 'snippet'], rows: rowsFromSources }] : []),
    ...(report.limitations?.length ? [{ name: 'Methodology', columns: ['note'], rows: report.limitations.map((note) => ({ note })) }] : [])
  ];
}

/** Paginate the entire report; decimals and long sections are never discarded. */
export function reportToSlides(report: ReportDocument): Array<Record<string, unknown>> {
  const slides: Array<Record<string, unknown>> = [{ title: report.title, subtitle: report.subtitle, layout: 'title', notes: reportMeta(report) }];
  const split = (value: string) => {
    const parts: string[] = [];
    for (const paragraph of value.split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
      let part = '';
      for (const word of paragraph.split(/\s+/)) {
        if (part && part.length + word.length + 1 > 240) { parts.push(part); part = ''; }
        part += (part ? ' ' : '') + word;
      }
      if (part) parts.push(part);
    }
    return parts;
  };
  const add = (title: string, items: string[], notes = '') => {
    for (let start = 0; start < items.length; start += 5) slides.push({
      title: start ? `${title} (${Math.floor(start / 5) + 1})` : title, layout: 'bullets', content: items.slice(start, start + 5), notes
    });
  };
  if (report.executiveSummary) add('Executive summary', split(report.executiveSummary));
  for (const section of [...(report.sections || []), ...(report.appendix || [])]) {
    const items = [...split(text(section.content)), ...(section.bullets || []).flatMap(split)];
    if (items.length) add(section.title || section.heading || 'Section', items, section.citations?.join(' · '));
    else if (section.title || section.heading) slides.push({ title: section.title || section.heading, layout: 'section' });
  }
  for (const table of report.tables || []) {
    const { headers, rows } = tableData(table);
    if (rows.length) slides.push({ title: table.name || table.title || 'Table', layout: 'table', table: { columns: headers, rows }, notes: table.description });
  }
  if (report.metrics?.length) {
    for (let i = 0; i < report.metrics.length; i += 4) slides.push({ title: 'Key figures', layout: 'stats',
      stats: report.metrics.slice(i, i + 4), notes: report.metrics.slice(i, i + 4).map((metric) => metric.note).filter(Boolean).join('\n') });
  }
  if (report.sources?.length) add('Sources', report.sources.map((source, index) => `[${source.id || index + 1}] ${source.title || source.url}${source.url && source.title !== source.url ? ` — ${source.url}` : ''}`));
  if (report.limitations?.length) add('Limitations', report.limitations.flatMap(split));
  return slides;
}

export async function createWorkProductArtifactFiles(args: Record<string, unknown>): Promise<{ files: GeneratedArtifactFile[]; markdown?: string; html?: string; warnings: string[] }> {
  const report = normalizeReportDocument(args);
  const requested = Array.isArray(args.formats) ? args.formats.map((format) => text(format).toLowerCase()) : [];
  const formats = (requested.length ? requested : ['md']).filter((format): format is WorkProductFormat =>
    ['md', 'html', 'docx', 'xlsx', 'pdf', 'pptx'].includes(format)
  );
  const unsupported = requested.filter((format) => !formats.includes(format as WorkProductFormat));
  if (unsupported.length) throw new Error(`Unsupported document format: ${unsupported.join(', ')}`);
  assertValidGeneratedDocument(args, formats);
  const base = normalizePath(args.path || args.basePath, report.title || 'report').replace(/\.(md|html|docx|xlsx|pdf|pptx)$/i, '');
  const files: GeneratedArtifactFile[] = [];
  const warnings: string[] = [];
  const markdown = markdownReport(report);
  const html = htmlReport(report);

  for (const format of Array.from(new Set(formats))) {
    if (format === 'md') {
      files.push({ path: `${base}.md`, mime: 'text/markdown', dataUrl: `data:text/markdown;charset=utf-8;base64,${bytesToBase64(Array.from(new TextEncoder().encode(markdown)))}`, previewHtml: html });
    } else if (format === 'html') {
      files.push({ path: `${base}.html`, mime: 'text/html', dataUrl: `data:text/html;charset=utf-8;base64,${bytesToBase64(Array.from(new TextEncoder().encode(html)))}`, previewHtml: html });
    } else if (format === 'docx') {
      files.push(await createDocxArtifactFile({ ...args, ...report, path: `${base}.docx` }));
    } else if (format === 'xlsx') {
      const xlsx = await createXlsxArtifactFile({ ...args, ...report, path: `${base}.xlsx` });
      if (!report.tables?.some((table) => table.rows?.length) && !(Array.isArray(args.rows) && args.rows.length) && !(Array.isArray(args.sheets) && args.sheets.some((sheet) => sheet.rows?.length))) warnings.push('Spreadsheet contains summary/source structure but no extracted data rows.');
      files.push(xlsx);
    } else if (format === 'pptx') {
      files.push(await createPptxArtifactFile({ ...args, ...report, path: `${base}.pptx` }));
    } else if (format === 'pdf') {
      files.push(await createPdfArtifactFile({ ...args, ...report, path: `${base}.pdf` }));
    }
  }

  return { files, markdown, html, warnings };
}
