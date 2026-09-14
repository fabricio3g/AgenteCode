import type { PresentationData, SlideData } from '$lib/types/bridge';
import {
  escapeHtml,
  normalizeSections,
  text,
  type SectionInput,
  type SheetInput
} from '$shared/work-product';
import { invoke } from './bridge';

export type GeneratedBinary = {
  bytes: number[];
  mime: string;
};

export type GeneratedArtifactFile = {
  path: string;
  mime: string;
  dataUrl: string;
  previewHtml: string;
};

export type WorkProductFormat = 'md' | 'html' | 'docx' | 'xlsx' | 'pdf' | 'pptx';

type SourceInput = {
  id?: string;
  title?: string;
  url?: string;
  provider?: string;
  snippet?: string;
};

export type ReportDocument = {
  title: string;
  subtitle?: string;
  author?: string;
  date?: string;
  executiveSummary?: string;
  sections?: SectionInput[];
  tables?: Array<SheetInput & { title?: string; description?: string }>;
  metrics?: Array<{ label?: string; value?: string | number; note?: string }>;
  sources?: SourceInput[];
  limitations?: string[];
  appendix?: SectionInput[];
};

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

function normalizeSources(sources: unknown): SourceInput[] {
  if (!Array.isArray(sources)) return [];
  return sources.map((source, index) => {
    const item = (source && typeof source === 'object') ? source as Record<string, unknown> : {};
    return {
      id: text(item.id, String(index + 1)),
      title: text(item.title, text(item.name, `Source ${index + 1}`)),
      url: text(item.url),
      provider: text(item.provider),
      snippet: text(item.snippet, text(item.content))
    };
  }).filter((source) => source.title || source.url || source.snippet);
}

function normalizeTables(tables: unknown, fallbackSheets?: unknown): ReportDocument['tables'] {
  const raw = Array.isArray(tables) ? tables : (Array.isArray(fallbackSheets) ? fallbackSheets : []);
  return raw.map((table, index) => {
    const item = (table && typeof table === 'object') ? table as Record<string, unknown> : {};
    return {
      title: text(item.title),
      description: text(item.description),
      name: text(item.name, text(item.title, `Table ${index + 1}`)),
      columns: Array.isArray(item.columns) ? item.columns as SheetInput['columns'] : undefined,
      rows: Array.isArray(item.rows) ? item.rows as SheetInput['rows'] : []
    };
  }).filter((table) => table.name || table.rows?.length || table.columns?.length);
}

function normalizeReportDocument(args: Record<string, unknown>): ReportDocument {
  const title = text(args.title, 'Report');
  const sections = normalizeSections(args.sections, text(args.content));
  const sources = normalizeSources(args.sources);
  const limitations = Array.isArray(args.limitations) ? args.limitations.map((item) => text(item)).filter(Boolean) : [];
  return {
    title,
    subtitle: text(args.subtitle),
    author: text(args.author, 'Chatea'),
    date: text(args.date, new Date().toISOString().slice(0, 10)),
    executiveSummary: text(args.executiveSummary, text(args.summary)),
    sections,
    tables: normalizeTables(args.tables, args.sheets),
    metrics: Array.isArray(args.metrics) ? args.metrics as ReportDocument['metrics'] : [],
    sources,
    limitations,
    appendix: normalizeSections(args.appendix)
  };
}

