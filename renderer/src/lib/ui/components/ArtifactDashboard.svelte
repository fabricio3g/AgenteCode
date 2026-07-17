<svelte:options runes={true} />

<script lang="ts">
  import type { DashboardArtifactPayload } from '$lib/types/chat';

  interface Props {
    payload: DashboardArtifactPayload;
  }

  let { payload }: Props = $props();
</script>

<section class="artifact-dashboard" aria-label={payload.title || 'Dashboard'}>
  <header class="dashboard-header">
    <h3>{payload.title}</h3>
    {#if payload.subtitle}<p>{payload.subtitle}</p>{/if}
  </header>

  {#if payload.metrics?.length}
    <div class="metrics-grid">
      {#each payload.metrics as metric}
        <div class="metric" style={`--metric-accent:${metric.color || 'var(--primary)'}`}>
          <div class="metric-label">{metric.label || 'Metric'}</div>
          <div class="metric-value">
            {metric.value ?? '-'}{#if metric.unit}<span>{metric.unit}</span>{/if}
          </div>
          {#if metric.trend}<div class="metric-trend">{metric.trend}</div>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if payload.sections?.length}
    <div class="dashboard-sections">
      {#each payload.sections as section}
        <article class="dashboard-section">
          {#if section.heading}<h4>{section.heading}</h4>{/if}
          {#if section.content}<p>{section.content}</p>{/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .artifact-dashboard {
    width: min(100%, 42rem);
    margin-top: 0.65rem;
    padding: 0.85rem 0.95rem;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
    color: var(--text);
  }

  .dashboard-header {
    margin-bottom: 0.85rem;
  }

  .dashboard-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
  }

  .dashboard-header p {
    margin: 0.18rem 0 0;
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    gap: 0.65rem;
  }

  .metric {
    position: relative;
    padding: 0.7rem 0.65rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--chat-bg) 45%, transparent);
  }

  .metric::before {
    content: '';
    display: block;
    width: 2.1rem;
    height: 2px;
    margin-bottom: 0.5rem;
    background: var(--metric-accent);
  }

  .metric-label {
    color: var(--text-secondary);
    font-size: 0.68rem;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .metric-value {
    margin-top: 0.18rem;
    font-size: 1.45rem;
    font-weight: 760;
    line-height: 1.05;
  }

  .metric-value span {
    margin-left: 0.25rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .metric-trend {
    margin-top: 0.25rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .dashboard-sections {
    display: grid;
    gap: 0.8rem;
    margin-top: 0.95rem;
  }

  .dashboard-section h4 {
    margin: 0 0 0.25rem;
    font-size: 0.86rem;
    font-weight: 680;
  }

  .dashboard-section p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.86rem;
    line-height: 1.55;
  }
</style>
