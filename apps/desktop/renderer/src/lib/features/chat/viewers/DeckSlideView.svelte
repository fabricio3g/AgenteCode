<svelte:options runes={true} />

<!--
  One slide of a generated deck, drawn from its spec with the same geometry,
  type and colors main/slides.ts writes into the .pptx — so what you see in
  the app is what opens in PowerPoint. Sized in container units: the slide
  is 13.333 × 7.5 in, so 1 in = 7.5cqw and 1 pt = 0.10417cqw.
-->

<script lang="ts">
  import { ARTIFACT_ACCENTS, ARTIFACT_BRAND, ARTIFACT_INK } from '$shared/artifact-theme';
  import type { DeckSlide, DeckSpec } from '$shared/deck';

  interface Props {
    deck: DeckSpec;
    slide: DeckSlide;
    index: number;
  }

  let { deck, slide, index }: Props = $props();

  const ink = $derived(ARTIFACT_INK[deck.theme]);
  const accent = $derived(ARTIFACT_ACCENTS[deck.accent][deck.theme]);
  const palette = $derived(
    [deck.accent, ...Object.keys(ARTIFACT_ACCENTS).filter((key) => key !== deck.accent && key !== 'slate'), 'slate']
      .map((key) => ARTIFACT_ACCENTS[key as keyof typeof ARTIFACT_ACCENTS][deck.theme])
  );
  const vars = $derived(
    `--bg:${slide.layout === 'section' ? ink.soft : ink.bg};--ink:${ink.text};--muted:${ink.muted};--line:${ink.line};--soft:${ink.soft};--accent:${accent}`
  );

  // Chart geometry: viewBox 1000 × 383 matches the chart box (88.75 × 34 cqw).
  const chart = $derived(slide.chart);
  const round = $derived(chart?.type === 'pie' || chart?.type === 'doughnut');
  const domain = $derived.by(() => {
    const values = chart?.series.flatMap((series) => series.values) || [0];
    const low = Math.min(0, ...values), high = Math.max(0, ...values);
    const span = high - low || 1, step = 10 ** Math.floor(Math.log10(span));
    return { low: Math.floor(low / step) * step, high: Math.ceil((high || (low === 0 ? 1 : 0)) / step) * step };
  });
  const PLOT = { x: 70, y: 14, w: 910, h: 320 };
  const fraction = (value: number) => (value - domain.low) / Math.max(1e-12, domain.high - domain.low);
  const ticks = $derived(Array.from({ length: 6 }, (_, i) => domain.low + (domain.high - domain.low) * i / 5));

  function bars() {
    if (!chart) return [];
    const groups = chart.labels.length;
    const groupW = PLOT.w / groups;
    const barW = (groupW * 0.62) / chart.series.length;
    return chart.series.flatMap((series, s) => series.values.slice(0, groups).map((value, g) => {
      const baseline = PLOT.y + PLOT.h * (1 - fraction(0));
      const y = PLOT.y + PLOT.h * (1 - fraction(value));
      return { x: PLOT.x + g * groupW + groupW * 0.19 + s * barW, y: Math.min(y, baseline), w: barW, h: Math.abs(baseline - y), color: palette[s % palette.length] };
    }));
  }

  function hbars() {
    if (!chart) return [];
    const groups = chart.labels.length;
    const groupH = PLOT.h / groups;
    const barH = (groupH * 0.62) / chart.series.length;
    return chart.series.flatMap((series, s) => series.values.slice(0, groups).map((value, g) => ({
      x: PLOT.x + Math.min(fraction(0), fraction(value)) * PLOT.w, y: PLOT.y + g * groupH + groupH * 0.19 + s * barH, w: Math.abs(fraction(value) - fraction(0)) * PLOT.w, h: barH, color: palette[s % palette.length]
    })));
  }

  function lines() {
    if (!chart) return [];
    const step = chart.labels.length > 1 ? PLOT.w / (chart.labels.length - 1) : 0;
    return chart.series.map((series, s) => ({
      color: palette[s % palette.length],
      points: series.values.map((value, i) => `${PLOT.x + i * step},${PLOT.y + PLOT.h - fraction(value) * PLOT.h}`).join(' ')
    }));
  }

  function slices() {
    if (!chart) return [];
    const values = chart.series[0]?.values ?? [];
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const cx = 500, cy = 180, r = 170, inner = chart.type === 'doughnut' ? 102 : 0;
    return values.map((value, i) => {
      const start = angle;
      const end = angle + (value / total) * Math.PI * 2;
      angle = end;
      const large = end - start > Math.PI ? 1 : 0;
      const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const d = inner
        ? `M${p(start, r)} A${r},${r} 0 ${large} 1 ${p(end, r)} L${p(end, inner)} A${inner},${inner} 0 ${large} 0 ${p(start, inner)} Z`
        : `M${cx},${cy} L${p(start, r)} A${r},${r} 0 ${large} 1 ${p(end, r)} Z`;
      return { d, color: palette[i % palette.length], label: chart.labels[i] ?? '', pct: Math.round((value / total) * 100) };
    });
  }

  function formatTick(value: number): string {
    return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(value);
  }
