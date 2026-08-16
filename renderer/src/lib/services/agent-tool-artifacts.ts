import type { AgentArtifact } from '$lib/types/chat';
import type { GeneratedArtifactFile } from '$lib/services/generated-documents';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import {
  buildEvidenceMatrixRows,
  buildResearchCitations,
  buildResearchExportFiles,
  parseExportKinds,
  type ResearchExportKind
} from '$lib/services/research-artifacts';

export async function handleCreateReport(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  buildHtmlReport: (title: string, sections: Array<{ title?: string; heading?: string; content?: string }>, options?: { theme?: 'light' | 'dark' }) => string;
  buildMarkdownReport: (title: string, sections: Array<{ title?: string; heading?: string; content?: string }>) => string;
  writeWorkspaceFile: (workspaceRoot: string, path: string, content: string) => Promise<unknown>;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Report');
  const sections = Array.isArray(params.args.sections) ? params.args.sections as Array<{ title?: string; heading?: string; content?: string }> : [];
  const format = String(params.args.format || 'markdown');
  const theme = (params.args.theme === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
  const path = params.normPath(params.args.path) || (format === 'html' ? 'report.html' : 'report.md');
  const validation = params.validateGeneratedDocumentArgs({ title, sections }, [format === 'html' ? 'html' : 'md']);
  if (!validation.ok) {
    return params.fail(
      validation.error || 'Document content is too thin.',
      'Rebuild the report using gathered evidence. Include real body content, bullets, sources, and limitations instead of only section titles.'
    );
  }
  const content = format === 'html'
    ? params.buildHtmlReport(title, sections, { theme })
    : params.buildMarkdownReport(title, sections);

  if (params.isWorkspace(params.ctx) && params.ctx.workspaceRoot) {
    await params.writeWorkspaceFile(params.ctx.workspaceRoot, path, content);
    params.ctx.files[path] = content;
  } else {
    params.ctx.files[path] = content;
    if (format === 'html') params.ctx.files['__preview__.html'] = content;
  }
  return params.ok({ title, format, path, sections: sections.length }, { createdFiles: [path] });
}

export async function handleCreateWorkProduct(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  isTauri: () => boolean;
  isWorkspace: (ctx: ToolContext) => boolean;
  uid: (prefix: string) => string;
  viewerPathFor: (path: string) => string;
  createWorkProductArtifactFiles: (args: Record<string, unknown>) => Promise<{ files: GeneratedArtifactFile[]; html?: string; warnings: string[] }>;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  if (!params.isTauri()) return params.fail('Professional work product generation requires the desktop app.');
  if (params.isWorkspace(params.ctx)) return params.fail('Professional work products are currently available in chat sandbox mode only.');

  try {
    const formats = Array.isArray(params.args.formats) ? params.args.formats.map((format) => String(format)) : ['md'];
    const validation = params.validateGeneratedDocumentArgs(params.args, formats);
    if (!validation.ok) {
      return params.fail(
        validation.error || 'Document content is too thin.',
        'Rebuild the work product from gathered evidence. Include meaningful body content, populated tables/slides, sources, and limitations instead of only titles.'
      );
    }
    const generated = await params.createWorkProductArtifactFiles(params.args);
    const createdFiles: string[] = [];
    for (const file of generated.files) {
      params.ctx.files[file.path] = file.dataUrl;
      createdFiles.push(file.path);
      if (file.previewHtml) params.ctx.files[params.viewerPathFor(file.path)] = file.previewHtml;
    }
    const firstPreview = generated.files.find((file) => file.previewHtml)?.previewHtml || generated.html || '';
    if (firstPreview) params.ctx.files['__preview__.html'] = firstPreview;

    const sourceIds = Array.isArray(params.args.sources)
      ? params.args.sources
          .map((source: { id?: string; url?: string; title?: string }, index: number) => String(source?.id || source?.url || source?.title || `source-${index + 1}`).trim())
          .filter(Boolean)
      : [];

    const fileKinds = new Set(generated.files.map((file) => file.path.split('.').pop()?.toLowerCase()).filter(Boolean));
    const workProductKind =
      generated.files.length > 1 ? 'bundle'
      : fileKinds.has('xlsx') ? 'spreadsheet'
      : fileKinds.has('pptx') ? 'presentation'
      : 'report';

    params.ctx.workProduct = {
      id: params.uid('work-product'),
      title: String(params.args.title || 'Work product'),
      kind: workProductKind as NonNullable<AgentArtifact['workProduct']>['kind'],
      status: generated.warnings.length ? 'partial' : 'ready',
      files: generated.files.map((file) => ({
        path: file.path,
        title: file.path.split('/').pop() || file.path,
        mime: file.mime,
        kind: file.path.split('.').pop()?.toLowerCase() as NonNullable<AgentArtifact['workProduct']>['files'][number]['kind'],
        previewPath: file.previewHtml ? params.viewerPathFor(file.path) : undefined
      })),
      sourceIds,
      evidenceMap: Object.fromEntries(generated.files.map((file) => [file.path, sourceIds])),
      warnings: generated.warnings,
      createdAt: Date.now()
    };

    // No direct `onArtifact` here. The tool loop publishes from the returned result
    // immediately after this call, and doing it here as well built the artifact
    // before the manifest existed — which is how work products ended up resolving
    // as `kind: 'web'` and rendering in a bare iframe.
    return params.ok({ title: params.ctx.workProduct.title, files: createdFiles, warnings: generated.warnings }, { createdFiles });
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleCreateChart(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Chart');
  const chartType = String(params.args.chart_type || 'bar');
  const labels = Array.isArray(params.args.labels) ? params.args.labels.map((l) => String(l)) : [];
  const datasets = Array.isArray(params.args.datasets) ? params.args.datasets as Array<{ label?: string; data?: number[] }> : [];
  const path = artifactDataPath(params.normPath(params.args.path), 'chart.json');

  if (labels.length < 1) return params.fail('Chart requires at least one label.');
  if (datasets.length < 1) return params.fail('Chart requires at least one dataset.');
  if (!['bar', 'line', 'pie', 'donut'].includes(chartType)) {
    return params.fail(`Unknown chart type "${chartType}". Use bar, line, pie, or donut.`);
  }

  const sanitizedDatasets = datasets.map((ds, i) => ({
    label: String(ds.label || `Series ${i + 1}`),
    data: Array.isArray(ds.data) ? ds.data.map(Number).filter(Number.isFinite) : []
  }));

  const payload = {
    kind: 'chart',
    title,
    chartType,
    labels,
    datasets: sanitizedDatasets
  };

  writeInlineArtifact(params.ctx, path, payload);

  return params.ok({ title, chartType, labels, datasets: sanitizedDatasets.length, path }, { createdFiles: [path] });
}

function artifactDataPath(path: string, fallback: string): string {
  const candidate = path || fallback;
  return candidate.replace(/\.html?$/i, '.json') || fallback;
}

/*
 * One file per call, at its own path.
 *
 * This used to also copy the payload into a single shared `__artifact__.json` slot
 * and then `delete ctx.files['__preview__.html']`. Both were destructive: a turn
 * that made a chart and then a diagram overwrote the chart's slot so only the
 * diagram appeared, and a chart created after a report deleted the report's preview.
 * Artifacts are now scoped per tool call (`buildScopedArtifact`), which reads the
 * payload straight from this path.
 */
function writeInlineArtifact(ctx: ToolContext, path: string, payload: Record<string, unknown>) {
  ctx.files[path] = JSON.stringify(payload, null, 2);
}

export async function handleCreateDiagram(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Diagram');
  const mermaidSource = String(params.args.mermaid_source || '');
  const path = artifactDataPath(params.normPath(params.args.path), 'diagram.json');

  if (!mermaidSource.trim()) return params.fail('Diagram requires mermaid source code.');

  const payload = {
    kind: 'diagram',
    title,
    diagramType: params.args.diagram_type ? String(params.args.diagram_type) : undefined,
    source: mermaidSource
  };

  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ title, path, diagramType: params.args.diagram_type }, { createdFiles: [path] });
}

export async function handleCreateMap(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  geocodePlace: (place: string) => Promise<{ latitude: number; longitude: number; label: string }>;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const place = String(params.args.place || '').trim();
  const markers = Array.isArray(params.args.markers) ? params.args.markers as Array<{ lat?: number; lng?: number; label?: string; popup?: string }> : [];
  const polylines = Array.isArray(params.args.polylines) ? params.args.polylines : [];
  const path = artifactDataPath(params.normPath(params.args.path), 'map.json');

  let lat = Number(params.args.latitude);
  let lng = Number(params.args.longitude);
  let resolvedLabel = '';

  /*
   * A place name is resolved here, at execution time, and only when coordinates were
   * not supplied. Explicit coordinates always win — a model that already knows them
   * should not pay for a network round trip.
   */
  if (place && !(Number.isFinite(lat) && Number.isFinite(lng))) {
    try {
      const hit = await params.geocodePlace(place);
      lat = hit.latitude;
      lng = hit.longitude;
      resolvedLabel = hit.label;
    } catch (err: unknown) {
      return params.fail(
        `Could not resolve "${place}": ${err instanceof Error ? err.message : String(err)}`,
        'Retry with explicit latitude and longitude, or a better-known place name.'
      );
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return params.fail(
      'A map needs either a place name or latitude and longitude.',
      'Pass `place` (e.g. "Victoria, Entre Rios") and the coordinates will be resolved.'
    );
  }

  // No default coordinates. The old fallback silently dropped an under-specified map
  // on London, which looks like a successful answer to a completely different question.
  const title = String(params.args.title || resolvedLabel || place || 'Map');
  const zoom = Number(params.args.zoom);

  // A geocoded place with no markers gets one, so the resolved point is actually shown.
  const resolvedMarkers = markers.length || !resolvedLabel
    ? markers
    : [{ lat, lng, label: resolvedLabel }];

  const payload = {
    kind: 'map',
    title,
    latitude: lat,
    longitude: lng,
    zoom: Number.isFinite(zoom) ? zoom : 8,
    markers: resolvedMarkers,
    polylines
  };

  writeInlineArtifact(params.ctx, path, payload);
  return params.ok(
    { title, path, latitude: lat, longitude: lng, markerCount: resolvedMarkers.length, ...(resolvedLabel ? { resolved: resolvedLabel } : {}) },
    { createdFiles: [path] }
  );
}

export async function handleCreateDashboard(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Dashboard');
  const subtitle = String(params.args.subtitle || '');
  const metrics = Array.isArray(params.args.metrics) ? params.args.metrics as Array<{ label?: string; value?: string | number; trend?: string; unit?: string; color?: string }> : [];
  const sections = Array.isArray(params.args.sections) ? params.args.sections as Array<{ heading?: string; content?: string }> : [];
  const path = artifactDataPath(params.normPath(params.args.path), 'dashboard.json');

  if (metrics.length < 1) return params.fail('Dashboard requires at least one metric.');

  const payload = {
    kind: 'dashboard',
    title,
    subtitle,
    metrics,
    sections
  };

  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ title, path, metricCount: metrics.length }, { createdFiles: [path] });
}

