import type { SearchResult } from '$lib/types/tauri';
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
    snippet: source.snippet || ''
  }));
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
      ? output.results as Array<{ title?: string; url?: string; snippet?: string }>
      : [];
    const foundSources: SearchResult[] = rawSources
      .filter((source) => source.url)
      .map((source) => ({
        title: source.title || source.url || 'Source',
        url: source.url || '',
        snippet: source.snippet || ''
      }));
    const lines = [
      `Search query: ${compactText(output.query || args.query, 180)}`,
      ...foundSources.slice(0, 8).map((source, index) =>
        `${index + 1}. ${source.title} - ${source.url}${source.snippet ? ` - ${compactText(source.snippet, 220)}` : ''}`
      )
    ];
    const context = compactText(output.context, 900);
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
    return {
      name,
      args,
      success: true,
      summary: [
        `Fetched URL: ${compactText(output.url || args.url, 220)}`,
        output.title ? `Title: ${compactText(output.title, 180)}` : '',
        output.quality ? `Scrape quality: ${compactText(output.quality, 80)}${output.warning ? ` (${compactText(output.warning, 220)})` : ''}` : '',
        output.excerpt ? `Excerpt: ${compactText(output.excerpt, 350)}` : '',
        output.content ? `Content excerpt: ${compactText(output.content, 900)}` : ''
      ].filter(Boolean).join('\n'),
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
    if (source.url) byUrl.set(source.url, source);
  }
  for (const observation of observations) {
    for (const source of observation.sources || []) {
      if (source.url && !byUrl.has(source.url)) byUrl.set(source.url, source);
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
      const snippet = source.snippet ? `\n   ${compactText(source.snippet, 350)}` : '';
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
