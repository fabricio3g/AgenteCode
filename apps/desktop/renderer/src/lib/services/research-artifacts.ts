import type { SearchResult } from '$lib/types/bridge';
import type { SearchMeta } from '$lib/types/chat';
import { domainLabel as sharedDomainLabel } from '$lib/ui/message-utils';

export type ResearchExportKind =
  | 'citations'
  | 'matrix'
  | 'shortlist'
  | 'bibliography'
  | 'protocol';

export type ResearchCitation = {
  id: number;
  key: string;
  title: string;
  url: string;
  author: string;
  year: string;
  site: string;
  type: string;
  takeaway: string;
  quality: string;
  publishedAt?: string;
};

export type ResearchExportFile = {
  path: string;
  content: string;
  mime: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const domainLabel = (url: string): string => sharedDomainLabel(url, '');

function slugKey(title: string, index: number): string {
  const base = clean(title, 48)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return `${base || 'source'}_${index + 1}`;
}

function yearFromSource(source: SearchResult): string {
  const published = source.published_at || String(source.metadata?.published_at || source.metadata?.date || '');
  const yearMatch = published.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) return yearMatch[0];
  const body = `${source.title || ''} ${source.snippet || ''}`;
  const bodyYear = body.match(/\b(19|20)\d{2}\b/);
  return bodyYear ? bodyYear[0] : 'n.d.';
}

function authorFromSource(source: SearchResult): string {
  const meta = source.metadata || {};
  const author =
    meta.author ||
    meta.authors ||
    meta.creator ||
    meta.byline ||
    meta.organization ||
    meta.site_name;
  if (author) return clean(Array.isArray(author) ? author.join(', ') : author, 120);
  const site = clean(meta.site_name, 80) || domainLabel(source.url || '');
  return site || clean(source.title || 'Unknown', 80);
}

function sourceType(source: SearchResult): string {
  const metaType = clean(source.metadata?.type || source.metadata?.document_kind, 40).toLowerCase();
  if (metaType) return metaType;
  const host = domainLabel(source.url || '').toLowerCase();
  if (/\.gov(\.|$)|europa\.eu|who\.int|nih\.gov|cdc\.gov/.test(host)) return 'government';
  if (/\.edu(\.|$)|arxiv\.org|pubmed|doi\.org|springer|nature\.com|sciencedirect|ieee\.org|acm\.org/.test(host)) {
    return 'academic';
  }
  if (/wikipedia\.org|britannica/.test(host)) return 'reference';
  if (/reuters|bbc\.|nytimes|theguardian|apnews|cnn\.|forbes/.test(host)) return 'news';
  return 'webpage';
}

function qualityFromSource(source: SearchResult): string {
  const q = clean(source.metadata?.quality, 40).toLowerCase();
  if (q === 'blocked' || q === 'thin') return q;
  const body = String(source.full_content || source.snippet || '');
  if (body.length < 40) return 'thin';
  if (source.full_content && source.full_content.length > 800) return 'full';
  if (source.snippet) return 'snippet';
  return 'unknown';
}

function takeawayFromSource(source: SearchResult): string {
  const text = clean(source.snippet || source.full_content || '', 280);
  if (!text) return 'No excerpt available.';
  const sentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return clean(sentence, 220);
}

/**
 * Which source a URL names: scheme and host are case-insensitive and the
 * fragment never reaches the server, but the path and query are the
 * site's own (`/docs/Api` and `/docs/API` can be two pages). A source
 * without a URL is known by its title.
 */
export function sourceIdentity(url: unknown, title: unknown = ''): string {
  const raw = String(url ?? '').trim();
  if (raw) {
    try {
      const parsed = new URL(raw);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return raw.replace(/#.*$/, '');
    }
  }
  return clean(title, 240).toLowerCase();
}

/** Normalize and dedupe sources for research exports. Never invent metadata. */
export function buildResearchCitations(sources: SearchResult[]): ResearchCitation[] {
  const seen = new Set<string>();
  const out: ResearchCitation[] = [];
  for (const source of sources || []) {
    // The whole destination: a long query string can carry the part that
    // matters (`&page=2`). Only the visible label is ever shortened.
    const url = String(source.url ?? '').trim();
    const title = clean(source.title || url, 240);
    if (!url && !title) continue;
    const key = sourceIdentity(url, title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: out.length + 1,
      key: slugKey(title, out.length),
      title,
      url,
      author: authorFromSource(source),
      year: yearFromSource(source),
      site: domainLabel(url) || clean(source.metadata?.site_name, 80) || 'web',
      type: sourceType(source),
      takeaway: takeawayFromSource(source),
      quality: qualityFromSource(source),
      publishedAt: source.published_at || undefined
    });
  }
  return out;
}