</script>

<div class="deck-slide" style={vars} data-layout={slide.layout}>
  {#if slide.layout === 'title'}
    <span class="bar" style="top:19.125cqw"></span>
    <h1 class="t-title">{slide.title || deck.title}</h1>
    {#if slide.subtitle || deck.subtitle}<p class="t-sub">{slide.subtitle || deck.subtitle}</p>{/if}
    <p class="t-brand">{ARTIFACT_BRAND}</p>
  {:else if slide.layout === 'section'}
    <span class="bar" style="top:22.875cqw"></span>
    <h1 class="s-title">{slide.title}</h1>
    {#if slide.subtitle}<p class="s-sub">{slide.subtitle}</p>{/if}
  {:else}
    {#if slide.layout !== 'quote'}<h2 class="heading">{slide.title}</h2>{/if}

    {#if slide.layout === 'two-column'}
      <div class="cols">
        {#each [slide.left, slide.right] as col, i (i)}
          <div class="col">
            {#if col?.heading}<p class="col-head">{col.heading}</p>{/if}
            {#if col?.bullets.length}<ul class="bullets small">{#each col.bullets as item, j (j)}<li>{item}</li>{/each}</ul>{/if}
          </div>
        {/each}
      </div>
    {:else if slide.layout === 'quote'}
      <span class="q-mark">“</span>
      <blockquote class="q-text">{slide.quote || slide.title}</blockquote>
      {#if slide.attribution}<p class="q-by">— {slide.attribution}</p>{/if}
    {:else if slide.layout === 'stats'}
      <div class="stats">
        {#each slide.stats ?? [] as stat, i (i)}
          <div class="stat"><p class="stat-value">{stat.value}</p><p class="stat-label">{stat.label}</p></div>
        {/each}
      </div>
      {#if slide.bullets.length}<ul class="bullets small stats-notes">{#each slide.bullets as item, j (j)}<li>{item}</li>{/each}</ul>{/if}
    {:else if slide.layout === 'table' && slide.table}
      <table class="table">
        <thead><tr>{#each slide.table.columns as col, i (i)}<th>{col}</th>{/each}</tr></thead>
        <tbody>
          {#each slide.table.rows as row, r (r)}
            <tr>{#each slide.table.columns as _, c (c)}<td>{row[c] ?? ''}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    {:else if slide.layout === 'chart' && chart}
      <svg class="chart" viewBox="0 0 1000 383" role="img" aria-label={slide.title}>
        {#if round}
          {#each slices() as part, i (i)}<path d={part.d} fill={part.color} />{/each}
        {:else}
          {#each ticks as tick, i (i)}
            {#if chart.type === 'bar'}
              <line x1={PLOT.x + fraction(tick) * PLOT.w} x2={PLOT.x + fraction(tick) * PLOT.w} y1={PLOT.y} y2={PLOT.y + PLOT.h} stroke="var(--line)" stroke-width="1" />
              <text x={PLOT.x + fraction(tick) * PLOT.w} y={PLOT.y + PLOT.h + 26} text-anchor="middle" class="axis">{formatTick(tick)}</text>
            {:else}
              <line x1={PLOT.x} x2={PLOT.x + PLOT.w} y1={PLOT.y + PLOT.h - fraction(tick) * PLOT.h} y2={PLOT.y + PLOT.h - fraction(tick) * PLOT.h} stroke="var(--line)" stroke-width="1" />
              <text x={PLOT.x - 12} y={PLOT.y + PLOT.h - fraction(tick) * PLOT.h + 5} text-anchor="end" class="axis">{formatTick(tick)}</text>
            {/if}
          {/each}
          {#if chart.type === 'line'}
            {#each lines() as series, i (i)}<polyline points={series.points} fill="none" stroke={series.color} stroke-width="4" stroke-linejoin="round" stroke-linecap="round" />{/each}
          {:else if chart.type === 'bar'}
            {#each hbars() as bar, i (i)}<rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.color} />{/each}
          {:else}
            {#each bars() as bar, i (i)}<rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.color} />{/each}
          {/if}
          {#each chart.labels as label, i (i)}
            {#if chart.type === 'bar'}
              <text x={PLOT.x - 12} y={PLOT.y + (i + 0.5) * (PLOT.h / chart.labels.length) + 5} text-anchor="end" class="axis">{label}</text>
            {:else}
              <text x={chart.type === 'line' ? PLOT.x + i * (chart.labels.length > 1 ? PLOT.w / (chart.labels.length - 1) : 0) : PLOT.x + (i + 0.5) * (PLOT.w / chart.labels.length)} y={PLOT.y + PLOT.h + 26} text-anchor="middle" class="axis">{label}</text>
            {/if}
          {/each}
        {/if}
      </svg>
      {#if round || chart.series.length > 1}
        <div class="legend">
          {#each round ? chart.labels : chart.series.map((s) => s.name) as name, i (i)}
            <span><i style:background={palette[i % palette.length]}></i>{name}</span>
          {/each}
        </div>
      {/if}
    {:else if slide.bullets.length}
      <ul class="bullets">{#each slide.bullets as item, j (j)}<li>{item}</li>{/each}</ul>
    {/if}
    <p class="page">{index + 1} / {deck.slides.length}</p>
  {/if}
</div>

<style>
  .deck-slide {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    container-type: inline-size;
    background: var(--bg);
    color: var(--ink);
    font-family: Aptos, 'Segoe UI', Inter, 'Helvetica Neue', Arial, sans-serif;
    line-height: 1.2;
    text-align: left;
  }
  .deck-slide :global(*) {
    margin: 0;
  }
  /* 1 in = 7.5cqw; 1 pt = 0.10417cqw. Positions mirror main/slides.ts. */
  .bar {
    position: absolute;
    left: 5.625cqw;
    width: 4.5cqw;
    height: 0.525cqw;
    background: var(--accent);
  }
  .t-title {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 21cqw;
    font-family: 'Aptos Display', Aptos, 'Segoe UI', Inter, Arial, sans-serif;
    font-size: 4.583cqw;
    font-weight: 700;
    line-height: 1.1;
  }
  .t-sub {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 33.375cqw;
    font-size: 2.083cqw;
    color: var(--muted);
  }
  .t-brand {
    position: absolute;
    left: 5.625cqw;
    bottom: 3.4cqw;
    font-size: 1.146cqw;
    color: var(--muted);
  }
  .s-title {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 24.75cqw;
    font-family: 'Aptos Display', Aptos, 'Segoe UI', Inter, Arial, sans-serif;
    font-size: 3.75cqw;
    font-weight: 700;
  }
  .s-sub {
    position: absolute;
    left: 5.625cqw;
    top: 33.75cqw;
    font-size: 1.875cqw;
    color: var(--muted);
  }
  .heading {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 4.65cqw;
    font-family: 'Aptos Display', Aptos, 'Segoe UI', Inter, Arial, sans-serif;
    font-size: 2.917cqw;
    font-weight: 700;
  }
  .bullets {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 13.125cqw;
    padding-left: 1.6cqw;
    font-size: 2.083cqw;
    line-height: 1.3;
  }
  .bullets li {
    margin-bottom: 1.04cqw;
    padding-left: 0.4cqw;
  }
  .bullets li::marker {
    color: var(--ink);
  }
  .bullets.small {
    font-size: 1.875cqw;
  }
  .cols {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 13.125cqw;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4.5cqw;
  }
  .col .bullets {
    position: static;
    margin-top: 1.2cqw;
  }
  .col-head {
    font-size: 1.875cqw;
    font-weight: 700;
    color: var(--accent);
  }
  .q-mark {
    position: absolute;
    left: 4.875cqw;
    top: 9.75cqw;
    font-family: Georgia, serif;
    font-size: 10cqw;
    line-height: 1;
    color: var(--accent);
  }
  .q-text {
    position: absolute;
    left: 7.125cqw;
    right: 7.125cqw;
    top: 17.6cqw;
    font-family: 'Aptos Display', Aptos, 'Segoe UI', Inter, Arial, sans-serif;
    font-size: 3.333cqw;
    font-style: italic;
    line-height: 1.25;
  }
  .q-by {
    position: absolute;
    left: 7.125cqw;
    top: 38.6cqw;
    font-size: 1.667cqw;
    color: var(--muted);
  }
  .stats {
    position: absolute;
    left: 5.625cqw;
    right: 5.625cqw;
    top: 15.75cqw;
    display: flex;
    gap: 2.625cqw;
  }
  .stat {
    flex: 1;
    height: 19.5cqw;
    padding: 2.6cqw 2.25cqw;
    border-radius: 0.9cqw;
    background: var(--soft);
  }
  .stat-value {
    font-family: 'Aptos Display', Aptos, 'Segoe UI', Inter, Arial, sans-serif;
    font-size: 4.583cqw;
    font-weight: 700;
    color: var(--accent);
  }
  .stat-label {
    margin-top: 1.4cqw;
    font-size: 1.667cqw;
    color: var(--muted);
  }
  .stats-notes {
    top: 38.25cqw;
  }
  .table {
    position: absolute;
    left: 5.625cqw;
    top: 13.5cqw;
    width: calc(100% - 11.25cqw);
    border-collapse: collapse;
    font-size: 1.667cqw;
  }
  .table th,
  .table td {
    height: 4.125cqw;
    padding: 0 0.9cqw;
    text-align: left;
    border-bottom: 0.08cqw solid var(--line);
  }
  .table th {
    font-size: 1.458cqw;
    color: var(--muted);
    border-bottom: 0.13cqw solid var(--ink);
  }
  .chart {
    position: absolute;
    left: 5.625cqw;
    top: 12cqw;
    width: calc(100% - 11.25cqw);
    height: 34cqw;
  }
  .axis {
    font-size: 18px;
    fill: var(--muted);
  }
  .legend {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 3.8cqw;
    display: flex;
    justify-content: center;
    gap: 2cqw;
    font-size: 1.25cqw;
    color: var(--muted);
  }
  .legend i {
    display: inline-block;
    width: 1cqw;
    height: 1cqw;
    margin-right: 0.5cqw;
    border-radius: 0.2cqw;
    vertical-align: middle;
  }
  .page {
    position: absolute;
    right: 5.625cqw;
    bottom: 3.4cqw;
    font-size: 1.042cqw;
    color: var(--muted);
  }
</style>
