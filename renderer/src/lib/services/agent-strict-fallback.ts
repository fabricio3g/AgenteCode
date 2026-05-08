import type { SearchResult } from '$lib/types/tauri';

type ToolResultLike = {
  success: boolean;
  createdFiles?: string[];
};

type ToolObservationLike = {
  success: boolean;
  summary: string;
};

type ToolContextLike = {
  files: Record<string, string>;
  onArtifact: (artifact: unknown) => void;
};

export async function ensureRequestedArtifactsFromEvidence(params: {
  prompt: string;
  reason: string;
  ctx: ToolContextLike;
  observations: ToolObservationLike[];
  sources: SearchResult[];
  requestedArtifactKinds: (prompt: string) => { docx: boolean; xlsx: boolean; pptx: boolean; pdf: boolean };
  missingRequestedArtifactExtensions: (files: Record<string, string>, prompt: string) => string[];
  buildEvidenceText: (observations: ToolObservationLike[], sources: SearchResult[]) => string;
  fallbackTitle: (prompt: string) => string;
  evidenceSources: (observations: ToolObservationLike[], sources: SearchResult[]) => SearchResult[];
  sourceRows: (sources: SearchResult[]) => Array<Record<string, string>>;
  compactText: (value: unknown, max?: number) => string;
  executeTool: (name: string, args: Record<string, unknown>, ctx: ToolContextLike) => Promise<ToolResultLike>;
  buildArtifact: (ctx: ToolContextLike) => unknown;
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
  const sections = [
    {
      title: 'Summary',
      content: [
        `The agent stopped because ${params.reason}.`,
        'This artifact only includes information gathered during the agent loop.'
      ].join('\n')
    },
    { title: 'Evidence gathered', content: evidence }
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
      executiveSummary: `The agent stopped because ${params.reason}. This partial work product uses only gathered evidence.`,
      sections,
      sources: params.evidenceSources(params.observations, params.sources).map((source, index) => ({
        id: String(index + 1),
        title: source.title,
        url: source.url,
        provider: source.provider,
        snippet: source.snippet
      })),
      limitations: ['The agent stopped before normal completion.', 'Unverified or unavailable facts were not added.'],
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
  ctx: ToolContextLike;
  observations: ToolObservationLike[];
  sources: SearchResult[];
  ensureRequestedArtifactsFromEvidence: (params: {
    prompt: string;
    reason: string;
    ctx: ToolContextLike;
    observations: ToolObservationLike[];
    sources: SearchResult[];
  }) => Promise<string[]>;
  evidenceSources: (observations: ToolObservationLike[], sources: SearchResult[]) => SearchResult[];
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

  return [
    `Agent stopped because ${params.reason}.`,
    `What was completed: ${completedSegments.join('; ')}.`,
    `What is missing: ${missingLine}.`
  ].join('\n');
}
