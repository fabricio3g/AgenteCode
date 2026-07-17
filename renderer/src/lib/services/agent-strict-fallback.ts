import type { SearchResult } from '$lib/types/tauri';
import type { ToolContext, ToolObservation, ToolResult } from '$lib/services/agent-types';
import type { AgentArtifact } from '$lib/types/chat';

type EvidenceSource = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  provider?: string;
  fileType?: string;
};

type EvidenceItem = {
  text: string;
  sourceId?: string;
};

function cleanText(value: unknown, max = 900): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function titleFromPrompt(prompt: string): string {
  const cleaned = cleanText(prompt, 100)
    .replace(/^(give|create|make|write)\s+(me\s+)?(an?\s+)?((extense|extensive|detailed|full|comprehensive)\s+)?(report|informe)\s+(about|on|of|for|sobre|de)\s+/i, '')
    .replace(/^((extense|extensive|detailed|full|comprehensive)\s+)?(report|informe)\s+(about|on|of|for|sobre|de)\s+/i, '')
    .replace(/^(search|research|look up)\s+(about|on|for)?\s*/i, '')
    .trim();
  return cleaned || 'Research findings';
}

function sourceKey(source: { title?: string; url?: string }): string {
  return cleanText(source.url || source.title || '').toLowerCase().replace(/#.*$/, '');
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fileTypeLabel(source: SearchResult): string {
  const inferred = String(source.url || '').match(/\.(pdf|docx?|pptx?|xlsx?|rtf|epub|odt|ods|odp)(?:$|[?#])/i)?.[1] || '';
  return cleanText(String(source.metadata?.file_type || inferred || ''), 40);
}

function mapSources(sources: SearchResult[]): EvidenceSource[] {
  const seen = new Set<string>();
  const mapped: EvidenceSource[] = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const key = sourceKey(source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mapped.push({
      id: String(mapped.length + 1),
      title: cleanText(source.title || source.url || `Source ${mapped.length + 1}`, 220),
      url: cleanText(source.url || '', 500),
      provider: cleanText(source.provider || '', 120),
      fileType: fileTypeLabel(source),
      snippet: cleanText(source.full_content || source.snippet || '', 1800)
    });
  }
  return mapped;
}

function evidenceKey(text: string): string {
  return cleanText(text, 260)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[[0-9][0-9,\s]*\]/g, '')
    .trim();
}

function addEvidenceItem(items: EvidenceItem[], seen: Set<string>, text: string, sourceId?: string) {
  const cleaned = cleanText(text, 900);
  if (cleaned.length < 25) return;
  if (/^(search query|searched_at|mode|urls_to_consider|next_step):/i.test(cleaned)) return;
  const key = evidenceKey(cleaned);
  if (!key || seen.has(key)) return;
  seen.add(key);
  items.push({ text: cleaned, sourceId });
}

function sourceEvidenceItems(sources: EvidenceSource[], seen: Set<string>): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const source of sources) {
    if (!source.snippet) continue;
    addEvidenceItem(items, seen, source.snippet, source.id);
  }
  return items;
}

function observationEvidenceItems(observations: ToolObservation[], seen: Set<string>): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const observation of observations) {
    if (!observation.success || !observation.summary) continue;
    const lines = String(observation.summary)
      .split(/\n+/)
      .map((line) => line
        .replace(/^\d+\.\s*/, '')
        .replace(/^(context excerpt|excerpt|content excerpt):\s*/i, '')
        .trim());

    for (const line of lines) {
      addEvidenceItem(items, seen, line);
    }
  }
  return items;
}

function collectEvidenceItems(observations: ToolObservation[], sources: EvidenceSource[]): EvidenceItem[] {
  const seen = new Set<string>();
  return [
    ...sourceEvidenceItems(sources, seen),
    ...observationEvidenceItems(observations, seen)
  ].slice(0, 24);
}