export function buildApaReferences(citations: ResearchCitation[]): string {
  const lines = citations.map((c) => {
    const author = c.author || c.title;
    const year = c.year === 'n.d.' ? 'n.d.' : c.year;
    const title = c.title.endsWith('.') ? c.title.slice(0, -1) : c.title;
    const site = c.site && c.site !== 'web' ? `${c.site}. ` : '';
    const url = c.url ? ` ${c.url}` : '';
    return `${author}. (${year}). ${title}. ${site}${url}`.replace(/\s+/g, ' ').trim();
  });
  return ['References', '', ...lines].join('\n');
}

function escapeBib(value: string): string {
  return value.replace(/[{}]/g, '');
}

export function buildBibTeX(citations: ResearchCitation[]): string {
  return citations
    .map((c) => {
      const year = c.year === 'n.d.' ? '' : c.year;
      const fields = [
        `  title = {${escapeBib(c.title)}}`,
        c.author ? `  author = {${escapeBib(c.author)}}` : '',
        year ? `  year = {${year}}` : '',
        c.url ? `  url = {${c.url}}` : '',
        c.url ? `  howpublished = {\\url{${c.url}}}` : '',
        `  note = {Retrieved from web; quality=${c.quality}}`
      ].filter(Boolean);
      return `@misc{${c.key},\n${fields.join(',\n')}\n}`;
    })
    .join('\n\n');
}

export function buildRis(citations: ResearchCitation[]): string {
  return citations
    .map((c) => {
      const lines = [
        'TY  - ELEC',
        `TI  - ${c.title}`,
        c.author ? `AU  - ${c.author}` : '',
        c.year !== 'n.d.' ? `PY  - ${c.year}` : '',
        c.url ? `UR  - ${c.url}` : '',
        c.site ? `PB  - ${c.site}` : '',
        `N1  - quality: ${c.quality}`,
        'ER  - '
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function buildSourceShortlistMarkdown(
  citations: ResearchCitation[],
  options: { title?: string; query?: string } = {}
): string {
  const title = options.title || 'Source shortlist';
  const lines = [
    `# ${title}`,
    '',
    ...(options.query ? [`Query: ${options.query}`, ''] : []),
    'Ranked sources with takeaways from retrieved evidence. Missing bibliographic fields are left unknown — not invented.',
    ''
  ];

  for (const c of citations) {
    lines.push(
      `## ${c.id}. ${c.title}`,
      '',
      `- **Site:** ${c.site}`,
      `- **Type:** ${c.type}`,
      `- **Year:** ${c.year}`,
      `- **Quality:** ${c.quality}`,
      ...(c.url ? [`- **URL:** ${c.url}`] : []),
      '',
      c.takeaway,
      ''
    );
  }

  return lines.join('\n').trim() + '\n';
}

function buildEvidenceMatrixRows(citations: ResearchCitation[]): {
  columns: string[];
  rows: Array<Record<string, string>>;
} {
  const columns = ['ID', 'Title', 'Organization/Author', 'Year', 'Type', 'Main takeaway', 'Quality', 'URL'];
  const rows = citations.map((c) => ({
    ID: String(c.id),
    Title: c.title,
    'Organization/Author': c.author,
    Year: c.year,
    Type: c.type,
    'Main takeaway': c.takeaway,
    Quality: c.quality,
    URL: c.url
  }));
  return { columns, rows };
}

export function buildEvidenceMatrixCsv(citations: ResearchCitation[]): string {
  const { columns, rows } = buildEvidenceMatrixRows(citations);
  const escape = (v: string) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escape(row[col] || '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function buildEvidenceMatrixMarkdown(citations: ResearchCitation[]): string {
  const { columns, rows } = buildEvidenceMatrixRows(citations);
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => String(row[c] || '').replace(/\|/g, '/')).join(' | ')} |`);
  return ['# Evidence matrix', '', header, sep, ...body, ''].join('\n');
}

function buildAnnotatedBibliographyMarkdown(citations: ResearchCitation[]): string {
  const blocks = citations.map((c) => {
    const apa = `${c.author}. (${c.year}). ${c.title}. ${c.site}.${c.url ? ` ${c.url}` : ''}`;
    return [
      `### [${c.id}] ${c.title}`,
      '',
      apa,
      '',
      `**Annotation.** ${c.takeaway} Source type: ${c.type}. Evidence quality from retrieval: ${c.quality}.`,
      ''
    ].join('\n');
  });
  return ['# Annotated bibliography', '', ...blocks].join('\n').trim() + '\n';
}

