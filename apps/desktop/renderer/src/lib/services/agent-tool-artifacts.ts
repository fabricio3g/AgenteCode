import type { ChartArtifactPayload } from '$lib/types/chat';
import { CHART_TYPES, resolveChartType } from '$lib/utils/chart-types';
import { validateChartData } from '$lib/utils/chart-math';
import type { ChartData, Dataset } from '$lib/utils/chart-data';
import type { AgentArtifact } from '$lib/types/chat';
import { renderReportHtml, renderReportMarkdown, type GeneratedArtifactFile } from '$lib/services/generated-documents';
import { resolveAccent } from '$shared/artifact-theme';
import { specPathFor } from '$lib/utils/artifact-files';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';

export async function handleCreateReport(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  isWorkspace: (ctx: ToolContext) => boolean;
  writeWorkspaceFile: (workspaceRoot: string, path: string, content: string) => Promise<unknown>;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Report');
  const format = params.args.format === 'html' ? 'html' : 'markdown';
  const path = params.normPath(params.args.path) || (format === 'html' ? 'report.html' : 'report.md');
  // Validate everything the model sent: a report written as one `content`
  // body is as valid as one split into sections.
  const validation = params.validateGeneratedDocumentArgs(params.args, [format === 'html' ? 'html' : 'md']);
  if (!validation.ok) {
    return params.fail(
      validation.error || 'Document content is too thin.',
      'Rebuild the report using gathered evidence. Include real body content, bullets, sources, and limitations instead of only section titles.'
    );
  }
  const { theme } = params.args;
  const content = format === 'html'
    ? renderReportHtml(params.args, { theme: theme === 'light' || theme === 'dark' ? theme : undefined, accent: resolveAccent(params.args.accent) })
    : renderReportMarkdown(params.args);

  if (params.isWorkspace(params.ctx) && params.ctx.workspaceRoot) {
    await params.writeWorkspaceFile(params.ctx.workspaceRoot, path, content);
    params.ctx.files[path] = content;
  } else {
    params.ctx.files[path] = content;
    if (format === 'html') params.ctx.files['__preview__.html'] = content;
  }
  const sections = Array.isArray(params.args.sections) ? params.args.sections.length : 1;
  return params.ok({ title, format, path, sections }, { createdFiles: [path] });
}

export async function handleCreateWorkProduct(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  isElectron: () => boolean;
  isWorkspace: (ctx: ToolContext) => boolean;
  uid: (prefix: string) => string;
  viewerPathFor: (path: string) => string;
  createWorkProductArtifactFiles: (args: Record<string, unknown>) => Promise<{ files: GeneratedArtifactFile[]; html?: string; warnings: string[] }>;
  validateGeneratedDocumentArgs: (args: Record<string, unknown>, formats: string[]) => { ok: boolean; error?: string };
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
  /** Workspace mode: writes one generated file into the project folder. */
  saveGeneratedFile: (ctx: ToolContext, path: string, content: string) => Promise<string>;
}): Promise<ToolResult> {
  if (!params.isElectron()) return params.fail('Professional work product generation requires the desktop app.');

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
      if (params.isWorkspace(params.ctx)) await params.saveGeneratedFile(params.ctx, file.path, file.dataUrl);
      params.ctx.files[file.path] = file.dataUrl;
      if (file.spec) params.ctx.files[specPathFor(file.path)] = JSON.stringify(file.spec);
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

function buildChartPayload(args: Record<string, unknown>): ChartArtifactPayload | string {
  const chartType = resolveChartType(args.chart_type || 'bar');
  if (!chartType) return `Unknown chart type. Use ${CHART_TYPES.join(', ')}.`;
  const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
  const datasets = (Array.isArray(args.datasets) ? args.datasets as Dataset[] : []).map((ds, i) => ({
    label: String(ds.label || `Series ${i + 1}`),
    data: Array.isArray(ds.data) ? ds.data.map(Number) : [],
    ...(ds.sizes ? { sizes: ds.sizes.map(Number) } : {})
  }));
  const options: Partial<ChartData> = {};
  if (typeof args.subtitle === 'string') options.subtitle = args.subtitle;
  if (['number', 'percent', 'currency'].includes(String(args.valueFormat))) options.valueFormat = args.valueFormat as ChartData['valueFormat'];
  if (typeof args.currency === 'string') options.currency = args.currency;
  if (typeof args.max === 'number') options.max = args.max;
  if (Array.isArray(args.annotations)) options.annotations = args.annotations as ChartData['annotations'];
  const invalid = validateChartData(chartType, { labels, datasets, ...options });
  return invalid || { kind: 'chart', title: String(args.title || 'Chart'), chartType, labels, datasets, ...options };
}

export async function handleCreateChart(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const payload = buildChartPayload(params.args);
  if (typeof payload === 'string') return params.fail(payload);
  const path = artifactDataPath(params.normPath(params.args.path), 'chart.json');
  writeInlineArtifact(params.ctx, path, { ...payload });
  return params.ok({ title: payload.title, chartType: payload.chartType, labels: payload.labels, datasets: payload.datasets.length, path }, { createdFiles: [path] });
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

  // Markers alone are enough: center on them and zoom to fit.
  const plotted = markers.filter((marker) => Number.isFinite(Number(marker.lat)) && Number.isFinite(Number(marker.lng)));
  let fittedZoom: number | null = null;
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && plotted.length) {
    const lats = plotted.map((marker) => Number(marker.lat));
    const lngs = plotted.map((marker) => Number(marker.lng));
    lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    lng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const span = Math.max(Math.max(...lngs) - Math.min(...lngs), (Math.max(...lats) - Math.min(...lats)) * 2, 0.05);
    fittedZoom = Math.max(2, Math.min(12, Math.floor(Math.log2(360 / span))));
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return params.fail(
      'A map needs a place name, latitude and longitude, or markers with lat/lng.',
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
    zoom: Number.isFinite(zoom) ? zoom : fittedZoom ?? 8,
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

  const charts: ChartArtifactPayload[] = [];
  for (const args of Array.isArray(params.args.charts) ? params.args.charts as Record<string, unknown>[] : []) {
    const chart = buildChartPayload(args);
    if (typeof chart === 'string') return params.fail(`Dashboard chart: ${chart}`);
    charts.push(chart);
  }

  const payload = {
    kind: 'dashboard',
    title,
    subtitle,
    metrics,
    sections,
    ...(charts.length ? { charts } : {})
  };

  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ title, path, metricCount: metrics.length }, { createdFiles: [path] });
}

