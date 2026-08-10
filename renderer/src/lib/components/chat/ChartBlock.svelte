<svelte:options runes={true} />

<script lang="ts">
  import { select } from 'd3-selection';
  import { scaleBand, scaleLinear } from 'd3-scale';
  import { axisLeft, axisBottom } from 'd3-axis';
  import { line, curveMonotoneX, pie as d3pie, arc as d3arc } from 'd3-shape';
  import type { NumberValue } from 'd3-scale';
  import type { PieArcDatum } from 'd3-shape';
  import type { Selection } from 'd3-selection';
  import { Download } from 'lucide-svelte';
  import { parseChartData, type ChartData } from '$lib/utils/chart-data';

  interface Props {
    type: 'bar' | 'line' | 'pie' | 'donut';
    title?: string;
    xlabel?: string;
    ylabel?: string;
    raw: string; // raw JSON string from model
    variant?: 'block' | 'artifact';
  }

  let { type, title, xlabel, ylabel, raw, variant = 'block' }: Props = $props();

  let svgEl = $state<SVGSVGElement | undefined>(undefined);
  let tooltipEl = $state<HTMLDivElement | undefined>(undefined);
  let error = $state('');
  let parsed = $state<ChartData | null>(null);

  // Tooltip state
  let tooltip = $state<{ visible: boolean; x: number; y: number; label: string; value: string; series?: string }>({
    visible: false, x: 0, y: 0, label: '', value: '', series: ''
  });

  const W = 520;
  const H = 320;
  const margin = $derived({ top: title ? 36 : 16, right: 20, bottom: xlabel ? 48 : 36, left: ylabel ? 60 : 44 });
  const iw = $derived(W - margin.left - margin.right);
  const ih = $derived(H - margin.top - margin.bottom);

  $effect(() => {
    const nextParsed = parseChartData(raw);
    let nextError = '';

    if (!nextParsed) {
      nextError = 'Invalid chart data';
    } else if (!nextParsed.labels.length || !nextParsed.datasets.length) {
      nextError = 'Missing labels or datasets';
    } else if (nextParsed.datasets.some((dataset) => dataset.data.length !== nextParsed.labels.length)) {
      nextError = 'Chart labels and data length do not match';
    }

    parsed = nextParsed;
    error = nextError;
  });

  $effect(() => {
    if (!svgEl) return;
    if (!parsed || error) {
      select(svgEl).selectAll('*').remove();
      if (!parsed) {
        tooltip = { visible: false, x: 0, y: 0, label: '', value: '', series: '' };
      }
      return;
    }
    draw();
  });

  function draw() {
    if (!svgEl || !parsed) return;
    const svg = select(svgEl);
    svg.selectAll('*').remove();

    const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    if (type === 'bar' || type === 'line') {
      drawCartesian(svg, g, colors);
    } else if (type === 'pie' || type === 'donut') {
      drawPie(svg, g, colors);
    }
  }

  function drawCartesian(svg: Selection<SVGSVGElement, unknown, null, undefined>, g: Selection<SVGGElement, unknown, null, undefined>, colors: string[]) {
    if (!parsed) return;

    const allValues = parsed.datasets.flatMap(d => d.data);
    const yMin = Math.min(0, ...allValues);
    const yMax = Math.max(...allValues);

    const xScale = scaleBand()
      .domain(parsed.labels)
      .range([0, iw])
      .padding(type === 'bar' ? 0.2 : 0.1);

    const yScale = scaleLinear()
      .domain([yMin, yMax * 1.1])
      .range([ih, 0])
      .nice();

    // Grid lines
    g.append('g')
      .attr('class', 'grid')
      .call(axisLeft(yScale).tickSize(-iw).tickFormat('' as unknown as (d: NumberValue) => string))
      .call(gg => {
        gg.select('.domain').remove();
        gg.selectAll('.tick line')
          .attr('stroke', 'rgba(156,163,175,0.25)')
          .attr('stroke-dasharray', '3,3');
        gg.selectAll('.tick text').remove();
      });

    // Axes
    g.append('g')
      .attr('transform', `translate(0,${ih})`)
      .call(axisBottom(xScale).tickSizeOuter(0))
      .call(gg => {
        gg.select('.domain').attr('stroke', 'rgba(156,163,175,0.4)');
        gg.selectAll('.tick text')
          .attr('fill', 'currentColor')
          .attr('font-size', '11')
          .attr('opacity', '0.7');
      });

    g.append('g')
      .call(axisLeft(yScale).ticks(5).tickSizeOuter(0))
      .call(gg => {
        gg.select('.domain').attr('stroke', 'rgba(156,163,175,0.4)');
        gg.selectAll('.tick text')
          .attr('fill', 'currentColor')
          .attr('font-size', '11')
          .attr('opacity', '0.7');
      });

    const nSeries = parsed!.datasets.length;
    const bandWidth = xScale.bandwidth();
    const barW = bandWidth / nSeries;

    parsed!.datasets.forEach((ds, si) => {
      const color = colors[si % colors.length];
      if (type === 'bar') {
        g.selectAll(`.bar-${si}`)
          .data(ds.data)
          .join('rect')
          .attr('x', (_, i) => (xScale(parsed!.labels[i]) ?? 0) + si * barW)
          .attr('y', d => yScale(d))
          .attr('width', barW - 2)
          .attr('height', d => ih - yScale(d))
          .attr('fill', color)
          .attr('rx', 3)
          .attr('opacity', 0.85)
          .style('cursor', 'pointer')
          .on('mousemove', (event, d) => showTip(event, parsed!.labels[ds.data.indexOf(d)] ?? '', d, nSeries > 1 ? ds.label : undefined))
          .on('mouseleave', hideTip);
      } else {
        const lineGen = line<number>()
          .x((_, i) => (xScale(parsed!.labels[i]) ?? 0) + bandWidth / 2)
          .y(d => yScale(d))
          .curve(curveMonotoneX);

        g.append('path')
          .datum(ds.data)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 2.5)
          .attr('d', lineGen);

        g.selectAll(`.dot-${si}`)
          .data(ds.data)
          .join('circle')
          .attr('cx', (_, i) => (xScale(parsed!.labels[i]) ?? 0) + bandWidth / 2)
          .attr('cy', d => yScale(d))
          .attr('r', 4)
          .attr('fill', color)
          .attr('stroke', 'var(--surface)')
          .attr('stroke-width', 1.5)
          .style('cursor', 'pointer')
          .on('mousemove', (event, d) => showTip(event, parsed!.labels[ds.data.indexOf(d)] ?? '', d, nSeries > 1 ? ds.label : undefined))
          .on('mouseleave', hideTip);
      }
    });

    // Axis labels
    if (xlabel) {
      svg.append('text')
        .attr('x', margin.left + iw / 2)
        .attr('y', H - 6)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11')
        .attr('opacity', '0.6')
        .attr('fill', 'currentColor')
        .text(xlabel);
    }
    if (ylabel) {
      svg.append('text')
        .attr('transform', `rotate(-90)`)
        .attr('x', -(margin.top + ih / 2))
        .attr('y', 14)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11')
        .attr('opacity', '0.6')
        .attr('fill', 'currentColor')
        .text(ylabel);
    }

    // Legend (if multiple series)
    if (nSeries > 1) {
      const legend = svg.append('g').attr('transform', `translate(${margin.left}, 2)`);
      parsed!.datasets.forEach((ds, si) => {
        legend.append('rect')
          .attr('x', si * 110)
          .attr('y', 0)
          .attr('width', 10).attr('height', 10)
          .attr('fill', colors[si % colors.length])
          .attr('rx', 2);
        legend.append('text')
          .attr('x', si * 110 + 14)
          .attr('y', 9)
          .attr('font-size', '11')
          .attr('fill', 'currentColor')
          .attr('opacity', '0.7')
          .text(ds.label);
      });
    }
  }

  function drawPie(svg: Selection<SVGSVGElement, unknown, null, undefined>, g: Selection<SVGGElement, unknown, null, undefined>, colors: string[]) {
    if (!parsed) return;
    const radius = Math.min(iw, ih) / 2 - 10;
    const cx = iw / 2;
    const cy = ih / 2;
    const data = parsed.datasets[0].data;
    const labels = parsed.labels;

    const pieData = d3pie<number>().sort(null)(data);
    const arc = d3arc<PieArcDatum<number>>()
      .innerRadius(type === 'donut' ? radius * 0.55 : 0)
      .outerRadius(radius);
    const labelArc = d3arc<PieArcDatum<number>>()
      .innerRadius(radius * 0.75)
      .outerRadius(radius * 0.75);

    const pieG = g.append('g').attr('transform', `translate(${cx},${cy})`);

    pieData.forEach((slice, i) => {
      pieG.append('path')
        .attr('d', arc(slice) ?? '')
        .attr('fill', colors[i % colors.length])
        .attr('stroke', 'var(--surface)')
        .attr('stroke-width', 2)
        .attr('opacity', 0.88)
        .style('cursor', 'pointer')
        .on('mousemove', (event) => showTip(event, labels[i], data[i]))
        .on('mouseleave', hideTip);

      const [lx, ly] = labelArc.centroid(slice);
      const pct = ((slice.endAngle - slice.startAngle) / (2 * Math.PI) * 100).toFixed(0);
      if (parseFloat(pct) > 4) {
        pieG.append('text')
          .attr('x', lx).attr('y', ly)
          .attr('text-anchor', 'middle')
          .attr('font-size', '11')
          .attr('fill', '#fff')
          .attr('font-weight', '600')
          .text(`${pct}%`);
      }
    });

    // Legend on the right
    const legendG = g.append('g').attr('transform', `translate(${cx + radius + 12}, 0)`);
    labels.forEach((lbl, i) => {
      legendG.append('rect')
        .attr('x', 0).attr('y', i * 18)
        .attr('width', 10).attr('height', 10)
        .attr('fill', colors[i % colors.length]).attr('rx', 2);
      legendG.append('text')
        .attr('x', 14).attr('y', i * 18 + 9)
        .attr('font-size', '11')
        .attr('fill', 'currentColor')
        .attr('opacity', '0.7')
        .text(lbl);
    });
  }

  function showTip(event: MouseEvent, label: string, value: number | string, series?: string) {
    const container = (event.target as SVGElement).closest('.chart-container') as HTMLElement;
    const rect = container?.getBoundingClientRect();
    const x = event.clientX - (rect?.left ?? 0);
    const y = event.clientY - (rect?.top ?? 0);
    tooltip = { visible: true, x, y, label, value: typeof value === 'number' ? value.toLocaleString() : String(value), series };
  }

  function hideTip() {
    tooltip = { ...tooltip, visible: false };
  }

  function downloadSvg() {
    if (!svgEl) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgEl);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(title || 'chart').replace(/\s+/g, '-').toLowerCase()}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadPng() {
    if (!svgEl) return;
    const surfaceColor = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#ffffff';
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgEl);
    const canvas = document.createElement('canvas');
    canvas.width = W * 2;
    canvas.height = H * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);
    const img = new Image();
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.fillStyle = surfaceColor;
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${(title || 'chart').replace(/\s+/g, '-').toLowerCase()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
</script>

<!-- One shell for both variants. The inline variant used to carry
     `bg-[var(--surface-alt)]`, a token defined nowhere in the app, so inline
     charts rendered with no background at all while their artifact twin had
     one — and with a different radius. -->
<div class="artifact-chart">
  {#if variant === 'artifact' && title}
    <div class="artifact-chart-title">{title}</div>
  {:else if title}
    <div class="flex items-center justify-between border-b border-border/60 px-4 py-2">
      <span class="text-sm font-medium text-[var(--text)]">{title}</span>
      <div class="flex items-center gap-1">
        <button onclick={downloadSvg} class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors">
          <Download class="h-3.5 w-3.5" /> SVG
        </button>
        <button onclick={downloadPng} class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors">
          <Download class="h-3.5 w-3.5" /> PNG
        </button>
      </div>
    </div>
  {:else if variant !== 'artifact'}
    <div class="flex justify-end gap-1 px-3 pt-2">
      <button onclick={downloadSvg} class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors">
        <Download class="h-3.5 w-3.5" /> SVG
      </button>
      <button onclick={downloadPng} class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors">
        <Download class="h-3.5 w-3.5" /> PNG
      </button>
    </div>
  {/if}

  {#if error}
    <div class="px-4 py-3 text-sm text-error">{error}</div>
  {:else}
    <!-- Not centred: an assistant turn is left-aligned, so a chart narrower
         than the column must start on the same edge as the prose around it.
         `relative` stays — the tooltip positions against it. -->
    <div class="chart-container relative p-2 pb-3">
      <svg bind:this={svgEl} width={W} height={H} viewBox="0 0 {W} {H}" class="text-[var(--text)]" style="max-width:100%;height:auto;"></svg>
      <!-- Tooltip -->
      {#if tooltip.visible}
        <div
          bind:this={tooltipEl}
          class="pointer-events-none absolute z-20 rounded-lg border px-3 py-2 text-xs shadow-lg"
          style="left:{tooltip.x + 10}px;top:{tooltip.y - 36}px;border-color:var(--border);background:var(--surface);color:var(--text)"
        >
          {#if tooltip.series}<span class="font-semibold" style="color:var(--work-accent)">{tooltip.series}: </span>{/if}
          <span class="font-medium">{tooltip.label}</span>
          <span class="ml-1.5 font-bold">{tooltip.value}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .artifact-chart {
    margin: 0.65rem 0 0;
    width: var(--inline-block-width);
    max-width: 100%;
    overflow: hidden;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
    padding: 0.65rem 0.75rem 0.45rem;
  }

  .artifact-chart-title {
    margin-bottom: 0.35rem;
    color: var(--text);
    font-size: 0.95rem;
    font-weight: 650;
  }
</style>
