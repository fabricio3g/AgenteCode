import type { SearchResult } from '$lib/types/bridge';
import type { ToolContext, ToolObservation, ToolResult } from '$lib/services/agent-types';
import { say } from '$lib/copy';
import { domainLabel as sharedDomainLabel } from '$lib/ui/message-utils';

/** How to shape partial answers when the model did not finish. */
export type FallbackMode = 'research' | 'chat';

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

const domainLabel = (url: string): string => sharedDomainLabel(url, '');

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
  if (/^(fetched url|title|scrape quality|excerpt|content excerpt):/i.test(cleaned) && cleaned.length < 40) return;
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
    if (isLiveDataTool(observation.name)) continue; // handled separately as plain answers
    const lines = String(observation.summary)
      .split(/\n+/)
      .map((line) => line
        .replace(/^\d+\.\s*/, '')
        .replace(/^(context excerpt|excerpt|content excerpt):\s*/i, '')
        .replace(/^Title:\s*/i, '')
        .replace(/^Fetched URL:\s*/i, '')
        .trim());

    for (const line of lines) {
      // Skip search list lines that are mostly URL titles without substance
      if (/^https?:\/\//i.test(line)) continue;
      if (/^.+ - https?:\/\/\S+( - )?$/i.test(line) && line.length < 60) continue;
      // "1. Title - url - snippet" → keep snippet if present
      const listed = line.match(/^.+?\s-\shttps?:\/\/\S+\s-\s(.+)$/i);
      if (listed?.[1]) {
        addEvidenceItem(items, seen, listed[1]);
        continue;
      }
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

function isLiveDataTool(name: string): boolean {
  return /^(get_weather|convert_currency|get_quote)$/i.test(name || '');
}

function ensureSentence(text: string): string {
  let t = cleanText(text, 900);
  if (!t) return '';
  // Drop leading list markers / meta labels
  t = t.replace(/^[-*•]\s+/, '').replace(/^(excerpt|content excerpt):\s*/i, '');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?…]$/.test(t)) t += '.';
  return t;
}

/** Join distinct evidence into readable prose (no rigid report shell). */
export function synthesizeProse(items: EvidenceItem[], opts?: { maxItems?: number; withCitations?: boolean }): string {
  const max = opts?.maxItems ?? 8;
  const withCitations = opts?.withCitations !== false;
  const sentences: string[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, max)) {
    const base = ensureSentence(item.text.replace(/\s*\[\d+\]\s*$/, ''));
    if (!base) continue;
    const key = evidenceKey(base);
    if (seen.has(key)) continue;
    seen.add(key);
    const cite = withCitations && item.sourceId ? ` [${item.sourceId}]` : '';
    // Insert citation before final punctuation when present
    const withCite = cite
      ? base.replace(/([.!?…])$/, `${cite}$1`)
      : base;
    sentences.push(withCite);
  }
  if (!sentences.length) return '';

  // Group into short paragraphs (2–3 sentences)
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) {
    paragraphs.push(sentences.slice(i, i + 3).join(' '));
  }
  return paragraphs.join('\n\n');
}

function rowsFromInfoCardJson(raw: string): Array<{ label: string; value: string }> {
  try {
    const parsed = JSON.parse(raw) as { rows?: Array<{ label?: string; value?: string }> };
    if (!Array.isArray(parsed?.rows)) return [];
    return parsed.rows
      .map((row) => ({ label: cleanText(row.label, 80), value: cleanText(row.value, 200) }))
      .filter((row) => row.label && row.value);
  } catch {
    return [];
  }
}