function sanitizeHtmlCard(html: string): string {
  let out = String(html || '');
  // Remove scripts and remote/active hooks — self-contained snippets only.
  // Runs in any JS env (no DOM), so regex pre-strip; the render path
  // confines cards to a fully sandboxed iframe as second layer.
  out = out.replace(/<script[\s\S]*?(<\/script>|$)/gi, '');
  // Event handlers: double-quoted, single-quoted and unquoted forms.
  out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  // javascript:/data:text/html URLs in any quote style.
  out = out.replace(/\s(href|src|xlink:href)\s*=\s*(['"]?)\s*javascript:[^'"]*\2/gi, '');
  out = out.replace(/\s(href|src|xlink:href)\s*=\s*(['"]?)\s*data:text\/html[^'"]*\2/gi, '');
  out = out.replace(/\s(href|src)\s*=\s*(['"])\s*https?:\/\/[^'"]*\2/gi, '');
  out = out.replace(/<iframe[\s\S]*?(<\/iframe>|$)/gi, '');
  out = out.replace(/<object[\s\S]*?(<\/object>|$)/gi, '');
  out = out.replace(/<embed[\s\S]*?>/gi, '');
  // Document-level and form tags have no place in a card: drop them outright.
  out = out.replace(/<(meta|base|link)\b[^>]*>/gi, '');
  out = out.replace(/<\/?(form|math)\b[^>]*>/gi, '');
  // SVG may embed arbitrary HTML through foreignObject; the rest of SVG is fine.
  out = out.replace(/<foreignObject[\s\S]*?(<\/foreignObject>|$)/gi, '');
  // Styles stay (a card without its CSS is just text), minus anything that
  // reaches the network or evaluates code.
  out = out.replace(/@import[^;]*;?/gi, '');
  out = out.replace(/url\(\s*(['"]?)\s*(?:https?:|\/\/)[^)]*\)/gi, 'none');
  out = out.replace(/expression\s*\(/gi, '(');
  return out.trim();
}

/**
 * A widget runs in a sealed, offline frame (see widget-kit), so its own
 * scripts and inline handlers are allowed. Inline <script> blocks move into
 * `script`; only what would escape the frame or load remote content goes.
 */
export function splitWidgetSource(html: string, script = ''): { html: string; script: string } {
  const scripts: string[] = [];
  let out = String(html || '').replace(/<script\b[^>]*>([\s\S]*?)(<\/script>|$)/gi, (_m, body: string) => {
    if (body.trim()) scripts.push(body);
    return '';
  });
  out = out.replace(/<(iframe|object)\b[\s\S]*?(<\/\1>|$)/gi, '');
  out = out.replace(/<(embed|meta|base|link)\b[^>]*>/gi, '');
  out = out.replace(/@import[^;]*;?/gi, '');
  out = out.replace(/\s(href|src)\s*=\s*(['"])\s*https?:\/\/[^'"]*\2/gi, '');
  out = out.replace(/url\(\s*(['"]?)\s*(?:https?:|\/\/)[^)]*\)/gi, 'none');
  return { html: out.trim(), script: [String(script || ''), ...scripts].filter((part) => part.trim()).join('\n;\n') };
}

export function handleCreateWidget(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): ToolResult {
  const title = String(params.args.title || '').trim() || 'Widget';
  const { html, script } = splitWidgetSource(String(params.args.html || ''), String(params.args.script || ''));
  if (html.length < 8) return params.fail('create_widget requires html markup (the visible part of the widget).');
  if (html.length + script.length > 120_000) return params.fail('Widget is too large. Keep it compact: one focused view.');

  const path = artifactDataPath(params.normPath(params.args.path), 'widget.json');
  const payload = { kind: 'html_card', title, html, ...(script ? { script } : {}) };
  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ title, path, interactive: !!script }, { createdFiles: [path] });
}

export function handleCreateLesson(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): ToolResult {
  const title = String(params.args.title || '').trim();
  if (!title) return params.fail('A lesson needs a title: the concept it teaches.');
  const blocks = Array.isArray(params.args.blocks) ? params.args.blocks : [];
  if (!blocks.length) return params.fail('A lesson needs blocks: a question first, a summary last.');

  const mode = String(params.args.mode || 'lesson') === 'practice' ? 'practice' : 'lesson';
  const subtitle = String(params.args.subtitle || '').trim();
  const subject = String(params.args.subject || '').trim();
  const payload = {
    kind: 'lesson',
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(subject ? { subject } : {}),
    mode,
    blocks
  };
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized.length > 220_000) {
    return params.fail('Lesson is too large. One concept, 4–12 blocks, short prompts.');
  }

  const path = artifactDataPath(params.normPath(params.args.path), mode === 'practice' ? 'practice.json' : 'lesson.json');
  writeInlineArtifact(params.ctx, path, payload);
  return params.ok({ title, path, mode, blocks: blocks.length }, { createdFiles: [path] });
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
