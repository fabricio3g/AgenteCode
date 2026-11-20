<svelte:options runes={true} />

<!--
  A filter toggle with an optional count — the library screens' type
  filters. No outline: off is plain grey text, on is a soft fill and the
  label in full colour, so the one chosen filter is the only marked thing.
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
    height: 1.75rem;
    padding: 0 0.625rem;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease), transform var(--motion-instant) var(--motion-ease);
  }
  .chip:hover {
    color: var(--foreground);
    background: var(--surface-hover);
  }
  .chip:active {
    transform: translateY(1px);
  }
  .chip.is-on {
    border-color: var(--float-border);
    background: var(--muted);
    box-shadow: var(--control-shadow);
    color: var(--foreground);
    font-weight: 600;
  }
  .chip-count {
    color: var(--muted-foreground);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .chip:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
