<svelte:options runes={true} />

<!--
  Search and filters on one line, the same on every library screen: a filled
  search field, the filter chips (with counts), and one quiet control at the
  far right (sort, a scope). It wraps on narrow windows; the chips never box.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import SearchField from './SearchField.svelte';
  import { cn } from '$lib/utils/cn';

  let {
    query = $bindable(''),
    placeholder,
    clearLabel,
    label,
    chips,
    trailing,
    class: className = ''
  }: {
    query?: string;
    placeholder: string;
    clearLabel: string;
    /** Names the chip group for assistive tech. */
    label: string;
    chips?: Snippet;
    trailing?: Snippet;
    class?: string;
  } = $props();
</script>

<div class={cn('ui-filter-bar', className)}>
  <SearchField bind:value={query} {placeholder} {clearLabel} variant="surface" class="ui-filter-search" />
  {#if chips}<div class="ui-filter-chips" role="group" aria-label={label}>{@render chips()}</div>{/if}
  {#if trailing}<div class="ui-filter-trailing">{@render trailing()}</div>{/if}
</div>

<style>
  .ui-filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  .ui-filter-bar :global(.ui-filter-search) {
    flex: 1 1 14rem;
    max-width: 22rem;
  }
  /* A soft fill, not an outline: on the page's own white the card colour vanishes. */
  .ui-filter-bar :global(.ui-filter-search input) { background: var(--muted); }
  .ui-filter-bar :global(.ui-filter-search input:hover),
  .ui-filter-bar :global(.ui-filter-search input:focus-visible) { background: var(--surface-hover); }
  .ui-filter-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.125rem;
  }
  .ui-filter-trailing {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: auto;
  }
</style>
