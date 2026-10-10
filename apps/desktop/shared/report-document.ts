/** One report vocabulary and normalization for every document format. */
import { normalizeSections, text, type SectionInput, type SheetInput } from './work-product.ts';
import { ARTIFACT_BRAND } from './artifact-theme.ts';

export type SourceInput = {
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

export function normalizeReportDocument(args: Record<string, unknown>): ReportDocument {
  const title = text(args.title, 'Report');
  const sections = normalizeSections(args.sections, text(args.content));
  const sources = normalizeSources(args.sources);
  const limitations = Array.isArray(args.limitations) ? args.limitations.map((item) => text(item)).filter(Boolean) : [];
  return {
    title,
    subtitle: text(args.subtitle),
    author: text(args.author, ARTIFACT_BRAND),
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

export function reportSections(report: ReportDocument, includeMetrics = true, includeEndmatter = true): SectionInput[] {
  const sections: SectionInput[] = [];
  if (report.executiveSummary) sections.push({ title: 'Executive summary', content: report.executiveSummary });
  if (includeMetrics && report.metrics?.length) sections.push({ title: 'Key figures', bullets: report.metrics.map((metric) => `${metric.label || 'Metric'}: ${metric.value ?? ''}${metric.note ? ` — ${metric.note}` : ''}`) });
  sections.push(...(report.sections || []));
  if (includeEndmatter) sections.push(...reportEndmatter(report));
  return sections;
}


/** Sources and appendices follow the findings and data tables in every format. */
export function reportEndmatter(report: ReportDocument): SectionInput[] {
  const sections: SectionInput[] = [];
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