function wordCount(value: unknown): number {
  return text(value).split(/\s+/).filter((word) => /[a-zA-Z0-9]/.test(word)).length;
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

  if ((wantsNarrative || wantsSlides) && !hasMeaningfulNarrative(report)) {
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

export function validateGeneratedDocumentArgs(args: Record<string, unknown>, formats: string[]): { ok: boolean; error?: string } {
  const report = normalizeReportDocument(args);
  const formatSet = new Set(formats.map((format) => format.toLowerCase()));
  const rawSlides = Array.isArray(args.slides) ? args.slides as Array<Record<string, unknown>> : [];
  const rawRows = Array.isArray(args.rows) ? args.rows : [];
  const rawSheets = Array.isArray(args.sheets) ? args.sheets as Array<Record<string, unknown>> : [];
  const hasMeaningfulRawSlides = rawSlides.some((slide) => {
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

function reportSections(report: ReportDocument): SectionInput[] {
  const sections: SectionInput[] = [];
  if (report.executiveSummary) sections.push({ title: 'Executive summary', content: report.executiveSummary });
  sections.push(...(report.sections || []));
  if (report.limitations?.length) sections.push({ title: 'Limitations', bullets: report.limitations });
  if (report.sources?.length) {
    sections.push({
      title: 'Sources',
      bullets: report.sources.map((source, index) =>
        `[${source.id || index + 1}] ${source.title || source.url}${source.url ? ` - ${source.url}` : ''}${source.snippet ? `\n${source.snippet}` : ''}`
      )
    });
  }
  sections.push(...(report.appendix || []));
  return sections;
}

function markdownReport(report: ReportDocument): string {
  const lines = [`# ${report.title}`];
  if (report.subtitle) lines.push('', report.subtitle);
  lines.push('', `Generated by ${report.author || 'Chatea'}${report.date ? ` on ${report.date}` : ''}`);
  for (const section of reportSections(report)) {
    const heading = section.title || section.heading || 'Section';
    lines.push('', `## ${heading}`, '');
    if (section.content) lines.push(section.content.trim(), '');
    for (const bullet of section.bullets || []) lines.push(`- ${bullet}`);
    if (section.citations?.length) lines.push('', `Sources: ${section.citations.join(', ')}`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function htmlReport(report: ReportDocument, label = 'Report'): string {
  const sections = reportSections(report).map((section) => {
    const heading = section.title || section.heading || 'Section';
    const paragraphs = section.content
      ? section.content.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part)}</p>`).join('')
      : '';
    const bullets = section.bullets?.length
      ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`
      : '';
    const citations = section.citations?.length
      ? `<p class="citations">Sources: ${section.citations.map(escapeHtml).join(', ')}</p>`
      : '';
    return `<section><h2>${escapeHtml(heading)}</h2>${paragraphs}${bullets}${citations}</section>`;
  }).join('');
  const metrics = report.metrics?.length
    ? `<div class="metrics">${report.metrics.map((metric) => `<div><strong>${escapeHtml(metric.value ?? '')}</strong><span>${escapeHtml(metric.label || '')}</span>${metric.note ? `<small>${escapeHtml(metric.note)}</small>` : ''}</div>`).join('')}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page{margin:24mm 20mm}*{box-sizing:border-box}body{font-family:Inter,Segoe UI,Arial,sans-serif;margin:0;background:#f5f7fb;color:#172033;line-height:1.62}
    .page{max-width:900px;margin:0 auto;background:#fff;min-height:100vh;padding:48px 56px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#64748b;font-weight:700}
    h1{font-size:38px;line-height:1.12;margin:12px 0 10px;color:#0f172a}h2{font-size:20px;margin:28px 0 10px;color:#172033}
    .subtitle{font-size:17px;color:#475569;margin:0 0 18px}.meta{font-size:12px;color:#64748b;border-bottom:1px solid #dbe3ee;padding-bottom:22px}
    section{break-inside:avoid;border-top:1px solid #e2e8f0;margin-top:24px;padding-top:18px}p{margin:0 0 12px;white-space:pre-wrap}li{margin:7px 0}.citations{font-size:12px;color:#64748b}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.metrics div{border:1px solid #dbe3ee;padding:14px;background:#f8fafc}.metrics strong{display:block;font-size:22px}.metrics span{font-size:12px;color:#475569}.metrics small{display:block;color:#64748b;margin-top:4px}
    @media print{body{background:#fff}.page{padding:0;max-width:none}}
  </style></head><body><main class="page"><div class="label">${escapeHtml(label)}</div><h1>${escapeHtml(report.title)}</h1>${report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>` : ''}<p class="meta">Generated by ${escapeHtml(report.author || 'Chatea')}${report.date ? ` on ${escapeHtml(report.date)}` : ''}</p>${metrics}${sections}</main></body></html>`;
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

function documentPreview(title: string, sections: SectionInput[], label: string): string {
  const body = sections.map((section) => {
    const heading = section.title || section.heading;
    const paragraphs = section.content
      ? section.content.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part)}</p>`).join('')
      : '';
    const bullets = section.bullets?.length
      ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`
      : '';
    return `<section>${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}${paragraphs}${bullets}</section>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Inter,Segoe UI,system-ui,sans-serif;max-width:850px;margin:0 auto;padding:42px;color:#172033;background:#fff;line-height:1.65}
    .label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:10px}
    h1{font-size:34px;line-height:1.15;margin:0 0 28px;color:#0f172a}
    h2{font-size:20px;margin:28px 0 10px;color:#1e293b}
    p{margin:0 0 14px;white-space:pre-wrap}
    li{margin:7px 0}
    section{border-top:1px solid #e2e8f0;padding-top:18px;margin-top:18px}
  </style></head><body><div class="label">${escapeHtml(label)}</div><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
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
  const sections = reportSections(report);
  const path = ensureExt(normalizePath(args.path, `${title || 'document'}.docx`), 'docx');
  const generated = await invoke<GeneratedBinary>('generate_docx', { data: { ...report, sections } });
  return buildFile(path, generated.mime || MIME_BY_EXT.docx, generated.bytes, documentPreviewFromReport(report, 'DOCX preview'));
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
  return buildFile(path, generated.mime || MIME_BY_EXT.xlsx, generated.bytes, spreadsheetPreview(title, professionalSheets));
}

export async function createPptxArtifactFile(args: Record<string, unknown>): Promise<GeneratedArtifactFile> {
  assertValidGeneratedDocument(args, ['pptx']);
  const report = normalizeReportDocument(args);
  const title = report.title || text(args.title, 'Presentation');
  const rawSlides = Array.isArray(args.slides) ? args.slides as Array<Record<string, unknown>> : reportToSlides(report);
  const slides: SlideData[] = rawSlides.map((slide, index) => ({
    title: text(slide.title, `Slide ${index + 1}`),
    content: Array.isArray(slide.content)
      ? slide.content.map((item) => text(item)).filter(Boolean)
      : Array.isArray(slide.bullets)
        ? slide.bullets.map((item) => text(item)).filter(Boolean)
        : text(slide.content) ? [text(slide.content)] : [],
    notes: text(slide.notes) || null,
    layout: text(slide.layout, 'default')
  })).filter((slide) => slide.title || slide.content.length);
  const deck: PresentationData = { title, slides };
  const path = ensureExt(normalizePath(args.path, `${title || 'presentation'}.pptx`), 'pptx');
  const bytes = await invoke<number[]>('generate_pptx', { data: deck });
  return buildFile(path, MIME_BY_EXT.pptx, bytes, presentationPreview(title, slides));
}

export async function createPdfArtifactFile(args: Record<string, unknown>): Promise<GeneratedArtifactFile> {
  assertValidGeneratedDocument(args, ['pdf']);
  const report = normalizeReportDocument(args);
  const title = report.title;
  const sections = reportSections(report);
  const path = ensureExt(normalizePath(args.path, `${title || 'document'}.pdf`), 'pdf');
  const generated = await invoke<GeneratedBinary>('generate_pdf', { data: { ...report, sections, html: htmlReport(report, 'PDF report') } });
  const dataUrl = bytesToDataUrl(generated.bytes, generated.mime || MIME_BY_EXT.pdf);
  return { path, mime: generated.mime || MIME_BY_EXT.pdf, dataUrl, previewHtml: pdfPreview(title, dataUrl) };
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
    ...(rowsFromSources.length ? [{ name: 'Sources', columns: ['#', 'title', 'url', 'provider', 'snippet'], rows: rowsFromSources }] : []),
    ...(report.limitations?.length ? [{ name: 'Methodology', columns: ['note'], rows: report.limitations.map((note) => ({ note })) }] : [])
  ];
}

function reportToSlides(report: ReportDocument): Array<Record<string, unknown>> {
  const slides: Array<Record<string, unknown>> = [
    { title: report.title, content: [report.subtitle, report.executiveSummary].filter(Boolean), notes: `Generated by ${report.author || 'Chatea'}${report.date ? ` on ${report.date}` : ''}` }
  ];
  for (const section of (report.sections || []).slice(0, 8)) {
    slides.push({
      title: section.title || section.heading || 'Section',
      content: section.bullets?.length ? section.bullets.slice(0, 5) : text(section.content).split(/[.\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 5)
    });
  }
  if (report.sources?.length) {
    slides.push({ title: 'Sources', content: report.sources.slice(0, 6).map((source, index) => `${index + 1}. ${source.title || source.url}`) });
  }
  if (report.limitations?.length) {
    slides.push({ title: 'Limitations', content: report.limitations.slice(0, 5) });
  }
  return slides;
}

export async function createWorkProductArtifactFiles(args: Record<string, unknown>): Promise<{ files: GeneratedArtifactFile[]; markdown?: string; html?: string; warnings: string[] }> {
  const report = normalizeReportDocument(args);
  const requested = Array.isArray(args.formats) ? args.formats.map((format) => text(format).toLowerCase()) : [];
  const formats = (requested.length ? requested : ['md']).filter((format): format is WorkProductFormat =>
    ['md', 'html', 'docx', 'xlsx', 'pdf', 'pptx'].includes(format)
  );
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
      files.push(await createDocxArtifactFile({ ...report, path: `${base}.docx` }));
    } else if (format === 'xlsx') {
      const xlsx = await createXlsxArtifactFile({ ...report, path: `${base}.xlsx` });
      if (!buildWorkbookSheets(report, []).some((sheet) => sheet.rows?.length)) warnings.push('Spreadsheet contains summary/source structure but no extracted data rows.');
      files.push(xlsx);
    } else if (format === 'pptx') {
      files.push(await createPptxArtifactFile({ ...report, path: `${base}.pptx` }));
    } else if (format === 'pdf') {
      files.push(await createPdfArtifactFile({ ...report, path: `${base}.pdf` }));
    }
  }

  return { files, markdown, html, warnings };
}
