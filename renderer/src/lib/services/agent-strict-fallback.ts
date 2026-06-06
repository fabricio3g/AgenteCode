import type { SearchResult } from '$lib/types/tauri';
import type { ToolContext, ToolObservation, ToolResult } from '$lib/services/agent-types';
import type { AgentArtifact } from '$lib/types/chat';

type ReportSource = {
  id: string;
  title?: string;
  url?: string;
  provider?: string;
  snippet?: string;
};

type ReportSection = {
  title: string;
  content?: string;
  bullets?: string[];
  citations?: string[];
};

function cleanText(value: unknown, max = 900): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isMedicalReportRequest(prompt: string): boolean {
  return /\b(disease|syndrome|cancer|drug|therapy|treatment|diagnos|clinical|patient|guideline|epidemiology|pathophysiology|prognosis|pemphigus|autoimmune|dermatology|medicine|medical)\b/i.test(prompt);
}

function sourceAuthority(source: { title?: string; url?: string }): string {
  const value = `${source.title || ''} ${source.url || ''}`.toLowerCase();
  if (/guideline|consensus|eadv|bad\.org|british association|american academy|jaad|lancet|nejm|bmj/.test(value)) return 'High: guideline, society, or major journal source';
  if (/ncbi|pubmed|pmc|nih|statpearls/.test(value)) return 'High: biomedical reference or indexed literature';
  if (/dermnet|merckmanual|msdmanual|mayoclinic|clevelandclinic/.test(value)) return 'Moderate: clinical reference source';
  if (/foundation|association|patient|support/.test(value)) return 'Contextual: patient/support resource';
  return 'Unclassified: review before relying on specific claims';
}

function mapSources(sources: SearchResult[]): ReportSource[] {
  return sources.map((source, index) => ({
    id: String(index + 1),
    title: source.title || source.url || `Source ${index + 1}`,
    url: source.url || '',
    provider: source.provider || '',
    snippet: cleanText(source.snippet || source.full_content, 650)
  }));
}

