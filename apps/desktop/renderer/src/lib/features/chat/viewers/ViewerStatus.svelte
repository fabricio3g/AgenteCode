<svelte:options runes={true} />

<!--
  The loading / error state shared by every document viewer.

  This markup and its CSS previously existed four times over, under four class
  prefixes (`docx-status`, `pdf-status`, `text-status`, `xlsx-status`) whose
  rules were byte-identical apart from the Docx card treatment.
-->

<script lang="ts">
  import { AlertCircle, Loader2 } from 'lucide-svelte';

  interface Props {
    loading: boolean;
    error: string | null;
    /** What the viewer is doing while `loading`, e.g. `Loading PDF…`. */
    label: string;
    /**
     * `inline` centres a one-line message; `card` frames it with a heading, for
     * viewers where a failed preview is the whole surface.
     */
    variant?: 'inline' | 'card';
    /** Heading for the `card` variant. */
    errorTitle?: string;
  }

  let { loading, error, label, variant = 'inline', errorTitle = 'Preview unavailable' }: Props =
    $props();
</script>

{#if loading}
  <div class="viewer-status">
    <Loader2 class="h-4 w-4 animate-spin" />
    <span>{label}</span>
  </div>
{:else if error}
  <div class="viewer-status error" class:card={variant === 'card'}>
    <AlertCircle class="h-4 w-4" />
    {#if variant === 'card'}
      <div>
        <strong>{errorTitle}</strong>
        <span>{error}</span>
      </div>
    {:else}
      <span>{error}</span>
    {/if}
  </div>
{/if}

<style>
  .viewer-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .viewer-status.error {
    color: var(--error);
  }

  .viewer-status.card {
    align-items: flex-start;
    width: min(30rem, 100%);
    margin: 4rem auto;
    gap: 0.65rem;
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    background: color-mix(in srgb, var(--surface-hover) 56%, transparent);
    padding: 2rem;
    color: var(--text-secondary);
    text-align: left;
  }

  .viewer-status.card strong {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--text);
    font-size: 0.9rem;
  }

  .viewer-status.card span {
    display: block;
    line-height: 1.45;
  }
</style>
