<svelte:options runes={true} />

<script lang="ts">
  import type { InfoCardArtifactPayload } from '$lib/types/chat';
  import { resolveArtifactAccent } from './artifact-accent';

  interface Props {
    payload: InfoCardArtifactPayload;
  }

  let { payload }: Props = $props();

  const accent = $derived(resolveArtifactAccent(payload.accent));
</script>

<section class="info-card" style={`--card-accent:${accent}`} aria-label={payload.title || 'Info card'}>
  <header class="info-header">
    <h3>{payload.title}</h3>
    {#if payload.subtitle}
      <p>{payload.subtitle}</p>
    {/if}
  </header>

  {#if payload.rows?.length}
    <dl class="info-rows">
      {#each payload.rows as row}
        <div class="info-row">
          <dt>{row.label}</dt>
          <dd>
            <span class="value">{row.value}</span>
            {#if row.hint}<span class="hint">{row.hint}</span>{/if}
          </dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#if payload.footer}
    <footer class="info-footer">{payload.footer}</footer>
  {/if}
</section>

<style>
  .info-card {
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.65rem;
    padding: 0.9rem 1rem;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
    color: var(--text);
    border-left: 3px solid var(--card-accent, var(--primary));
  }

  .info-header {
    margin-bottom: 0.75rem;
  }

  .info-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  .info-header p {
    margin: 0.2rem 0 0;
    font-size: 0.82rem;
    color: var(--text-secondary);
  }

  .info-rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .info-row {
    display: grid;
    grid-template-columns: minmax(5.5rem, 34%) 1fr;
    gap: 0.55rem 0.85rem;
    align-items: baseline;
    padding: 0.4rem 0.5rem;
    border-radius: calc(var(--artifact-radius, 12px) - 4px);
    background: color-mix(in srgb, var(--surface-hover, rgba(127, 127, 127, 0.08)) 80%, transparent);
  }

  .info-row dt {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-tertiary, var(--text-secondary));
    text-transform: none;
    letter-spacing: 0.01em;
  }

  .info-row dd {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .value {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
  }

  .hint {
    font-size: 0.72rem;
    color: var(--text-tertiary, var(--text-secondary));
  }

  .info-footer {
    margin-top: 0.75rem;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border);
    font-size: 0.72rem;
    color: var(--text-tertiary, var(--text-secondary));
  }

  @media (max-width: 480px) {
    .info-row {
      grid-template-columns: 1fr;
      gap: 0.15rem;
    }
  }
</style>