function sourceBullets(sources: ReportSource[], keywords: RegExp, fallbackCount = 5): string[] {
  const matched = sources.filter((source) => keywords.test(`${source.title || ''} ${source.snippet || ''}`));
  const selected = (matched.length ? matched : sources).slice(0, fallbackCount);
  const seen = new Set<string>();
  return selected
    .map((source) => {
      const snippet = cleanText(source.snippet || '', 360)
        .replace(/^[-–—\s]+/, '')
        .replace(/\s+read more\s*$/i, '')
        .trim();
      const fact = snippet || `Review ${source.title || source.url} for this point`;
      return `${fact} [${source.id}]`;
    })
    .filter((line) => {
      const key = line.toLowerCase().replace(/\[[0-9]+\]/g, '').slice(0, 120);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sourceCitations(sources: ReportSource[], keywords: RegExp, fallbackCount = 5): string[] {
  const matched = sources.filter((source) => keywords.test(`${source.title || ''} ${source.snippet || ''}`));
  return (matched.length ? matched : sources).slice(0, fallbackCount).map((source) => source.id);
}

function inlineReportTitle(prompt: string): string {
  const cleaned = cleanText(prompt, 140)
    .replace(/^(give|create|make|write)\s+(me\s+)?(an?\s+)?((extense|extensive|detailed|full|comprehensive)\s+)?(report|informe)\s+(about|on|of|for|sobre|de)\s+/i, '')
    .replace(/^((extense|extensive|detailed|full|comprehensive)\s+)?(report|informe)\s+(about|on|of|for|sobre|de)\s+/i, '')
    .replace(/^(search|research|look up)\s+(about|on|for)?\s*/i, '')
    .replace(/\s+and\s+(give|create|make|write)\s+me[\s\S]*$/i, '')
    .replace(/\b(extense|extensive|detailed|full)\s+(report|informe)\b[\s\S]*$/i, '')
    .replace(/\b(report|informe)\b[\s\S]*$/i, '')
    .trim();
  if (!cleaned) return 'Research Report';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function apaReference(source: ReportSource): string {
  const title = (source.title || source.url || `Source ${source.id}`).replace(/\.$/, '');
  const site = source.provider ? ` ${source.provider}.` : '';
  const url = source.url ? ` ${source.url}` : '';
  return `${title}. (n.d.).${site}${url}`.replace(/\s+/g, ' ').trim();
}

function buildReportFromEvidence(params: {
  prompt: string;
  reason: string;
  title: string;
  evidence: string;
  sources: SearchResult[];
}): {
  title: string;
  subtitle: string;
  executiveSummary: string;
  sections: ReportSection[];
  sources: ReportSource[];
  limitations: string[];
  tables: Array<{ name: string; columns: string[]; rows: Array<Record<string, string>> }>;
} {
  const reportSources = mapSources(params.sources).slice(0, 60);
  const sourceCount = reportSources.length;
  const isMedical = isMedicalReportRequest(params.prompt);
  const topSources = reportSources.slice(0, 8);
  const sourceIds = topSources.map((source) => source.id);
  const partialNote = `The agent stopped because ${params.reason}. This report is structured from gathered evidence only and should be treated as partial until reviewed against the original sources.`;
  const sourceOverview = topSources.map((source) => `[${source.id}] ${source.title || source.url}`).join('\n');

  const sections: ReportSection[] = [
    {
      title: 'Methodology and Evidence Status',
      content: [
        partialNote,
        `Evidence base captured before stopping: ${sourceCount} source${sourceCount === 1 ? '' : 's'}.`,
        sourceOverview ? `Highest-priority gathered sources:\n${sourceOverview}` : 'No source metadata was captured.'
      ].join('\n\n'),
      citations: sourceIds
    }
  ];

  if (isMedical) {
    sections.push(
      {
        title: 'Clinical Overview',
        content: 'This section summarizes the disease definition, clinical relevance, epidemiology, and major evidence themes found in the gathered sources. Claims are limited to captured source excerpts and should be checked against the cited URLs before clinical use.',
        bullets: sourceBullets(reportSources, /overview|definition|rare|autoimmune|epidemiology|incidence|prevalence|mucosa|skin|clinical/i, 6),
        citations: sourceCitations(reportSources, /overview|definition|rare|autoimmune|epidemiology|incidence|prevalence|mucosa|skin|clinical/i, 6)
      },
      {
        title: 'Etiology and Pathophysiology',
        content: 'Use this section to distinguish established mechanisms from suspected triggers. For pemphigus-type diseases, prioritize evidence about autoantibodies, desmosomal proteins, acantholysis, genetic risk, and medication or environmental triggers when present in sources.',
        bullets: sourceBullets(reportSources, /pathophysiology|etiology|cause|autoantib|desmoglein|dsg|acantholysis|keratinocyte|hla|trigger|drug-induced/i, 6),
        citations: sourceCitations(reportSources, /pathophysiology|etiology|cause|autoantib|desmoglein|dsg|acantholysis|keratinocyte|hla|trigger|drug-induced/i, 6)
      },
      {
        title: 'Clinical Presentation and Complications',
        content: 'This section organizes symptoms, signs, common sites, disease variants, and complications. It should be read as a synthesis map rather than a final clinical guideline because source retrieval stopped early.',
        bullets: sourceBullets(reportSources, /symptom|sign|presentation|mucosal|oral|blister|erosion|bullae|nikolsky|complication|infection|malnutrition|mortality/i, 7),
        citations: sourceCitations(reportSources, /symptom|sign|presentation|mucosal|oral|blister|erosion|bullae|nikolsky|complication|infection|malnutrition|mortality/i, 7)
      },
      {
        title: 'Diagnosis and Differential Diagnosis',
        content: 'Prioritize diagnostic confirmation methods over nonspecific clinical impressions. For autoimmune blistering disease, source excerpts mentioning biopsy, histopathology, immunofluorescence, ELISA, and differential diagnoses are grouped here.',
        bullets: sourceBullets(reportSources, /diagnos|biopsy|histolog|immunofluorescence|elisa|desmoglein|differential|pemphigoid|lichen|erythema|toxic epidermal|foliaceus/i, 7),
        citations: sourceCitations(reportSources, /diagnos|biopsy|histolog|immunofluorescence|elisa|desmoglein|differential|pemphigoid|lichen|erythema|toxic epidermal|foliaceus/i, 7)
      },
      {
        title: 'Treatment and Management',
        content: 'Treatment statements require the strongest evidence hierarchy available: current guidelines and expert consensus first, then trials and reviews, then clinical summaries. This partial report surfaces gathered treatment evidence but does not replace specialist guidance.',
        bullets: sourceBullets(reportSources, /treatment|management|corticosteroid|prednisone|rituximab|azathioprine|mycophenolate|ivig|plasmapheresis|wound|oral hygiene|monitoring|vaccine/i, 8),
        citations: sourceCitations(reportSources, /treatment|management|corticosteroid|prednisone|rituximab|azathioprine|mycophenolate|ivig|plasmapheresis|wound|oral hygiene|monitoring|vaccine/i, 8)
      },
      {
        title: 'Prognosis, Patient Education, and Follow-up',
        content: 'This section groups prognosis, safety counseling, follow-up, and quality-of-life evidence. Patient-facing advice should be checked against clinician-authored sources before distribution.',
        bullets: sourceBullets(reportSources, /prognosis|outcome|mortality|follow-up|education|diet|oral hygiene|infection|support|quality of life|relapse/i, 6),
        citations: sourceCitations(reportSources, /prognosis|outcome|mortality|follow-up|education|diet|oral hygiene|infection|support|quality of life|relapse/i, 6)
      }
    );
  } else {
    sections.push(
      {
        title: 'Key Findings',
        content: 'The following findings are organized from the gathered source excerpts. They should be expanded by reviewing the cited sources directly if higher confidence or publication-ready writing is required.',
        bullets: sourceBullets(reportSources, /./, 10),
        citations: sourceCitations(reportSources, /./, 10)
      },
      {
        title: 'Evidence Quality and Gaps',
        content: 'Use the source map to separate primary or authoritative sources from summaries, blogs, and secondary references. Claims without a captured excerpt should be verified before reuse.',
        bullets: topSources.map((source) => `[${source.id}] ${source.title || source.url} - ${sourceAuthority(source)}`),
        citations: sourceIds
      },
      {
        title: 'Recommended Next Verification',
        bullets: [
          'Open the highest-authority sources and verify the most important claims directly.',
          'Resolve contradictions across sources before final publication.',
          'Replace snippet-derived language with synthesized prose after full source review.'
        ]
      }
    );
  }

  const diagnosticRows = isMedical ? [
    { area: 'Clinical suspicion', evidence_needed: 'Characteristic symptoms, lesion distribution, red flags, severity', gathered_sources: sourceCitations(reportSources, /symptom|sign|presentation|clinical|oral|mucosal|blister|erosion/i, 8).join(', ') },
    { area: 'Confirmatory testing', evidence_needed: 'Biopsy, histopathology, direct/indirect immunofluorescence, ELISA when applicable', gathered_sources: sourceCitations(reportSources, /biopsy|histolog|immunofluorescence|elisa|diagnos/i, 8).join(', ') },
    { area: 'Treatment pathway', evidence_needed: 'Guideline-backed first-line, adjunctive, refractory, and monitoring recommendations', gathered_sources: sourceCitations(reportSources, /treatment|management|guideline|rituximab|corticosteroid|azathioprine|mycophenolate/i, 8).join(', ') },
    { area: 'Patient safety', evidence_needed: 'Complications, infection risk, medication adverse effects, follow-up', gathered_sources: sourceCitations(reportSources, /complication|infection|adverse|follow-up|monitoring|prognosis/i, 8).join(', ') }
  ] : [];

  return {
    title: params.title,
    subtitle: isMedical ? 'Evidence-mapped clinical research report' : 'Evidence-mapped research report',
    executiveSummary: [
      partialNote,
      sourceCount
        ? `The report uses ${sourceCount} gathered source${sourceCount === 1 ? '' : 's'} and maps key claims back to source IDs.`
        : 'No source list was available; only tool evidence could be preserved.',
      isMedical
        ? 'Medical claims are organized by clinical overview, pathophysiology, presentation, diagnosis, treatment, prognosis, and patient education so the document is usable for expert review.'
        : 'Findings are organized into key evidence, quality gaps, and recommended verification steps.'
    ].join(' '),
    sections,
    sources: reportSources,
    limitations: [
      'The agent stopped before normal completion, so the report is partial.',
      'Some source excerpts may be snippets rather than full-page captures.',
      'Claims should be verified against the original URLs before clinical, legal, financial, or publication use.',
      params.evidence ? 'Raw tool evidence was preserved in the appendix for auditability.' : 'No raw tool evidence text was available.'
    ],
    tables: [
      {
        name: 'Source quality map',
        columns: ['id', 'title', 'url', 'authority', 'excerpt'],
        rows: reportSources.map((source) => ({
          id: source.id,
          title: source.title || '',
          url: source.url || '',
          authority: sourceAuthority(source),
          excerpt: source.snippet || ''
        }))
      },
      ...(diagnosticRows.length ? [{
        name: 'Medical evidence map',
        columns: ['area', 'evidence_needed', 'gathered_sources'],
        rows: diagnosticRows
      }] : [])
    ]
  };
}

function reportToMarkdown(report: ReturnType<typeof buildReportFromEvidence>): string {
  const lines = [`# ${report.title}`, ''];
  if (report.subtitle) lines.push(report.subtitle, '');
  lines.push('## Executive Summary', '', report.executiveSummary, '');

  for (const section of report.sections) {
    lines.push(`## ${section.title}`, '');
    const bullets = section.bullets || [];
    if (!bullets.length && section.content) lines.push(section.content, '');
    for (const bullet of bullets) lines.push(`- ${bullet}`);
    if (section.bullets?.length) lines.push('');
  }

  if (report.limitations.length) {
    lines.push('## Limitations', '');
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
    lines.push('');
  }

  if (report.sources.length) {
    lines.push('## References', '');
    for (const source of report.sources.slice(0, 12)) {
      lines.push(`${source.id}. ${apaReference(source)}`);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

  const title = params.fallbackTitle(params.prompt);
  const sources = params.evidenceSources(params.observations, params.sources);
  const report = buildReportFromEvidence({
    prompt: params.prompt,
    reason: params.reason,
    title,
    evidence,
    sources
  });
  const sections = [
    ...report.sections,
    { title: 'Raw Evidence Appendix', content: params.compactText(evidence, 8000) }
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
      subtitle: report.subtitle,
      executiveSummary: report.executiveSummary,
      sections,
      sources: report.sources,
      limitations: report.limitations,
      tables: report.tables,
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
    const rows = params.sourceRows(params.evidenceSources(params.observations, params.sources));
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
        { title: 'What was gathered', content: evidence.split('\n').filter(Boolean).slice(0, 5) },
        { title: 'Sources', content: params.evidenceSources(params.observations, params.sources).slice(0, 6).map((source) => source.title || source.url) }
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

  const sources = params.evidenceSources(params.observations, params.sources);
  const visibleFiles = Object.keys(params.ctx.files)
    .filter((path) => !path.startsWith('__'))
    .sort((a, b) => a.localeCompare(b));
  const missing = params.missingRequestedArtifactExtensions(params.ctx.files, params.prompt);

  const completedSegments: string[] = [];
  if (sources.length) completedSegments.push(`${sources.length} source${sources.length === 1 ? '' : 's'} gathered`);
  if (visibleFiles.length) {
    completedSegments.push(`${visibleFiles.length} file${visibleFiles.length === 1 ? '' : 's'} available (${visibleFiles.slice(0, 4).join(', ')}${visibleFiles.length > 4 ? ', ...' : ''})`);
  }
  if (created.length) completedSegments.push(`created from evidence: ${Array.from(new Set(created)).join(', ')}`);
  if (!completedSegments.length) completedSegments.push('no reliable evidence was gathered');

  const missingLine = missing.length
    ? `missing requested file type${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
    : 'none';

  if (sources.length && !missing.length && !created.length) {
    const evidence = params.observations
      .filter((observation) => observation.success && observation.summary)
      .map((observation, index) => `${index + 1}. ${observation.summary}`)
      .join('\n\n');
    const report = buildReportFromEvidence({
      prompt: params.prompt,
      reason: params.reason,
      title: inlineReportTitle(params.prompt),
      evidence,
      sources
    });
    return reportToMarkdown(report);
  }

  return [
    `Agent stopped because ${params.reason}.`,
    `What was completed: ${completedSegments.join('; ')}.`,
    `What is missing: ${missingLine}.`
  ].join('\n');
}
