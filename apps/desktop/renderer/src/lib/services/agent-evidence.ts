import type { SearchResult } from '$lib/types/bridge';
import type { ToolObservation, ToolResult } from '$lib/services/agent-types';

export function compactText(value: unknown, max = 900): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sourceRows(sources: SearchResult[]): Array<Record<string, string>> {
  return sources.map((source, index) => ({
    '#': String(index + 1),
    title: source.title || source.url,
    url: source.url,
    snippet: source.snippet || source.full_content || ''
  }));
}

function normalizedSourceKey(source: SearchResult): string {
  return String(source.url || source.title || '').trim().toLowerCase().replace(/#.*$/, '');
}

function mergeSourceFields(existing: SearchResult, incoming: SearchResult): SearchResult {
  return {
    ...existing,
    ...incoming,
    title: incoming.title || existing.title || incoming.url || existing.url,
    url: incoming.url || existing.url,
    snippet: (incoming.snippet || '').length > (existing.snippet || '').length ? incoming.snippet : existing.snippet,
    full_content: (incoming.full_content || '').length > (existing.full_content || '').length ? incoming.full_content : existing.full_content,
    provider: incoming.provider || existing.provider,
    providers: incoming.providers || existing.providers,
    metadata: { ...(existing.metadata || {}), ...(incoming.metadata || {}) }
  };
}

export function summarizeToolObservation(name: string, args: Record<string, unknown>, result: ToolResult): ToolObservation {
  const createdFiles = [
    ...(result.createdFiles || []),
    ...(result.modifiedFiles || [])
  ];

  if (!result.success) {
    return {
      name,
      args,
      success: false,
      summary: `${name} failed: ${compactText(result.error || 'Unknown error', 500)}`
    };
  }

  const output = result.output as Record<string, unknown> | undefined;
  if (name === 'web_search' && output && typeof output === 'object') {
    const rawSources = Array.isArray(output.results)
      ? output.results as SearchResult[]
      : [];
    const foundSources: SearchResult[] = rawSources
      .filter((source) => source.url)
      .map((source) => ({
        ...source,
        title: source.title || source.url || 'Source',
        url: source.url || '',
        snippet: source.snippet || '',
        full_content: source.full_content || ''
      }));
    const lines = [
      `Search query: ${compactText(output.query || args.query, 180)}`,
      ...foundSources.slice(0, 12).map((source, index) =>
        `${index + 1}. ${source.title} - ${source.url}${source.snippet ? ` - ${compactText(source.snippet, 420)}` : ''}`
      )
    ];
    const context = compactText(output.context, 1800);
    return {
      name,
      args,
      success: true,
      summary: `${lines.join('\n')}${context ? `\nContext excerpt: ${context}` : ''}`,
      sources: foundSources,
      createdFiles
    };
  }

  if (name === 'fetch_url' && output && typeof output === 'object') {
    const fetchedSource: SearchResult | null = output.url
      ? {
        title: String(output.title || output.url || 'Fetched source'),
        url: String(output.url || ''),
        snippet: String(output.excerpt || ''),
        full_content: String(output.content || ''),
        provider: 'fetch_url',
        metadata: {
          quality: output.quality,
          warning: output.warning,
          site_name: output.site_name,
          file_type: output.file_type
        }
      }
      : null;
    return {
      name,
      args,
      success: true,
      summary: [
        `Fetched URL: ${compactText(output.url || args.url, 220)}`,
        output.title ? `Title: ${compactText(output.title, 180)}` : '',
        output.quality ? `Scrape quality: ${compactText(output.quality, 80)}${output.warning ? ` (${compactText(output.warning, 220)})` : ''}` : '',
        output.excerpt ? `Excerpt: ${compactText(output.excerpt, 350)}` : '',
        output.content ? `Content excerpt: ${compactText(output.content, 1800)}` : ''
      ].filter(Boolean).join('\n'),
      sources: fetchedSource ? [fetchedSource] : undefined,
      createdFiles
    };
  }

  if (createdFiles.length) {
    return {
      name,
      args,
      success: true,
      summary: `${name} created/updated: ${createdFiles.join(', ')}`,
      createdFiles
    };
  }

  return {
    name,
    args,
    success: true,
    summary: `${name} result: ${compactText(JSON.stringify(result.output ?? {}), 900)}`,
    createdFiles
  };
}

export function evidenceSources(observations: ToolObservation[], liveSources: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const source of liveSources) {
    const key = normalizedSourceKey(source);
    if (!key) continue;
    byUrl.set(key, byUrl.has(key) ? mergeSourceFields(byUrl.get(key) as SearchResult, source) : source);
  }
  for (const observation of observations) {
    for (const source of observation.sources || []) {
      const key = normalizedSourceKey(source);
      if (!key) continue;
      byUrl.set(key, byUrl.has(key) ? mergeSourceFields(byUrl.get(key) as SearchResult, source) : source);
    }
  }
  return Array.from(byUrl.values());
}

export function buildEvidenceText(observations: ToolObservation[], liveSources: SearchResult[]): string {
  const successful = observations.filter((observation) => observation.success && observation.summary);
  const failed = observations.filter((observation) => !observation.success && observation.summary);
  const sources = evidenceSources(observations, liveSources);
  const parts: string[] = [];

  if (sources.length) {
    parts.push('## Sources found');
    parts.push(...sources.slice(0, 12).map((source, index) => {
      const title = source.title || source.url;
      const url = source.url;
      const excerpt = source.snippet || source.full_content || '';
      const snippet = excerpt ? `\n   ${compactText(excerpt, 700)}` : '';
      return `${index + 1}. [${title}](${url})${snippet}`;
    }));
  }

  if (successful.length) {
    parts.push('## Tool evidence');
    parts.push(...successful.slice(0, 10).map((observation, index) => `${index + 1}. ${observation.summary}`));
  }

  if (failed.length) {
    parts.push('## Tool failures');
    parts.push(...failed.slice(-5).map((observation, index) => `${index + 1}. ${observation.summary}`));
  }

  return parts.join('\n\n').trim();
}

