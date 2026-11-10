<svelte:options runes={true} />

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { BarChart3, Download, Table2 } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import { parseChartData, type ChartData } from '$lib/utils/chart-data';
  import { CHART_NAMES, resolveChartType, type ChartType } from '$lib/utils/chart-types';
  import { validateChartData } from '$lib/utils/chart-math';
  import { drawCartesian } from './charts/chart-cartesian';
  import { drawSpecial } from './charts/chart-special';
  import type { ChartScene, TipRow } from './charts/chart-scene';
  import { visualizationFonts } from '$lib/ui/components/visualization-fonts';

  interface Props {
    type: ChartType;
    title?: string;
    xlabel?: string;
    ylabel?: string;
    raw: string;
    variant?: 'block' | 'artifact';
  }
  let { type, title, xlabel, ylabel, raw, variant = 'block' }: Props = $props();
  let host = $state<HTMLDivElement>();
  let svgEl = $state<SVGSVGElement>();
  let typeProbe = $state<HTMLSpanElement>();
  let width = $state(600);
  let appearance = $state(0);
  let hidden = $state<number[]>([]);
  let tableOpen = $state(false);
  let focusedPoint = $state(-1);
  let tooltip = $state<{ x: number; y: number; title: string; rows: TipRow[] } | null>(null);
  const data = $derived(parseChartData(raw));
  const kind = $derived(resolveChartType(type));
  const error = $derived(!kind ? 'Unsupported chart type.' : !data ? 'Invalid chart data.' : validateChartData(kind, data));
  const categories = $derived(['pie', 'donut', 'treemap', 'funnel'].includes(kind ?? ''));
  const legend = $derived(data ? (categories ? data.labels.map((name, index) => ({ name, index })) : (kind === 'histogram' || kind === 'gauge' ? data.datasets.slice(0, 1) : data.datasets).map((ds, index) => ({ name: ds.label, index }))) : []);
  const height = $derived(kind === 'heatmap' ? Math.max(160, (data?.datasets.length ?? 1) * 26 + 54)
    : kind === 'horizontal_bar' || kind === 'funnel' ? Math.max(260, Math.min(800, (data?.labels.length ?? 1) * 32 + 48)) : 280);

  function token(name: string, fallback: string) {
    return svgEl ? getComputedStyle(svgEl).getPropertyValue(name).trim() || fallback : fallback;
  }
  function ink(index: number) { void appearance; return token(`--chart-${index % 6 + 1}`, '#2563eb'); }
  function format(value: number, compact = false): string {
    try {
      if (data?.valueFormat === 'percent') return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
      return new Intl.NumberFormat(undefined, {
        ...(data?.valueFormat === 'currency' ? { style: 'currency', currency: data.currency || 'USD' } : {}),
        notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 2
      }).format(value);
    } catch { return value.toLocaleString(); }
  }

  $effect(() => { void raw; void type; hidden = []; tooltip = null; focusedPoint = -1; });
  onMount(() => {
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(([entry]) => { width = Math.max(220, Math.round(entry.contentRect.width)); });
    if (host) resize?.observe(host);
    const theme = new MutationObserver(() => { appearance++; });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => { resize?.disconnect(); theme.disconnect(); };
  });

  $effect(() => {
    appearance;
    if (!svgEl) return;
    svgEl.replaceChildren();
    if (!data || !kind || error) return;
    const active = legend.filter((entry) => !hidden.includes(entry.index));
    const filtered: ChartData = categories
      ? { ...data, labels: active.map((entry) => data.labels[entry.index]), datasets: [{ ...data.datasets[0], data: active.map((entry) => data.datasets[0].data[entry.index]) }] }
      : { ...data, datasets: active.map((entry) => data.datasets[entry.index]) };
    const scene: ChartScene = {
      svg: svgEl, data: filtered, type: kind, width, height,
      colors: active.map((entry) => ink(entry.index)),
      surface: token('--background', '#fff'), foreground: token('--foreground', '#111'),
      muted: token('--muted-foreground', '#666'), grid: token('--border-subtle', '#eee'),
      font: getComputedStyle(svgEl).fontFamily,
      fontSize: typeProbe ? Number.parseFloat(getComputedStyle(typeProbe).fontSize) || 12 : 12,
      format: (v) => format(v, true),
      tip: (event, title, rows) => {
        const rect = host?.getBoundingClientRect();
        tooltip = { x: Math.max(0, Math.min(width - Math.min(240, width), event.clientX - (rect?.left ?? 0) + 12)), y: Math.max(0, Math.min(height - 64, event.clientY - (rect?.top ?? 0) - 48)), title, rows };
      },
      hide: () => { tooltip = null; }
    };
    if (['pie', 'donut', 'heatmap', 'radar', 'funnel', 'treemap', 'gauge'].includes(kind)) drawSpecial(scene);
    else drawCartesian(scene);
  });

  function toggle(index: number) {
    if (!hidden.includes(index) && !canHide(index)) return;
    hidden = hidden.includes(index) ? hidden.filter((i) => i !== index) : [...hidden, index];
    tooltip = null;
  }
  function canHide(index: number) {
    const remaining = legend.filter((entry) => entry.index !== index && !hidden.includes(entry.index));
    return remaining.length > 0 && (!categories || remaining.some((entry) => (data?.datasets[0].data[entry.index] ?? 0) > 0));
  }
  function inspect(event: KeyboardEvent) {
    if (!data || error) return;
    if (event.key === 'Escape') { tooltip = null; focusedPoint = -1; return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    focusedPoint = event.key === 'Home' ? 0 : event.key === 'End' ? data.labels.length - 1
      : (focusedPoint + (event.key === 'ArrowLeft' ? -1 : 1) + data.labels.length) % data.labels.length;
    tooltip = { x: Math.max(0, width / 2 - 100), y: 8, title: data.labels[focusedPoint], rows: data.datasets.map((ds, i) => ({ label: ds.label, value: ds.data[focusedPoint], color: ink(i) })) };
  }

  function save(blob: Blob, extension: string) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${(title || 'chart').replace(/[^\p{L}\p{N}-]+/gu, '-').toLowerCase()}.${extension}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function serializedSvg() {
    if (!svgEl) return '';
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const fontStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    fontStyle.textContent = visualizationFonts(getComputedStyle(svgEl).fontFamily);
    clone.prepend(fontStyle);
    clone.style.color = token('--foreground', '#111');
    return new XMLSerializer().serializeToString(clone);
  }
  function downloadSvg() { save(new Blob([serializedSvg()], { type: 'image/svg+xml' }), 'svg'); }
  function downloadPng() {
    const url = URL.createObjectURL(new Blob([serializedSvg()], { type: 'image/svg+xml' }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = width * 2; canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.scale(2, 2); ctx.fillStyle = token('--background', '#fff'); ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
      canvas.toBlob((blob) => { if (blob) save(blob, 'png'); }); URL.revokeObjectURL(url);
    };
    image.onerror = () => URL.revokeObjectURL(url); image.src = url;
  }
</script>

<section class="viz-surface artifact-chart" aria-label={title || (kind ? CHART_NAMES[kind] : 'Chart')} data-chart-type={type} data-variant={variant}>
  <header class="viz-header">
    <div class="chart-heading">
      {#if variant === 'artifact'}<span class="artifact-kind-tile size-8 rounded-lg" style:--artifact-accent="var(--accent-violet)" aria-hidden="true"><BarChart3 class="size-4" /></span>{/if}
      <div class="min-w-0">
        {#if title}<h3 class="viz-title">{title}</h3>{/if}
        {#if data?.subtitle}<p class="viz-subtitle">{data.subtitle}</p>{/if}
      </div>
    </div>
    <div class="chart-actions">
      <Button variant="ghost" size="xs" aria-label="Show chart data" aria-pressed={tableOpen} onclick={() => (tableOpen = !tableOpen)}><Table2 /><span>Data</span></Button>
      <Button variant="ghost" size="xs" aria-label="Download chart as SVG" disabled={!!error} onclick={downloadSvg}><Download /> SVG</Button>
      <Button variant="ghost" size="xs" aria-label="Download chart as PNG" disabled={!!error} onclick={downloadPng}>PNG</Button>
    </div>
  </header>
  {#if error}
    <p class="viz-error" role="status">{error}</p>
  {:else}
    {#if legend.length > 1 && kind !== 'heatmap' && kind !== 'boxplot'}
      <div class="chart-legend" aria-label="Chart legend">
        {#each legend as entry (entry.index)}
          <Button variant="plain" class={uiClass('', "ui-local-647a5dec", {"is-hidden": hidden.includes(entry.index)})}  aria-pressed={!hidden.includes(entry.index)} disabled={!hidden.includes(entry.index) && !canHide(entry.index)} onclick={() => toggle(entry.index)}>
            <span class="legend-swatch" style:background={ink(entry.index)}></span>{entry.name}
          </Button>
        {/each}
      </div>
    {/if}
    <div class="chart-container" bind:this={host} role="slider" tabindex="0"
      aria-label="Inspect chart values. Use left and right arrows."
      aria-valuemin="0" aria-valuemax={Math.max(0, (data?.labels.length ?? 1) - 1)} aria-valuenow={Math.max(0, focusedPoint)}
      aria-valuetext={data ? `${data.labels[Math.max(0, focusedPoint)]}: ${data.datasets.map((ds) => `${ds.label} ${format(ds.data[Math.max(0, focusedPoint)])}`).join(', ')}` : undefined}
      onkeydown={inspect}>
      <span class="type-probe" bind:this={typeProbe} aria-hidden="true"></span>
      <svg bind:this={svgEl} {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label={title || (kind ? CHART_NAMES[kind] : 'Chart')}></svg>
      {#if tooltip}
        <div class="chart-tooltip ui-float" style:left={`${tooltip.x}px`} style:top={`${tooltip.y}px`} role="status">
          <strong>{tooltip.title}</strong>
          {#each tooltip.rows as row, index (index)}
            <div><span class="legend-swatch" style:background={row.color}></span><span class="tip-label">{row.label}</span><span class="tip-value">{format(row.value)}</span></div>
          {/each}
        </div>
      {/if}
    </div>
    {#if xlabel || ylabel}<p class="axis-caption">{[xlabel, ylabel].filter(Boolean).join(' · ')}</p>{/if}
    {#if tableOpen && data}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrolling data region needs keyboard focus so users can scroll the full table.) -->
      <div class="chart-table" tabindex="0" role="region" aria-label="Chart data">
        <table><thead><tr><th scope="col">{xlabel || 'Label'}</th>{#each data.datasets as ds, index (index)}<th scope="col">{ds.label}</th>{/each}</tr></thead>
          <tbody>{#each data.labels as name, index (index)}<tr><th scope="row">{name}</th>{#each data.datasets as ds, series (series)}<td>{format(ds.data[index])}</td>{/each}</tr>{/each}</tbody>
        </table>
      </div>
    {/if}
  {/if}
</section>

<style>
  .chart-heading { display:flex; flex:1; min-width:0; align-items:center; gap:0.625rem; }
  .chart-actions { display: flex; flex-shrink: 0; align-items: center; gap: 0.125rem; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 0.25rem 0.875rem; margin: 0 0 0.75rem; }
  .chart-legend :global(button.ui-local-647a5dec) { display: inline-flex; align-items: center; gap: 0.375rem; min-height: 1.5rem; color: var(--text-secondary); font-size: var(--text-xs); }
  .chart-legend :global(button.is-hidden.ui-local-647a5dec) { opacity: 0.4; text-decoration: line-through; }
  .chart-legend :global(button:focus-visible.ui-local-647a5dec), .chart-container:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; border-radius: var(--radius-sm); }
  .legend-swatch { display: inline-block; width: 0.5rem; height: 0.5rem; flex-shrink: 0; border-radius: 2px; }
  .chart-container { position: relative; min-width: 0; width: 100%; font-family: var(--font-sans); }
  svg { display: block; max-width: 100%; height: auto; overflow: visible; font-family: var(--font-sans); }
  .type-probe { position: absolute; visibility: hidden; font-size: var(--text-xs); }
  .chart-tooltip { position: absolute; pointer-events: none; z-index: 20; width: max-content; min-width: 10rem; max-width: min(15rem, 100%); padding: 0.625rem 0.75rem; color: var(--foreground); font-size: var(--text-xs); }
  .chart-tooltip strong { display: block; font-weight: 500; margin-bottom: 0.375rem; overflow-wrap: anywhere; }
  .chart-tooltip > div { display: flex; align-items: baseline; gap: 0.375rem; padding: 0.125rem 0; }
  .tip-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
  .tip-value { font-variant-numeric: tabular-nums; font-weight: 500; }
  .axis-caption { margin: 0.25rem 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  .chart-table { overflow: auto; max-height: 20rem; margin-top: 0.75rem; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid var(--border-subtle); padding: 0.5rem 0.625rem; text-align: right; white-space: nowrap; }
  th { font-weight: 500; color: var(--text-secondary); } th:first-child { text-align: left; }
  @container (max-width: 30rem) { .chart-actions :global(:is(button, :global(button.ui-local-647a5dec))) { padding-inline: 0.375rem; } }
</style>
