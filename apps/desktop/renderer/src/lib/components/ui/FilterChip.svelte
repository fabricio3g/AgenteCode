<svelte:options runes={true} />

<!--
  A pill-shaped filter toggle with an optional count — the library screens'
  type filters (Artifacts, Files). Inverts when on.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  let { on = false, count, onclick, children }: { on?: boolean; count?: number; onclick: () => void; children: Snippet } = $props();
</script>

<button type="button" class="chip" class:is-on={on} aria-pressed={on} {onclick}>
  {@render children()}
  {#if count !== undefined}<span class="chip-count">{count}</span>{/if}
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 2rem;
    padding: 0 0.875rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    background: var(--background);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease);
  }
  .chip:hover {
    color: var(--foreground);
    background: var(--surface-hover);
  }
  .chip.is-on {
    border-color: var(--foreground);
    background: var(--foreground);
    color: var(--background);
  }
  .chip-count {
    font-size: var(--text-xs);
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
</style>