function renderSource(source: EvidenceSource): string {
  const title = source.title || source.url || `Source ${source.id}`;
  const badges = [source.fileType?.toUpperCase(), source.provider, domainLabel(source.url)]
    .map((value) => cleanText(value, 80))
    .filter(Boolean);
  const suffix = badges.length ? ` — ${badges.join(' · ')}` : '';
  return source.url ? `- [${source.id}] [${title}](${source.url})${suffix}` : `- [${source.id}] ${title}${suffix}`;
}

function isMedicalTopic(prompt: string): boolean {
  return /\b(disease|syndrome|cancer|drug|therapy|treatment|diagnos|clinical|patient|guideline|epidemiology|pathophysiology|prognosis|autoimmune|dermatology|medicine|medical|trial|etiology|symptom|pharmacolog)\b/i.test(
    prompt || ''
  );
}

/** Product-facing partial report — never title the body "Gathered Evidence". */
export function renderResearchFallbackReport(params: {
  prompt: string;
  observations: ToolObservation[];
  sources: EvidenceSource[];
  createdFiles?: string[];
  visibleFiles?: string[];
  missingExtensions?: string[];
  notice?: string;
}): string {
  const title = titleFromPrompt(params.prompt);
  const medical = isMedicalTopic(params.prompt);
  const items = collectEvidenceItems(params.observations, params.sources);
  const sources = params.sources.slice(0, 24);

  const execBits = items.slice(0, 5).map((i) => i.text.replace(/\s+/g, ' ').trim());
  const executive = execBits.length
    ? execBits.join(' ')
    : 'Limited source material was retrieved; findings below reflect only what could be verified from available pages.';

  const lines: string[] = [
    `# ${title}`,
    '',
    params.notice
      || '_Partial research report compiled from retrieved sources. Say **continue** for more depth if needed._',
    '',
    executive,
    ''
  ];

  if (medical) {
    const sections = [
      ['Definition and clinical importance', items.slice(0, 3)],
      ['Diagnosis and clinical presentation', items.slice(1, 5)],
      ['Treatment and management', items.filter((i) => /steroid|immunosup|treat|therap|corticosteroid|medication|dosing|management|adjuvant/i.test(i.text)).slice(0, 6)],
      ['Prognosis and follow-up', items.filter((i) => /prognos|outcome|mortal|remission|follow/i.test(i.text)).slice(0, 4)]
    ] as Array<[string, EvidenceItem[]]>;

    for (const [heading, sectionItems] of sections) {
      lines.push(`## ${heading}`, '');
      if (sectionItems.length) {
        for (const item of sectionItems) {
          const citation = item.sourceId ? ` [${item.sourceId}]` : '';
          lines.push(`- ${item.text}${citation}`);
        }
      } else {
        lines.push('_Not enough specific evidence was retrieved for this section._');
      }
      lines.push('');
    }
  } else {
    lines.push('## Key findings', '');
    if (items.length) {
      for (const item of items.slice(0, 12)) {
        const citation = item.sourceId ? ` [${item.sourceId}]` : '';
        lines.push(`- ${item.text}${citation}`);
      }
    } else {
      lines.push('_No synthesizable findings were extracted from tool results._');
    }
    lines.push('');
  }

  lines.push(
    '## Limitations',
    '',
    '- This summary is based only on sources retrieved in this session; it is not a substitute for specialist clinical judgment or primary literature review.',
    '- Some pages may have been blocked, thin, or incomplete; claims without citations should be treated as unverified.',
    ''
  );

  if (sources.length) {
    lines.push('## References', '');
    for (const source of sources) {
      const domain = domainLabel(source.url);
      const label = source.title || source.url || `Source ${source.id}`;
      if (source.url) {
        lines.push(`${source.id}. ${label}${domain ? `. ${domain}` : ''}. ${source.url}`);
      } else {
        lines.push(`${source.id}. ${label}`);
      }
    }
    lines.push('');
  }

  const files = Array.from(new Set([...(params.createdFiles || []), ...(params.visibleFiles || [])]));
  if (files.length) {
    lines.push('## Files', '');
    for (const file of files) lines.push(`- ${file}`);
    lines.push('');
  }

  if (params.missingExtensions?.length) {
    lines.push('## Missing requested files', '');
    for (const ext of params.missingExtensions) lines.push(`- .${ext.replace(/^\./, '')}`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** @deprecated Prefer renderResearchFallbackReport for user-facing content */
function renderEvidenceOnlyMarkdown(params: {
  observations: ToolObservation[];
  sources: EvidenceSource[];
  createdFiles?: string[];
  visibleFiles?: string[];
  missingExtensions?: string[];
  prompt?: string;
}): string {
  return renderResearchFallbackReport({
    prompt: params.prompt || 'Research findings',
    observations: params.observations,
    sources: params.sources,
    createdFiles: params.createdFiles,
    visibleFiles: params.visibleFiles,
    missingExtensions: params.missingExtensions
  });
}

function evidenceSections(items: EvidenceItem[], sources: EvidenceSource[]) {
  const sections: Array<{ title: string; content: string }> = [];
  if (items.length) {
    sections.push({
      title: 'Key findings',
      content: items.map((item) => `- ${item.text}${item.sourceId ? ` [${item.sourceId}]` : ''}`).join('\n')
    });
  }
  if (sources.length) {
    sections.push({
      title: 'References',
      content: sources.map(renderSource).join('\n')
    });
  }
  if (!sections.length) {
    sections.push({ title: 'Key findings', content: 'No reliable synthesizable evidence was available.' });
  }
  return sections;
}

export async function ensureRequestedArtifactsFromEvidence(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
  requestedArtifactKinds: (prompt: string) => { docx: boolean; xlsx: boolean; pptx: boolean; pdf: boolean };
  missingRequestedArtifactExtensions: (files: Record<string, string>, prompt: string) => string[];
  buildEvidenceText: (observations: ToolObservation[], sources: SearchResult[]) => string;
  fallbackTitle: (prompt: string) => string;
  evidenceSources: (observations: ToolObservation[], sources: SearchResult[]) => SearchResult[];
  sourceRows: (sources: SearchResult[]) => Array<Record<string, string>>;
  compactText: (value: unknown, max?: number) => string;
  executeTool: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  buildArtifact: (ctx: ToolContext) => AgentArtifact | null;
  normPath: (value: unknown) => string;
  buildMarkdownReport: (title: string, sections: Array<{ title?: string; content?: string }>) => string;
}): Promise<string[]> {
  const requestedKinds = params.requestedArtifactKinds(params.prompt);
  const missing = new Set(params.missingRequestedArtifactExtensions(params.ctx.files, params.prompt));
  const kinds = {
    docx: requestedKinds.docx && missing.has('docx'),
    xlsx: requestedKinds.xlsx && missing.has('xlsx'),
    pptx: requestedKinds.pptx && missing.has('pptx'),
    pdf: requestedKinds.pdf && missing.has('pdf')
  };
  if (!kinds.docx && !kinds.xlsx && !kinds.pptx && !kinds.pdf) return [];

  const evidence = params.buildEvidenceText(params.observations, params.sources);
  if (!evidence) return [];

  const rawSources = params.evidenceSources(params.observations, params.sources);
  const mappedSources = mapSources(rawSources);
  const items = collectEvidenceItems(params.observations, mappedSources);
  const title = params.fallbackTitle(params.prompt) || titleFromPrompt(params.prompt);
  const sections = [
    ...evidenceSections(items, mappedSources),
    { title: 'Raw Tool Evidence', content: params.compactText(evidence, 8000) }
  ];
  const created: string[] = [];
  const formats = [
    kinds.docx ? 'docx' : '',
    kinds.xlsx ? 'xlsx' : '',
    kinds.pptx ? 'pptx' : '',
    kinds.pdf ? 'pdf' : ''
  ].filter(Boolean);

  if (formats.length) {
    const result = await params.executeTool('create_work_product', {
      title,
      path: title,
      subtitle: 'Partial research product from retrieved sources',
      executiveSummary: items.slice(0, 4).map((item) => item.text).join('\n') || 'Limited synthesizable evidence was available from retrieved sources.',
      sections,
      sources: mappedSources,
      limitations: ['Based only on sources retrieved in this session. Not a substitute for specialist review or primary literature.'],
      tables: [{
        name: 'Sources',
        columns: ['id', 'title', 'url', 'excerpt'],
        rows: mappedSources.map((source) => ({ id: source.id, title: source.title, url: source.url, excerpt: source.snippet }))
      }],
      formats
    }, params.ctx);
    if (result.success) {
      created.push(...(result.createdFiles || []));
      params.ctx.onArtifact(params.buildArtifact(params.ctx));
      return Array.from(new Set(created));
    }
  }

  const addFile = async (toolName: string, fileArgs: Record<string, unknown>) => {
    const result = await params.executeTool(toolName, fileArgs, params.ctx);
    if (result.success) {
      created.push(...(result.createdFiles || []));
      return;
    }
    const fallbackPath = params.normPath(fileArgs.path) || `${title}.md`;
    params.ctx.files[fallbackPath.replace(/\.(docx|xlsx|pptx|pdf)$/i, '.md')] =
      params.buildMarkdownReport(title, sections);
    created.push(fallbackPath.replace(/\.(docx|xlsx|pptx|pdf)$/i, '.md'));
  };

  if (kinds.docx) {
    await addFile('create_document', { title, path: `${title}.docx`, sections });
  }
  if (kinds.xlsx) {
    const rows = params.sourceRows(rawSources);
    await addFile('create_spreadsheet', {
      title: `${title} - sources`,
      path: `${title}.xlsx`,
      sheets: [{
        name: 'Sources',
        columns: ['#', 'title', 'url', 'snippet'],
        rows: rows.length ? rows : [{ '#': '1', title: 'Evidence', url: '', snippet: params.compactText(evidence, 500) }]
      }]
    });
  }
  if (kinds.pptx) {
    await addFile('create_presentation', {
      title,
      path: `${title}.pptx`,
      slides: [
        { title: 'Key findings', content: items.slice(0, 6).map((item) => item.text) },
        { title: 'References', content: mappedSources.slice(0, 8).map(renderSource) }
      ]
    });
  }
  if (kinds.pdf) {
    await addFile('create_pdf', { title, path: `${title}.pdf`, sections });
  }

  params.ctx.onArtifact(params.buildArtifact(params.ctx));
  return Array.from(new Set(created));
}

export async function buildStrictFallbackContent(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
  ensureRequestedArtifactsFromEvidence: (params: {
    prompt: string;
    reason: string;
    ctx: ToolContext;
    observations: ToolObservation[];
    sources: SearchResult[];
  }) => Promise<string[]>;
  evidenceSources: (observations: ToolObservation[], sources: SearchResult[]) => SearchResult[];
  missingRequestedArtifactExtensions: (files: Record<string, string>, prompt: string) => string[];
}): Promise<string> {
  const created = await params.ensureRequestedArtifactsFromEvidence({
    prompt: params.prompt,
    reason: params.reason,
    ctx: params.ctx,
    observations: params.observations,
    sources: params.sources
  });

  const visibleFiles = Object.keys(params.ctx.files)
    .filter((path) => !path.startsWith('__'))
    .sort((a, b) => a.localeCompare(b));
  const missing = params.missingRequestedArtifactExtensions(params.ctx.files, params.prompt);
  const sources = mapSources(params.evidenceSources(params.observations, params.sources));

  return renderResearchFallbackReport({
    prompt: params.prompt,
    observations: params.observations,
    sources,
    createdFiles: created,
    visibleFiles,
    missingExtensions: missing,
    notice:
      '_Partial research report from retrieved sources (automatic synthesis). Say **continue** to deepen or refine._'
  });
}
