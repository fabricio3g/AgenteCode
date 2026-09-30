<svelte:options runes={true} />

<!--
  The quiet status line at the right of the composer bar, the same in Home
  and Code: what the conversation cost or produced, what's queued, and how
  full the context is. One line; in a narrow composer the text goes first
  and the ring stays.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  let { text, detail, queued, ring }: {
    /** "~$0.04 · 82% cached", or "9 tok · 45 tok/s". */
    text?: string;
    /** Tooltip for the text. */
    detail?: string;
    /** "2 queued" while messages wait for the running turn. */
    queued?: string;
    /** The context ring, when there is context to report. */
    ring?: Snippet;
  } = $props();
</script>

{#if text || queued || ring}
  <div class="composer-status">
    {#if queued}<span class="status-text" role="status">{queued}</span>{/if}
    {#if text}<span class="status-text" title={detail}>{text}</span>{/if}
    {#if ring}{@render ring()}{/if}
  </div>
{/if}

<style>
  .composer-status {
    display: flex;
    min-width: 0;
    flex: 0 1 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    color: var(--muted-foreground);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .status-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @container composer (max-width: 520px) {
    .status-text { display: none; }
  }
</style>
