import type { AgentArtifact } from '$lib/types/chat';
import type { GeneratedArtifactFile } from '$lib/services/generated-documents';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';

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
  buildArtifact: (ctx: ToolContext) => AgentArtifact | null;
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

    params.ctx.onArtifact(params.buildArtifact(params.ctx));
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
  const path = params.normPath(params.args.path) || 'chart.html';

  if (labels.length < 1) return params.fail('Chart requires at least one label.');
  if (datasets.length < 1) return params.fail('Chart requires at least one dataset.');
  if (!['bar', 'line', 'pie', 'donut'].includes(chartType)) {
    return params.fail(`Unknown chart type "${chartType}". Use bar, line, pie, or donut.`);
  }

  const allColors = ['#818af0', '#717CE2', '#626edc', '#a78bfa', '#7c3aed', '#6366f1', '#4f46e5', '#8b5cf6'];
  const sanitizedDatasets = datasets.map((ds, i) => ({ label: ds.label || `Series ${i + 1}`, data: Array.isArray(ds.data) ? ds.data : [] }));

  const datasetsJson = JSON.stringify(sanitizedDatasets);
  const labelsJson = JSON.stringify(labels);
  const colorsJson = JSON.stringify(allColors);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #0d0d0d;
  color: #e5e5e5;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-height: 100vh; padding: 2rem;
}
.chart-container {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 12px;
  padding: 2rem;
  max-width: 700px;
  width: 100%;
}
.chart-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; color: #f5f5f5; text-align: center; }
.chart-type { font-size: 0.75rem; color: #888; text-align: center; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.1em; }
svg { display: block; margin: 0 auto; }
.axis text { fill: #888; font-size: 11px; font-family: inherit; }
.axis path, .axis line { stroke: #333; }
.grid line { stroke: #2a2a2a; stroke-dasharray: 3,3; }
.tooltip {
  position: absolute; pointer-events: none;
  background: #2a2a2a; color: #f5f5f5;
  padding: 6px 10px; border-radius: 6px; font-size: 12px;
  border: 1px solid #444; opacity: 0; transition: opacity 0.15s;
  white-space: nowrap; z-index: 10;
}
.legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 1rem; margin-top: 1rem; }
.legend-item { display: flex; align-items: center; gap: 0.4rem; font-size: 11px; color: #aaa; }
.legend-swatch { width: 10px; height: 10px; border-radius: 2px; }
.pie-label { fill: #aaa; font-size: 11px; }
</style>
</head>
<body>
<div class="chart-container">
  <div class="chart-type">${escapeHtml(chartType)} chart</div>
  <div class="chart-title">${escapeHtml(title)}</div>
  <div id="chart"></div>
  <div class="legend" id="legend"></div>
</div>
<div class="tooltip" id="tooltip"></div>

<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script>
(function() {
  const labels = ${labelsJson};
  const datasets = ${datasetsJson};
  const colors = ${colorsJson};
  const chartType = "${chartType}";

  const container = document.getElementById('chart');
  const legendEl = document.getElementById('legend');
  const tooltip = document.getElementById('tooltip');

  const W = 640, H = 360;
  const margin = { top: 20, right: 30, bottom: 50, left: 50 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .attr('viewBox', [0, 0, W, H])
    .append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  if (chartType === 'pie' || chartType === 'donut') {
    const values = datasets[0].data.map((d, i) => ({ label: labels[i] || '?', value: d }));
    const total = d3.sum(values, d => d.value);
    const radius = Math.min(innerW, innerH) / 2;
    const innerRadius = chartType === 'donut' ? radius * 0.6 : 0;

    const pie = d3.pie().value(d => d.value);
    const arc = d3.arc().innerRadius(innerRadius).outerRadius(radius);
    const arcs = pie(values);

    const g = svg.append('g').attr('transform', 'translate(' + (innerW/2) + ',' + (innerH/2) + ')');

    g.selectAll('path').data(arcs).join('path')
      .attr('d', arc).attr('fill', (d, i) => colors[i % colors.length])
      .attr('stroke', '#0d0d0d').attr('stroke-width', 2)
      .on('mousemove', function(event, d) {
        tooltip.style('opacity', 1).html(d.data.label + ': ' + d.data.value + ' (' + ((d.data.value/total)*100).toFixed(1) + '%)')
          .style('left', (event.pageX + 10) + 'px').style('top', (event.pageY - 25) + 'px');
      }).on('mouseout', () => tooltip.style('opacity', 0));

    g.selectAll('text').data(arcs).join('text')
      .attr('transform', d => 'translate(' + arc.centroid(d) + ')')
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .text(d => d.data.label).attr('class', 'pie-label');

    legendEl.innerHTML = '';
    values.forEach((v, i) => {
      const item = document.createElement('div'); item.className = 'legend-item';
      item.innerHTML = '<div class="legend-swatch" style="background:' + colors[i % colors.length] + '"></div>' + v.label + ': ' + v.value;
      legendEl.appendChild(item);
    });
  } else {
    const x = chartType === 'bar'
      ? d3.scaleBand().domain(labels).range([0, innerW]).padding(0.2)
      : d3.scalePoint().domain(labels).range([0, innerW]).padding(0.5);

    const allValues = datasets.flatMap(d => d.data);
    const yMax = d3.max(allValues) || 1;
    const y = d3.scaleLinear().domain([0, yMax * 1.1]).range([innerH, 0]);

    svg.append('g').call(d3.axisLeft(y).ticks(6))
      .attr('class', 'axis')
      .selectAll('text').attr('fill', '#888');

    svg.append('g').call(d3.axisBottom(x))
      .attr('class', 'axis').attr('transform', 'translate(0,' + innerH + ')')
      .selectAll('text').attr('fill', '#888')
      .attr('text-anchor', chartType === 'bar' ? 'middle' : 'end')
      .attr('transform', chartType === 'bar' ? null : 'rotate(-30)');

    svg.append('g').attr('class', 'grid')
      .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(''));

    if (chartType === 'bar') {
      const groupWidth = x.bandwidth();
      const barWidth = groupWidth / datasets.length;

      datasets.forEach((ds, di) => {
        svg.selectAll('.bar-' + di).data(ds.data).join('rect')
          .attr('class', 'bar-' + di)
          .attr('x', (d, i) => (x(labels[i]) || 0) + di * barWidth)
          .attr('y', d => y(d)).attr('width', barWidth - 1).attr('height', d => innerH - y(d))
          .attr('fill', colors[di % colors.length]).attr('rx', 3)
          .on('mousemove', function(event, d) {
            const idx = datasets[di].data.indexOf(d);
            tooltip.style('opacity', 1).html(labels[idx] + '<br>' + ds.label + ': ' + d)
              .style('left', (event.pageX + 10) + 'px').style('top', (event.pageY - 25) + 'px');
          }).on('mouseout', () => tooltip.style('opacity', 0));
      });
    } else {
      const lineFn = d3.line().x((d, i) => x(labels[i]) || 0).y(d => y(d)).curve(d3.curveMonotoneX);

      datasets.forEach((ds, di) => {
        svg.append('path').datum(ds.data).attr('fill', 'none')
          .attr('stroke', colors[di % colors.length]).attr('stroke-width', 2.5)
          .attr('d', lineFn);

        svg.selectAll('.dot-' + di).data(ds.data).join('circle')
          .attr('class', 'dot-' + di)
          .attr('cx', (d, i) => x(labels[i]) || 0).attr('cy', d => y(d))
          .attr('r', 4).attr('fill', colors[di % colors.length])
          .attr('stroke', '#0d0d0d').attr('stroke-width', 1)
          .on('mousemove', function(event, d) {
            const idx = ds.data.indexOf(d);
            tooltip.style('opacity', 1).html(labels[idx] + '<br>' + ds.label + ': ' + d)
              .style('left', (event.pageX + 10) + 'px').style('top', (event.pageY - 25) + 'px');
          }).on('mouseout', () => tooltip.style('opacity', 0));
      });
    }

    legendEl.innerHTML = '';
    datasets.forEach((ds, i) => {
      const item = document.createElement('div'); item.className = 'legend-item';
      item.innerHTML = '<div class="legend-swatch" style="background:' + colors[i % colors.length] + '"></div>' + ds.label;
      legendEl.appendChild(item);
    });
  }
})();
</script>
</body>
</html>`;

  params.ctx.files[path] = html;
  params.ctx.files['__preview__.html'] = html;

  return params.ok({ title, chartType, labels, datasets: sanitizedDatasets.length, path }, { createdFiles: [path] });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  const path = params.normPath(params.args.path) || 'diagram.html';

  if (!mermaidSource.trim()) return params.fail('Diagram requires mermaid source code.');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #0d0d0d; color: #e5e5e5;
  min-height: 100vh; padding: 2rem;
  display: flex; flex-direction: column; align-items: center;
}
.container { max-width: 900px; width: 100%; }
.title { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; text-align: center; }
.viewer {
  background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
  padding: 2rem; overflow-x: auto;
}
.mermaid svg { max-width: 100%; height: auto; }
.mermaid .label { color: #e5e5e5 !important; }
.legend { margin-top: 0.75rem; font-size: 0.75rem; color: #888; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <div class="title">${escapeHtml(title)}</div>
  <div class="viewer">
    <pre class="mermaid" style="background:transparent;display:flex;justify-content:center">${escapeHtml(mermaidSource)}</pre>
  </div>
  <div class="legend">Diagram rendered with Mermaid.js — zoom/pan to explore</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });
</script>
</body>
</html>`;

  params.ctx.files[path] = html;
  params.ctx.files['__preview__.html'] = html;
  return params.ok({ title, path, diagramType: params.args.diagram_type }, { createdFiles: [path] });
}

export async function handleCreateMap(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  normPath: (value: unknown) => string;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const title = String(params.args.title || 'Map');
  const lat = Number(params.args.latitude ?? 51.505);
  const lng = Number(params.args.longitude ?? -0.09);
  const zoom = Number(params.args.zoom ?? 13);
  const markers = Array.isArray(params.args.markers) ? params.args.markers as Array<{ lat?: number; lng?: number; label?: string; popup?: string }> : [];
  const polylines = Array.isArray(params.args.polylines) ? params.args.polylines : [];
  const path = params.normPath(params.args.path) || 'map.html';

  const markersJson = JSON.stringify(markers);
  const polylinesJson = JSON.stringify(polylines);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #0d0d0d; color: #e5e5e5;
  min-height: 100vh; padding: 1.5rem;
  display: flex; flex-direction: column; align-items: center;
}
.container { max-width: 900px; width: 100%; }
.title { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; text-align: center; }
#map {
  width: 100%; height: 480px; border-radius: 12px;
  border: 1px solid #333; background: #1a1a1a;
}
.leaflet-control-zoom a { background: #2a2a2a; color: #e5e5e5; border-color: #444; }
.leaflet-control-attribution { background: rgba(0,0,0,0.6); color: #888; font-size: 10px !important; }
.leaflet-control-attribution a { color: #a78bfa; }
.legend { margin-top: 0.75rem; font-size: 0.75rem; color: #888; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <div class="title">${escapeHtml(title)}</div>
  <div id="map"></div>
  <div class="legend">OpenStreetMap tiles — scroll to zoom, drag to pan. ${markers.length} marker${markers.length !== 1 ? 's' : ''}</div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function() {
  const map = L.map('map').setView([${lat}, ${lng}], ${zoom});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);

  const markers = ${markersJson};
  markers.forEach(function(m) {
    if (m.lat == null || m.lng == null) return;
    const label = m.label || m.popup || '';
    L.marker([m.lat, m.lng]).addTo(map).bindPopup(label || 'Marker');
  });

  const polylines = ${polylinesJson};
  polylines.forEach(function(pl) {
    const coords = Array.isArray(pl.coords) ? pl.coords : (Array.isArray(pl) ? pl : []);
    if (coords.length < 2) return;
    const latlngs = coords.map(function(c) { return [c.lat, c.lng]; }).filter(function(c) { return c[0] != null && c[1] != null; });
    if (latlngs.length < 2) return;
    L.polyline(latlngs, { color: pl.color || '#818af0', weight: pl.weight || 3 })
      .addTo(map)
      .bindPopup(pl.label || '');
  });
})();
</script>
</body>
</html>`;

  params.ctx.files[path] = html;
  params.ctx.files['__preview__.html'] = html;
  return params.ok({ title, path, markerCount: markers.length }, { createdFiles: [path] });
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
  const path = params.normPath(params.args.path) || 'dashboard.html';

  if (metrics.length < 1) return params.fail('Dashboard requires at least one metric.');

  const metricCards = metrics.map((m, i) => {
    const label = escapeHtml(String(m.label || ''));
    const value = escapeHtml(String(m.value ?? '-'));
    const trend = m.trend ? escapeHtml(String(m.trend)) : '';
    const unit = m.unit ? escapeHtml(String(m.unit)) : '';
    const hasPositive = trend.startsWith('+') || trend.startsWith('▲');
    const hasNegative = trend.startsWith('-') || trend.startsWith('▼') || trend.includes('down');
    let trendClass = '';
    if (hasPositive) trendClass = 'up';
    else if (hasNegative) trendClass = 'down';
    const color = m.color || '';
    return { label, value, trend, unit, trendClass, color, index: i };
  }).join('');

  const sectionBlocks = sections.map((s) => {
    const heading = s.heading ? `<h3>${escapeHtml(String(s.heading))}</h3>` : '';
    const content = s.content ? `<p>${escapeHtml(String(s.content))}</p>` : '';
    return `<div class="section">${heading}${content}</div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #0d0d0d; color: #e5e5e5;
  min-height: 100vh; padding: 2rem;
  display: flex; flex-direction: column; align-items: center;
}
.container { max-width: 900px; width: 100%; }
.header { text-align: center; margin-bottom: 2rem; }
.header h1 { font-size: 1.5rem; font-weight: 700; }
.header p { font-size: 0.875rem; color: #888; margin-top: 0.25rem; }
.metrics-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem; margin-bottom: 2rem;
}
.metric-card {
  background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
  padding: 1.25rem; text-align: center; transition: border-color 0.2s;
}
.metric-card:hover { border-color: #626edc; }
.metric-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.5rem; }
.metric-value { font-size: 1.75rem; font-weight: 700; }
.metric-unit { font-size: 0.75rem; color: #888; margin-left: 0.25rem; }
.metric-trend { font-size: 0.75rem; margin-top: 0.35rem; font-weight: 500; }
.metric-trend.up { color: #34d399; }
.metric-trend.down { color: #f87171; }
.section {
  background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
  padding: 1.25rem; margin-bottom: 1rem;
}
.section h3 { font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; }
.section p { font-size: 0.8125rem; color: #aaa; line-height: 1.6; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? '<p>' + escapeHtml(subtitle) + '</p>' : ''}
  </div>
  <div class="metrics-grid">
    ${metricCards || '<div class="metric-card"><div class="metric-label">No metrics</div></div>'}
  </div>
  ${sectionBlocks}
</div>
</body>
</html>`;

  params.ctx.files[path] = html;
  params.ctx.files['__preview__.html'] = html;
  return params.ok({ title, path, metricCount: metrics.length }, { createdFiles: [path] });
}
