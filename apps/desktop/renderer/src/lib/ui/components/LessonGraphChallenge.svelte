<svelte:options runes={true} />

<!--
  Interactive graph challenge: drag a point along a curve to match a target
  tangent slope or y-value, with live rise/run guide and formative feedback.
-->

<script lang="ts">
  import { Check, X } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import { evaluateExpression, sampleSeries } from './simulation-model';

  interface Props {
    expression: string;
    xRange?: [number, number];
    initialX?: number;
    metric?: 'slope' | 'value';
    target: number;
    tolerance?: number;
    explanation?: string;
    readOnly?: boolean;
    onAnswer?: (value: number, correct: boolean) => void;
  }

  let {
    expression,
    xRange = [-1, 6],
    initialX,
    metric = 'slope',
    target,
    tolerance = 0.15,
    explanation,
    readOnly = false,
    onAnswer
  }: Props = $props();

  const W = 580;
  const H = 220;
  const PAD = { l: 40, r: 22, t: 18, b: 28 };

  let px = $state(0);
  let dragging = false;
  let checked = $state<{ ok: boolean; value: number } | null>(null);
  let svgEl = $state<SVGSVGElement>();

  $effect(() => {
    px = typeof initialX === 'number' ? initialX : (xRange[0] + xRange[1]) / 2;
    checked = null;
  });

  const evalAt = (x: number) => evaluateExpression(expression, { x }) ?? 0;
  const slopeAt = (x: number) => {
    const h = 1e-4;
    return (evalAt(x + h) - evalAt(x - h)) / (2 * h);
  };

  const samples = $derived(sampleSeries({ expression, variable: 'x', from: xRange[0], to: xRange[1], samples: 100 }));
  const yBounds = $derived.by<[number, number]>(() => {
    const ys = samples.map((p) => p.y).filter((v) => Number.isFinite(v));
    if (!ys.length) return [-1, 5];
    const min = Math.min(...ys, 0);
    const max = Math.max(...ys, 1);
    const pad = Math.max(0.5, (max - min) * 0.14);
    return [min - pad, max + pad];
  });

  const mx = (x: number) => PAD.l + ((x - xRange[0]) / (xRange[1] - xRange[0] || 1)) * (W - PAD.l - PAD.r);
  const my = (y: number) => (H - PAD.b) - ((y - yBounds[0]) / (yBounds[1] - yBounds[0] || 1)) * (H - PAD.t - PAD.b);

  const curvePath = $derived(samples.map((p, i) => `${i ? 'L' : 'M'} ${mx(p.x).toFixed(1)} ${my(p.y).toFixed(1)}`).join(' '));
  const currentY = $derived(evalAt(px));
  const currentSlope = $derived(slopeAt(px));
  const currentMetric = $derived(metric === 'slope' ? currentSlope : currentY);
  const spanX = $derived((xRange[1] - xRange[0]) * 0.22);

  function updateFromPointer(event: PointerEvent) {
    if (!svgEl || readOnly) return;
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width) return;
    const sx = ((event.clientX - rect.left) / rect.width) * W;
    const raw = xRange[0] + ((sx - PAD.l) / (W - PAD.l - PAD.r)) * (xRange[1] - xRange[0]);
    const clamped = Math.max(xRange[0], Math.min(xRange[1], raw));
    px = Math.round(clamped * 10) / 10;
  }

  function onPointerDown(event: PointerEvent) {
    if (readOnly) return;
    dragging = true;
    svgEl?.setPointerCapture?.(event.pointerId);
    updateFromPointer(event);
  }

  function onPointerMove(event: PointerEvent) {
    if (dragging) updateFromPointer(event);
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    svgEl?.releasePointerCapture?.(event.pointerId);
  }

  function check() {
    if (readOnly) return;
    const ok = Math.abs(currentMetric - target) <= tolerance;
    checked = { ok, value: currentMetric };
    onAnswer?.(Number(currentMetric.toFixed(2)), ok);
  }
</script>

<div class="gc">
  <div class="gc-readout">
    <span>x = <strong>{px.toFixed(1)}</strong></span>
    <span>{metric === 'slope' ? "f'(x)" : 'f(x)'} = <strong class="acc">{currentMetric.toFixed(2)}</strong></span>
    <span class="gc-target">Target: {target}</span>
  </div>

  <div class="gc-stage">
    <svg
      bind:this={svgEl}
      class="gc-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Interactive graph of ${expression}`}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <line x1={PAD.l} y1={my(0)} x2={W - PAD.r} y2={my(0)} class="axis" />
      <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} class="axis" />
      {#if curvePath}
        <path d={curvePath} class="curve" />
      {/if}
      {#if metric === 'slope'}
        <line
          x1={mx(px - spanX)}
          y1={my(currentY - spanX * currentSlope)}
          x2={mx(px + spanX)}
          y2={my(currentY + spanX * currentSlope)}
          class="tangent"
        />
      {:else}
        <line x1={PAD.l} y1={my(currentY)} x2={mx(px)} y2={my(currentY)} class="guide" />
        <line x1={mx(px)} y1={my(currentY)} x2={mx(px)} y2={my(0)} class="guide" />
      {/if}
      <circle cx={mx(px)} cy={my(currentY)} r="13" class="halo" />
      <circle cx={mx(px)} cy={my(currentY)} r="5.5" class="dot" />
    </svg>
  </div>

  <div class="gc-actions">
    <Button size="sm" onclick={check} disabled={readOnly}>Check</Button>
    {#if checked}
      <span class="gc-fb" class:is-good={checked.ok} class:is-bad={!checked.ok}>
        {#if checked.ok}<Check class="size-3.5 shrink-0" />{:else}<X class="size-3.5 shrink-0" />{/if}
        <span>
          {#if checked.ok}
            {explanation || `Matched ${target} at x = ${px.toFixed(1)}.`}
          {:else}
            Currently {checked.value.toFixed(2)} (target {target}) — drag along the curve to adjust.
          {/if}
        </span>
      </span>
    {/if}
  </div>
</div>

<style>
  .gc { display: flex; flex-direction: column; gap: 0.625rem; }

  .gc-readout {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .gc-readout strong { color: var(--foreground); }
  .gc-readout .acc { color: var(--brand-accent, var(--foreground)); }
  .gc-target { margin-left: auto; color: var(--muted-foreground); }

  .gc-stage {
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
    padding: 0.5rem;
    overflow: hidden;
  }

  .gc-svg {
    display: block;
    width: 100%;
    height: auto;
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
  }

  .axis { stroke: var(--border); stroke-width: 1; }
  .curve { fill: none; stroke: var(--foreground); stroke-width: 2; stroke-linecap: round; }
  .tangent { stroke: var(--brand-accent, var(--foreground)); stroke-width: 2; stroke-linecap: round; }
  .guide { stroke: var(--brand-accent, var(--foreground)); stroke-dasharray: 3 3; opacity: 0.7; }
  .halo { fill: var(--brand-accent, var(--foreground)); opacity: 0.16; }
  .dot { fill: var(--brand-accent, var(--foreground)); stroke: var(--background); stroke-width: 2; }

  .gc-actions { display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap; }
  .gc-fb {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }
  .gc-fb.is-good { background: var(--accent-green-bg); color: var(--accent-green-text); }
  .gc-fb.is-bad { background: var(--accent-red-bg); color: var(--accent-red-text); }
</style>
