<svelte:options runes={true} />

<!--
  The header every work layout opens and folds by: an optional leading mark
  (stacked icons, a progress ring), the summary, a quieter second fact, and
  the run's duration hard right.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown } from '$lib/icons';
  import { formatToolDuration } from '$lib/utils/tool-ui';

  let {
    title,
    sub,
    span,
    live = false,
    open,
    ontoggle,
    lead
  }: {
    title: string;
    sub?: string;
    span?: number;
    live?: boolean;
    open: boolean;
    ontoggle: () => void;
    lead?: Snippet;
  } = $props();
</script>

<button type="button" class="wl-head" aria-expanded={open} onclick={ontoggle}>
  {#if lead}{@render lead()}{/if}
  <span class="wl-head-title" class:ui-shimmer-text={live}>{title}</span>
  {#if sub}<span class="wl-head-sub">{sub}</span>{/if}
  <span class="wl-fill"></span>
  {#if span !== undefined}<span class="wl-head-meta">{formatToolDuration(span)}</span>{/if}
  <ChevronDown class="wl-chev {open ? 'is-open' : ''}" />
</button>
