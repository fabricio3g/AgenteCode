<svelte:options runes={true} />

<script lang="ts">
  import type { InfoCardArtifactPayload } from '$lib/types/chat';
  import VizHeading from './VizHeading.svelte';

  interface Props {
    payload: InfoCardArtifactPayload;
  }

  let { payload }: Props = $props();

</script>

<section class="viz-surface info-card" aria-label={payload.title || 'Info card'}>
  <header class="viz-header">
    <VizHeading kind="info_card" title={payload.title} subtitle={payload.subtitle} />
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
  .info-rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .info-row {
    display: grid;
    grid-template-columns: minmax(5.5rem, 34%) 1fr;
    gap: 0.5rem 0.85rem;
    align-items: baseline;
    padding: 0.55rem 0;
    border-top: 1px solid var(--border-subtle);
  }

  .info-row dt {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 450;
    color: var(--muted-foreground);
    text-transform: none;
    letter-spacing: 0.005em;
  }

  .info-row dd {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }

  .value {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--foreground);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }

  .info-footer {
    margin-top: 0.625rem;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border-subtle);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }

  @media (max-width: 480px) {
    .info-row {
      grid-template-columns: 1fr;
      gap: 0.15rem;
    }
  }
</style>