/** Plain-language answer from weather / FX / quote tools or info cards. */
export function renderLiveDataFallback(params: {
  prompt: string;
  observations: ToolObservation[];
  files?: Record<string, string>;
}): string | null {
  const liveObs = (params.observations || []).filter((o) => o.success && isLiveDataTool(o.name));
  const files = params.files || {};

  // Prefer structured info-card files when present
  for (const path of Object.keys(files)) {
    if (!/weather|currency|fx|quote|info-?card/i.test(path) && !path.endsWith('-card.json')) continue;
    const rows = rowsFromInfoCardJson(files[path]);
    if (!rows.length) continue;
    const bits = rows.slice(0, 8).map((r) => `${r.label}: ${r.value}`);
    return [
      bits.join('. ') + (bits.length ? '.' : ''),
      '',
      `_Live data for your request (“${cleanText(params.prompt, 80)}”)._`
    ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (!liveObs.length) return null;

  const parts: string[] = [];
  for (const observation of liveObs.slice(-3)) {
    const summary = cleanText(observation.summary, 1200);
    if (!summary) continue;
    // Flatten tool-ish lines into sentences
    const lines = summary
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^(chip|ok|success)\b/i.test(l));
    if (observation.name === 'get_weather') {
      const place = cleanText(observation.args?.location || observation.args?.query || '', 80);
      const body = lines.map((l) => ensureSentence(l)).join(' ');
      parts.push(place ? `${place}: ${body}` : body);
      continue;
    }
    if (observation.name === 'convert_currency') {
      parts.push(lines.map((l) => ensureSentence(l)).join(' '));
      continue;
    }
    if (observation.name === 'get_quote') {
      const symbol = cleanText(observation.args?.symbol || observation.args?.query || '', 24);
      const body = lines.map((l) => ensureSentence(l)).join(' ');
      parts.push(symbol ? `${symbol}: ${body}` : body);
      continue;
    }
    parts.push(lines.map((l) => ensureSentence(l)).join(' '));
  }

  const text = parts.filter(Boolean).join('\n\n').trim();
  if (!text) return null;
  return text;
}

function renderFilesAndMissing(params: {
  createdFiles?: string[];
  visibleFiles?: string[];
  missingExtensions?: string[];
}): string {
  const lines: string[] = [];
  const files = Array.from(new Set([...(params.createdFiles || []), ...(params.visibleFiles || [])]))
    .filter((path) => !path.startsWith('__') && !/-card\.json$/i.test(path));
  if (files.length) {
    lines.push('## Files', '');
    for (const file of files) lines.push(`- ${file}`);
    lines.push('');
  }
  if (params.missingExtensions?.length) {
    lines.push('## Missing requested files', '');
    for (const ext of params.missingExtensions) lines.push(`- .${ext.replace(/^\./, '')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Describe an actual gap in the evidence, or return `''` when there isn't one.
 *
 * The prompts tell the model to add Limitations only when something is thin,
 * conflicting, or unverified. This fallback renderer is code, not a model, so it
 * has to apply the same test rather than always printing the section.
 */
function describeEvidenceGap(items: EvidenceItem[], sources: EvidenceSource[]): string {
  if (!sources.length) {
    return 'No live sources could be retrieved for this query, so nothing below is externally verified.';
  }

  const uncited = items.filter((item) => !item.sourceId).length;
  const reasons: string[] = [];

  if (sources.length < 3) {
    reasons.push(
      `only ${say.sources(sources.length)} could be read for this answer`
    );
  }
  if (uncited > 0 && uncited >= items.length / 2) {
    reasons.push('several statements below could not be tied to a specific source');
  }

  if (!reasons.length) return '';
  return `This answer is based on sources retrieved in this session: ${reasons.join(', and ')}. Treat uncited claims as unverified.`;
}

function renderReferences(sources: EvidenceSource[]): string {
  if (!sources.length) return '';
  const lines: string[] = ['## References', ''];
  for (const source of sources) {
    const domain = domainLabel(source.url);
    const label = source.title || source.url || `Source ${source.id}`;
    // APA-ish web reference: Title. Site. URL (author/date when unknown → title-first + n.d. not invented)
    if (source.url) {
      lines.push(
        `${source.id}. ${label}. ${domain || 'Web'}. (n.d.). ${source.url}`
      );
    } else {
      lines.push(`${source.id}. ${label}. (n.d.).`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Product-facing partial report — natural prose, not a rigid “strict” dump.
 * Never titles the body "Gathered Evidence" or "Agent stopped because".
 */
function renderResearchFallbackReport(params: {
  prompt: string;
  observations: ToolObservation[];
  sources: EvidenceSource[];
  createdFiles?: string[];
  visibleFiles?: string[];
  missingExtensions?: string[];
  notice?: string;
  mode?: FallbackMode;
}): string {
  const mode: FallbackMode = params.mode || 'research';
  const title = titleFromPrompt(params.prompt);
  const medical = isMedicalTopic(params.prompt);
  const items = collectEvidenceItems(params.observations, params.sources);
  const sources = params.sources.slice(0, 24);

  // Live data short-circuit (weather / FX / quotes) for any mode
  const live = renderLiveDataFallback({
    prompt: params.prompt,
    observations: params.observations,
    files: undefined
  });
  // Note: files are optional; chat path passes them via buildStrictFallbackContent

  if (mode === 'chat') {
    return renderChatFallback({
      prompt: params.prompt,
      items,
      sources,
      live,
      createdFiles: params.createdFiles,
      visibleFiles: params.visibleFiles,
      missingExtensions: params.missingExtensions
    });
  }

  const prose = synthesizeProse(items, { maxItems: medical ? 14 : 12, withCitations: true });
  const opening = prose || 'Limited source material was retrieved in this session, so the notes below only reflect what could be checked from available pages.';

  // Finished-product framing (competitor-style): no "step limit" / agent-error chrome.
  const lines: string[] = [
    `# ${title}`,
    ''
  ];
  if (params.notice) {
    lines.push(params.notice, '');
  }
  lines.push(opening, '');

  if (medical) {
    const sections = [
      ['Definition and clinical importance', items.slice(0, 3)],
      ['Diagnosis and clinical presentation', items.slice(1, 5)],
      [
        'Treatment and management',
        items.filter((i) => /steroid|immunosup|treat|therap|corticosteroid|medication|dosing|management|adjuvant/i.test(i.text)).slice(0, 6)
      ],
      [
        'Prognosis and follow-up',
        items.filter((i) => /prognos|outcome|mortal|remission|follow/i.test(i.text)).slice(0, 4)
      ]
    ] as Array<[string, EvidenceItem[]]>;

    const nonEmpty = sections.filter(([, sectionItems]) => sectionItems.length > 0);
    if (nonEmpty.length >= 2) {
      // Drop the generic opening prose duplicate if we are about to detail sections
      for (const [heading, sectionItems] of nonEmpty) {
        const body = synthesizeProse(sectionItems, { maxItems: 6, withCitations: true });
        if (!body) continue;
        lines.push(`## ${heading}`, '', body, '');
      }
    } else if (!prose) {
      lines.push(
        '## What was found',
        '',
        'Not enough specific clinical detail was retrieved to structure a full overview. Narrow the question or run a deeper search mode.',
        ''
      );
    }
  } else {
    if (items.length > 2) {
      const findings = synthesizeProse(items.slice(0, 6), { maxItems: 6, withCitations: true });
      if (findings && findings !== opening) {
        lines.push('## Key findings', '', findings, '');
      }
    }
    if (items.length > 4) {
      const rest = synthesizeProse(items.slice(4), { maxItems: 8, withCitations: true });
      if (rest) {
        lines.push('## Further analysis', '', rest, '');
      }
    }
  }

  // A Limitations section only when there is a limitation worth naming. This
  // used to be appended unconditionally, so a well-sourced answer still carried
  // a canned paragraph about how unreliable it might be.
  const limitation = describeEvidenceGap(items, sources);
  if (limitation) {
    lines.push('## Limitations', '', limitation, '');
  }

  lines.push(renderReferences(sources));
  lines.push(renderFilesAndMissing(params));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderChatFallback(params: {
  prompt: string;
  items: EvidenceItem[];
  sources: EvidenceSource[];
  live: string | null;
  createdFiles?: string[];
  visibleFiles?: string[];
  missingExtensions?: string[];
}): string {
  if (params.live) {
    const extras = renderFilesAndMissing(params);
    return [params.live, extras].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const prose = synthesizeProse(params.items, { maxItems: 8, withCitations: params.sources.length > 0 });
  if (!prose) {
    const files = renderFilesAndMissing(params);
    if (files.trim()) {
      return [
        'I stopped before finishing a full answer, but these files are available from this session:',
        '',
        files
      ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    return 'I stopped before finishing and did not gather enough information to answer fully. Please try again or rephrase your request.';
  }

  const chunks = [
    prose,
    '',
    'I could not complete every step, so this is based only on what was already found.'
  ];

  if (params.sources.length) {
    chunks.push('', renderReferences(params.sources.slice(0, 8)));
  }
  chunks.push(renderFilesAndMissing(params));
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function evidenceSections(items: EvidenceItem[], sources: EvidenceSource[]) {
  const sections: Array<{ title: string; content: string }> = [];
  if (items.length) {
    sections.push({
      title: 'Key findings',
      content: synthesizeProse(items, { maxItems: 12, withCitations: true }) || items.map((item) => `- ${item.text}${item.sourceId ? ` [${item.sourceId}]` : ''}`).join('\n')
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
  /** Publishes the artifact one tool call produced. See `buildScopedArtifact`. */
  publishToolArtifact: (result: ToolResult) => void;
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
      executiveSummary: synthesizeProse(items.slice(0, 4), { withCitations: false }) || 'Limited synthesizable evidence was available from retrieved sources.',
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
      params.publishToolArtifact(result);
      return Array.from(new Set(created));
    }
  }

  const addFile = async (toolName: string, fileArgs: Record<string, unknown>) => {
    const result = await params.executeTool(toolName, fileArgs, params.ctx);
    if (result.success) {
      created.push(...(result.createdFiles || []));
      params.publishToolArtifact(result);
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

  return Array.from(new Set(created));
}

export async function buildStrictFallbackContent(params: {
  prompt: string;
  reason: string;
  ctx: ToolContext;
  observations: ToolObservation[];
  sources: SearchResult[];
  mode?: FallbackMode;
  /** Optional product notice (omit for finished-style research reports). */
  notice?: string | null;
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
  const mode: FallbackMode = params.mode || 'research';

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

  // Live data: prefer plain answer when cards/observations exist (even in research mode)
  const live = renderLiveDataFallback({
    prompt: params.prompt,
    observations: params.observations,
    files: params.ctx.files
  });
  if (live && mode === 'chat') {
    const extras = renderFilesAndMissing({
      createdFiles: created,
      visibleFiles,
      missingExtensions: missing
    });
    return [live, extras].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return renderResearchFallbackReport({
    prompt: params.prompt,
    observations: params.observations,
    sources,
    createdFiles: created,
    visibleFiles,
    missingExtensions: missing,
    mode,
    // Prefer caller notice; default research path is a finished report (no step-limit chrome).
    notice: params.notice === null
      ? undefined
      : (params.notice || undefined)
  });
}
