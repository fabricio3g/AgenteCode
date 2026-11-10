<svelte:options runes={true} />

<script lang="ts">
  import type { LessonPoint } from './simulation-model';
  import { areaPath, pathFor, plotScale, tickLabel, ticks, zeroLine } from './lesson-plot';

  interface PlotSeries {
    points: LessonPoint[];
    tone?: 'truth' | 'guess' | 'ghost';
    area?: boolean;
  }

  interface Props {
    series: PlotSeries[];
    xLabel?: string;
    yLabel?: string;
    height?: number;
    /** Drag handles at fixed x positions — the "you draw it" interaction. */
    handles?: Array<{ x: number; y: number }>;
    onHandleDrag?: (index: number, y: number) => void;
    label?: string;
  }

  let { series, xLabel, yLabel, height = 200, handles, onHandleDrag, label }: Props = $props();

  const width = 560;
  let dragging = $state<number | null>(null);

  const points = $derived(series.flatMap((entry) => entry.points));
  const scale = $derived(plotScale(points, { width, height }));
  const baseline = $derived(zeroLine(scale));

  function toLocalY(event: PointerEvent, svg: SVGSVGElement): number {
    const rect = svg.getBoundingClientRect();
    if (!rect.height) return 0;
    return ((event.clientY - rect.top) / rect.height) * height;
  }

  function nearestHandle(event: PointerEvent, svg: SVGSVGElement): number {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return 0;
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestDistance = Infinity;
    (handles ?? []).forEach((handle, index) => {
      const distance = Math.abs(scale.x(handle.x) - localX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  function onPointerDown(event: PointerEvent) {
    if (!handles?.length || !onHandleDrag) return;
    const svg = event.currentTarget as SVGSVGElement;
    dragging = nearestHandle(event, svg);
    svg.setPointerCapture?.(event.pointerId);
    onPointerMove(event, svg);
  }

  function onPointerMove(event: PointerEvent, from?: SVGSVGElement) {
    if (dragging === null || !onHandleDrag) return;
    const svg = from ?? (event.currentTarget as SVGSVGElement);
    const y = scale.invertY(toLocalY(event, svg));
    onHandleDrag(dragging, y);
  }

  function onPointerUp(event: PointerEvent) {
    if (dragging === null) return;
    (event.currentTarget as SVGSVGElement).releasePointerCapture?.(event.pointerId);
    dragging = null;
  }

  const guessPoints = $derived(handles?.length ? handles.map((handle) => ({ x: handle.x, y: handle.y })) : []);
</script>

<svg
  class="lesson-plot"
  class:is-draggable={!!handles?.length}
  viewBox={`0 0 ${width} ${height}`}
  role="img"
  aria-label={label || 'Plot'}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
  <!-- axes -->
  <line x1={scale.x(scale.xRange[0])} y1={scale.y(scale.yRange[0])} x2={scale.x(scale.xRange[1])} y2={scale.y(scale.yRange[0])} class="axis" />
  <line x1={scale.x(scale.xRange[0])} y1={scale.y(scale.yRange[0])} x2={scale.x(scale.xRange[0])} y2={scale.y(scale.yRange[1])} class="axis" />
  {#if baseline !== null}
    <line x1={scale.x(scale.xRange[0])} y1={baseline} x2={scale.x(scale.xRange[1])} y2={baseline} class="baseline" />
  {/if}

  {#each ticks(scale.xRange) as tick}
    <text class="tick" x={scale.x(tick)} y={height - 6} text-anchor="middle">{tickLabel(tick)}</text>
  {/each}
  {#each ticks(scale.yRange) as tick}
    <text class="tick" x={4} y={scale.y(tick) + 3} text-anchor="start">{tickLabel(tick)}</text>
  {/each}

  {#each series as entry}
    {#if entry.area && entry.points.length}
      <path class="area" class:is-ghost={entry.tone === 'ghost'} d={areaPath(entry.points, scale)} />
    {/if}
    {#if entry.points.length}
      <path
        class="curve"
        class:is-guess={entry.tone === 'guess'}
        class:is-ghost={entry.tone === 'ghost'}
        d={pathFor(entry.points, scale)}
      />
    {/if}
  {/each}

  {#if guessPoints.length}
    <path class="curve is-guess" d={pathFor(guessPoints, scale)} />
    {#each handles ?? [] as handle, index}
      <circle
        class="handle"
        class:is-dragging={dragging === index}
        cx={scale.x(handle.x)}
        cy={scale.y(handle.y)}
        r="6"
      />
    {/each}
  {/if}

  {#if xLabel}
    <text class="label" x={width - 4} y={height - 6} text-anchor="end">{xLabel}</text>
  {/if}
  {#if yLabel}
    <text class="label" x={scale.box.padLeft - 6} y={scale.box.padTop + 8} text-anchor="end">{yLabel}</text>
  {/if}
</svg>

<style>
  .lesson-plot {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
    touch-action: none;
  }

  .lesson-plot.is-draggable { cursor: ns-resize; }

  .axis {
    stroke: var(--border-subtle);
    stroke-width: 1;
  }

  .baseline {
    stroke: var(--border-subtle);
    stroke-dasharray: 2 3;
  }

  .curve {
    fill: none;
    stroke: var(--chart-1, var(--foreground));
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .curve.is-guess {
    stroke: var(--text-secondary, var(--muted-foreground));
    stroke-dasharray: 4 4;
  }

  .curve.is-ghost { stroke: var(--border-subtle); }

  .area {
    fill: color-mix(in srgb, var(--chart-1, var(--foreground)) 10%, transparent);
    stroke: none;
  }

  .tick,
  .label {
    fill: var(--text-tertiary, var(--muted-foreground));
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .handle {
    fill: var(--background);
    stroke: var(--chart-1, var(--foreground));
    stroke-width: 1.75;
    transition: r var(--motion-fast) var(--motion-ease-out);
  }

  .handle.is-dragging { r: 8; }

  @media (prefers-reduced-motion: reduce) {
    .handle { transition: none; }
  }
</style>