function sanitizeHtmlCard(html: string): string {
  let out = String(html || '');
  // Remove scripts and remote resource hooks — self-contained snippets only.
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
  out = out.replace(/\s(href|src)\s*=\s*(['"])\s*https?:\/\/[^'"]*\2/gi, '');
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed[\s\S]*?>/gi, '');
  return out.trim();
}

export function handleCreateInfoCard(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): ToolResult {
  const title = String(params.args.title || 'Info').trim();
  const subtitle = String(params.args.subtitle || '').trim();
  const footer = String(params.args.footer || '').trim();
  const accent = String(params.args.accent || '').trim();
  const rowInput =
    params.args.rows
    ?? params.args.items
    ?? params.args.facts
    ?? params.args.data;
  const rawRows = Array.isArray(rowInput)
    ? rowInput
    : rowInput && typeof rowInput === 'object'
      ? Object.entries(rowInput as Record<string, unknown>).map(([label, value]) => ({ label, value }))
      : [];
  const rows = rawRows
    .map((row) => {
      if (Array.isArray(row)) {
        const label = String(row[0] ?? '').trim();
        const value = String(row[1] ?? '').trim();
        const hint = String(row[2] ?? '').trim();
        if (!label && !value) return null;
        return { label: label || 'Detail', value: value || '—', ...(hint ? { hint } : {}) };
      }
      if (row === null || row === undefined) return null;
      if (typeof row !== 'object') {
        const value = String(row).trim();
        return value ? { label: 'Detail', value } : null;
      }
      const r = row as Record<string, unknown>;
      const label = String(r.label ?? r.name ?? r.key ?? r.title ?? '').trim();
      const value = String(r.value ?? r.content ?? r.text ?? r.description ?? '').trim();
      const hint = String(r.hint ?? r.note ?? '').trim();
      if (!label && !value) return null;
      return { label: label || 'Detail', value: value || '—', ...(hint ? { hint } : {}) };
    })
    .filter(Boolean) as Array<{ label: string; value: string; hint?: string }>;

  if (!title) return params.fail('Info card requires a title.');
  if (rows.length < 1) {
    return params.ok(
      {
        created: false,
        skipped: true,
        reason: 'No evidence-backed label/value rows were provided.'
      },
      {
        note: 'The optional info card was skipped. Continue with the requested answer or report; retry the card only when concrete rows are available.'
      }
    );
  }

  const path = artifactDataPath(params.normPath(params.args.path), 'info-card.json');
  const payload = {
    kind: 'info_card',
    title,
    ...(subtitle ? { subtitle } : {}),
    rows,
    ...(footer ? { footer } : {}),
    ...(accent ? { accent } : {})
  };

  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ created: true, title, path, rowCount: rows.length }, { createdFiles: [path] });
}

