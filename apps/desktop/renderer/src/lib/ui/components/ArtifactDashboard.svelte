<svelte:options runes={true} />
<script lang="ts">
  import type { DashboardArtifactPayload } from '$lib/types/chat';
  import { resolveArtifactAccent } from './artifact-accent';
  import VizHeading from './VizHeading.svelte';
  import ChartBlock from '$lib/features/chat/ChartBlock.svelte';
  let { payload }: { payload: DashboardArtifactPayload } = $props();

  /** A change reads by its sign: up, down, or nothing worth a colour. */
  function trendTone(trend: string): 'up' | 'down' | 'flat' {
    const text = trend.trim();
    if (/^[-−▼↓]/.test(text)) return 'down';
    if (/^[+▲↑]/.test(text)) return 'up';
    return 'flat';
  }
</script>
<section class="viz-surface artifact-dashboard" aria-label={payload.title || 'Dashboard'}>
  <header class="viz-header"><VizHeading kind="dashboard" title={payload.title} subtitle={payload.subtitle} /></header>
  {#if payload.metrics?.length}
    <dl class="metrics-strip">
      {#each payload.metrics as metric, index (index)}
        <div class="metric" style:--metric-accent={resolveArtifactAccent(metric.color)}>
          <dd class="metric-value">{metric.value ?? '—'}{#if metric.unit}<span>{metric.unit}</span>{/if}</dd>
          <dt class="metric-label">{metric.label || 'Metric'}</dt>
          {#if metric.trend}<dd class="metric-trend" data-tone={metric.color ? undefined : trendTone(metric.trend)}>{metric.trend}</dd>{/if}
        </div>
      {/each}
    </dl>
  {/if}
  {#each payload.charts ?? [] as chart, index (index)}
    <ChartBlock type={chart.chartType} title={chart.title} raw={JSON.stringify(chart)} variant="artifact" />
  {/each}
  {#if payload.sections?.length}
    <div class="dashboard-sections">
      {#each payload.sections as section, index (index)}
        <article>{#if section.heading}<h4 class="viz-title">{section.heading}</h4>{/if}{#if section.content}<p>{section.content}</p>{/if}</article>
      {/each}
    </div>
  {/if}
</section>
<style>
  .metrics-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.25rem, 1fr)); gap: 0.5rem; margin: 0; }
  .metric { min-width: 0; padding: 0.7rem 0.85rem; border-radius: var(--radius-md); background: color-mix(in srgb, var(--foreground) 3%, transparent); }
  .metric dd { margin: 0; }
  .metric-value { color: var(--foreground); font-size: calc(var(--text-base) * 1.3); font-weight: 600; letter-spacing: -0.03em; line-height: 1.2; overflow-wrap: anywhere; }
  .metric-value span { margin-left: 0.2rem; font-size: var(--text-xs); font-weight: 400; color: var(--muted-foreground); }
  .metric-label { margin-top: 0.25rem; color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.35; }
  .metric .metric-trend { margin-top: 0.35rem; color: var(--metric-accent); font-size: var(--text-xs); font-weight: 500; }
  .metric .metric-trend[data-tone='up'] { color: var(--accent-green-text); }
  .metric .metric-trend[data-tone='down'] { color: var(--accent-red-text); }
  .metric .metric-trend[data-tone='flat'] { color: var(--muted-foreground); font-weight: 400; }
  .dashboard-sections { display: grid; gap: 0.875rem; margin-top: 1rem; }
  .dashboard-sections p { margin: 0.25rem 0 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.6; }
</style>