export function requestedArtifactKinds(prompt: string): { docx: boolean; xlsx: boolean; pptx: boolean; pdf: boolean } {
  const text = String(prompt || '').toLowerCase();
  return {
    docx: /\b(docx|word document|microsoft word|\.docx|documento word)\b/.test(text),
    xlsx: /\b(excel|xlsx|spreadsheet|workbook|sheet|planilla|hoja de calculo|hoja de cálculo)\b/.test(text),
    pptx: /\b(slide|slides|ppt|pptx|presentation|deck|diapositiva|presentacion|presentación)\b/.test(text),
    pdf: /\b(pdf)\b/.test(text)
  };
}

/**
 * Inline visual artifacts the user asked for (charts, diagrams, maps,
 * dashboards, cards). Unlike file artifacts these leave no file extension to
 * match, so detection is keyword-based and the caller must compare against
 * created artifact manifests. Keep patterns to explicit deliverable language —
 * a bare verb like "map" ("map these fields") must not trigger enforcement.
 */
export type VisualArtifactKind = 'chart' | 'diagram' | 'map' | 'dashboard' | 'info_card' | 'html_card';

export const VISUAL_ARTIFACT_TOOL: Record<VisualArtifactKind, string> = {
  chart: 'create_chart',
  diagram: 'create_diagram',
  map: 'create_map',
  dashboard: 'create_dashboard',
  info_card: 'create_info_card',
  html_card: 'create_html_card'
};

export function requestedVisualArtifacts(prompt: string): VisualArtifactKind[] {
  const text = String(prompt || '').toLowerCase();
  // Completion enforcement must distinguish a deliverable from a question
  // about one. The model still receives tools for all ordinary conversation.
  if (/\b(don't|do not|never|no need to)\b[^.!?]{0,60}\b(make|create|build|generate|show|draw|plot)\b/.test(text)) return [];
  if (!/\b(make|create|build|generate|show|display|draw|plot|chart|graph|visualize|visualise|give|produce|pin|mark)\b/.test(text)) return [];
  if (/^(what|why|how)\b/.test(text) && !/\b(and|then)\s+(show|create|draw|make)\b/.test(text)) return [];
  const kinds: VisualArtifactKind[] = [];
  if (/\b(bar charts?|line charts?|pie charts?|donut charts?|histograms?|plots?|graphs?|visualiz\w+|visualis\w+|trend charts?)\b/.test(text)) kinds.push('chart');
  else if ((/\bcharts?\b/.test(text) && /\b(make|create|build|generate|show|draw|plot|compare)\b/.test(text)) || /^(chart|graph|plot)\s+(my|this|that|these|those|the|our|your)\b/.test(text)) kinds.push('chart');
  if (/\b(flowcharts?|flow charts?|sequence diagrams?|architecture diagrams?|mindmaps?|mind maps?|mermaid|diagrams?|er diagrams?)\b/.test(text)) kinds.push('diagram');
  if (/\b(show|display|draw|create|make|build|generate|plot|pin|mark)\b[^.]{0,60}\b((?<!mind\s)maps?|markers?|locations?|routes?|geograph\w+|coordinates?)\b/.test(text)) kinds.push('map');
  if (/\b(dashboards?|kpis?|scorecards?)\b/.test(text)) kinds.push('dashboard');
  else if (/\bmetrics\b/.test(text) && /\b(make|create|build|generate|show|display|track)\b/.test(text)) kinds.push('dashboard');
  if (/\b(info ?cards?|fact ?sheets?|fact ?packs?|summary cards?)\b/.test(text)) kinds.push('info_card');
  // Explicit "html card" only: bare "html"/"widget"/"snippet" collide with the
  // website-build flow, which has its own enforcement via write_file/preview.
  if (/\bhtml cards?\b/.test(text)) kinds.push('html_card');
  return kinds;
}

export function requestedArtifactExtensions(prompt: string): string[] {
  const kinds = requestedArtifactKinds(prompt);
  return Object.entries(kinds)
    .filter(([, requested]) => requested)
    .map(([kind]) => kind);
}

export function missingRequestedArtifactExtensions(files: Record<string, string>, prompt: string): string[] {
  const visible = Object.keys(files).filter((path) => !path.startsWith('__')).map((path) => path.toLowerCase());
  return requestedArtifactExtensions(prompt).filter((ext) => !visible.some((path) => path.endsWith(`.${ext}`)));
}

export function fallbackTitle(prompt: string): string {
  const cleaned = compactText(prompt, 80).replace(/[^\w\s-]/g, '').trim();
  return cleaned || 'Agent evidence summary';
}

export function hasAllRequestedArtifacts(files: Record<string, string>, prompt: string): boolean {
  return missingRequestedArtifactExtensions(files, prompt).length === 0;
}

export function hasGatheredEvidence(params: {
  files: Record<string, string>;
  observations: ToolObservation[];
  sources: SearchResult[];
  content?: string;
  hasVisibleArtifact: (files: Record<string, string>) => boolean;
}): boolean {
  return !!(
    String(params.content || '').trim() ||
    params.sources.length ||
    params.observations.some((observation) => observation.success && observation.summary) ||
    params.hasVisibleArtifact(params.files)
  );
}