export function handleCreateHtmlCard(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): ToolResult {
  const title = String(params.args.title || 'Card').trim();
  const html = sanitizeHtmlCard(String(params.args.html || ''));
  if (!title) return params.fail('HTML card requires a title.');
  if (html.length < 8) return params.fail('HTML card requires self-contained HTML content.');
  if (html.length > 80_000) return params.fail('HTML card is too large. Keep snippets small.');

  const path = artifactDataPath(params.normPath(params.args.path), 'html-card.json');
  const payload = { kind: 'html_card', title, html };
  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ title, path, htmlLength: html.length }, { createdFiles: [path] });
}

/** Deterministic research exports from gathered sources (citations, matrix, shortlist, …). */
export function handleExportResearchPackage(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): ToolResult {
  const sources = Array.isArray(params.ctx.sources) ? params.ctx.sources : [];
  if (!sources.length) {
    return params.fail(
      'No gathered sources to export.',
      'Run web_search (and fetch_url when useful) first, then call export_research_package.'
    );
  }

  const kinds = parseExportKinds(params.args.kinds) as ResearchExportKind[];
  const title = String(params.args.title || params.ctx.rawPrompt || 'Research').slice(0, 120);
  const query = String(params.args.query || params.ctx.rawPrompt || '').slice(0, 400);

  const files = buildResearchExportFiles({
    sources,
    kinds,
    title,
    query,
    searchMode: params.ctx.searchMode
  });

  if (!files.length) {
    return params.fail('Could not build research exports from the available sources.');
  }

  const createdFiles: string[] = [];
  for (const file of files) {
    params.ctx.files[file.path] = file.content;
    createdFiles.push(file.path);
  }

  // Optional spreadsheet-shaped matrix for create_spreadsheet compatibility in ctx (CSV already written).
  if (kinds.includes('matrix')) {
    const citations = buildResearchCitations(sources);
    const { columns, rows } = buildEvidenceMatrixRows(citations);
    params.ctx.files['__research_matrix_preview__.json'] = JSON.stringify({ title, columns, rows }, null, 2);
  }

  return params.ok(
    {
      title,
      kinds,
      fileCount: createdFiles.length,
      files: createdFiles,
      sourceCount: sources.length
    },
    { createdFiles }
  );
}