function buildSearchProtocolMarkdown(params: {
  query?: string;
  searchMode?: string | null;
  meta?: SearchMeta | null;
  sourceCount: number;
}): string {
  const lines = [
    '# Search protocol snapshot',
    '',
    `Generated: ${new Date().toISOString()}`,
    params.query ? `Query: ${params.query}` : '',
    params.searchMode ? `Mode: ${params.searchMode}` : '',
    `Sources retained: ${params.sourceCount}`,
    ''
  ].filter((line) => line !== undefined);

  if (params.meta) {
    const meta = params.meta as unknown as Record<string, unknown>;
    for (const key of ['provider', 'provider_used', 'stopReason', 'outcome', 'iterations', 'toolCalls', 'elapsedSeconds']) {
      if (meta[key] != null && meta[key] !== '') {
        lines.push(`${key}: ${String(meta[key])}`);
      }
    }
  }

  lines.push(
    '',
    'This snapshot records what this session retrieved. It is not a formal systematic review protocol.',
    ''
  );
  return lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');
}

/**
 * Build text-based research export files from sources.
 * Kinds: citations → .bib + .ris + APA .txt; matrix → csv + md; shortlist; bibliography; protocol.
 */
export function buildResearchExportFiles(params: {
  sources: SearchResult[];
  kinds: ResearchExportKind[];
  title?: string;
  query?: string;
  searchMode?: string | null;
  meta?: SearchMeta | null;
}): ResearchExportFile[] {
  const citations = buildResearchCitations(params.sources);
  if (!citations.length) return [];

  const slug =
    clean(params.title || params.query || 'research', 40)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'research';

  const files: ResearchExportFile[] = [];
  const kinds = new Set(params.kinds);

  if (kinds.has('citations')) {
    files.push(
      { path: `${slug}-references-apa.txt`, content: buildApaReferences(citations), mime: 'text/plain' },
      { path: `${slug}-citations.bib`, content: buildBibTeX(citations), mime: 'application/x-bibtex' },
      { path: `${slug}-citations.ris`, content: buildRis(citations), mime: 'application/x-research-info-systems' }
    );
  }

  if (kinds.has('matrix')) {
    files.push(
      { path: `${slug}-evidence-matrix.csv`, content: buildEvidenceMatrixCsv(citations), mime: 'text/csv' },
      {
        path: `${slug}-evidence-matrix.md`,
        content: buildEvidenceMatrixMarkdown(citations),
        mime: 'text/markdown'
      }
    );
  }

  if (kinds.has('shortlist')) {
    files.push({
      path: `${slug}-source-shortlist.md`,
      content: buildSourceShortlistMarkdown(citations, {
        title: params.title || 'Source shortlist',
        query: params.query
      }),
      mime: 'text/markdown'
    });
  }

  if (kinds.has('bibliography')) {
    files.push({
      path: `${slug}-annotated-bibliography.md`,
      content: buildAnnotatedBibliographyMarkdown(citations),
      mime: 'text/markdown'
    });
  }

  if (kinds.has('protocol')) {
    files.push({
      path: `${slug}-search-protocol.md`,
      content: buildSearchProtocolMarkdown({
        query: params.query,
        searchMode: params.searchMode,
        meta: params.meta,
        sourceCount: citations.length
      }),
      mime: 'text/markdown'
    });
  }

  return files;
}

export function downloadResearchExportFile(file: ResearchExportFile): void {
  const blob = new Blob([file.content], { type: `${file.mime || 'text/plain'};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.path.split('/').pop() || file.path;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function suggestedExportKinds(searchMode?: string | null): ResearchExportKind[] {
  if (searchMode === 'max') return ['shortlist', 'citations', 'matrix', 'bibliography', 'protocol'];
  if (searchMode === 'deep') return ['shortlist', 'citations', 'matrix', 'bibliography'];
  return ['shortlist', 'citations'];
}

export function parseExportKinds(value: unknown): ResearchExportKind[] {
  const allowed: ResearchExportKind[] = ['citations', 'matrix', 'shortlist', 'bibliography', 'protocol'];
  const raw = Array.isArray(value)
    ? value.map((v) => String(v).toLowerCase().trim())
    : String(value || '')
        .split(/[,\s]+/)
        .map((v) => v.toLowerCase().trim())
        .filter(Boolean);
  const kinds = allowed.filter((k) => raw.includes(k));
  return kinds.length ? kinds : ['citations', 'shortlist'];
}
