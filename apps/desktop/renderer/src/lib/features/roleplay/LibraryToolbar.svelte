<svelte:options runes={true} />

<!--
  A shelf's toolbar: the search pill and the shelf's own actions (outlined
  chips) beside it. Without a placeholder there is no search, only actions.
-->

<script lang="ts">
  import { Tooltip } from '$lib/components/ui';
  import type { Snippet } from 'svelte';
  import { Search, X } from 'lucide-svelte';

  let { query = $bindable(''), placeholder = '', children }: { query?: string; placeholder?: string; children: Snippet } = $props();
</script>

<div class="lib-toolbar">
  {#if placeholder}
    <label class="ui-pill-field lib-search">
      <Search class="size-3.5 shrink-0 text-muted-foreground" />
      <input bind:value={query} {placeholder} aria-label={placeholder} />
      {#if query}
        <Tooltip label="Clear search" position="bottom"><button type="button" class="ui-icon-button is-xs -mr-1.5" aria-label="Clear search" onclick={() => (query = '')}><X /></button></Tooltip>
      {/if}
    </label>
  {:else}
    <span class="flex-1"></span>
  {/if}
  {@render children()}
</div>

<style>
  .lib-toolbar {
    display: flex;
    flex-wrap:wrap;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.875rem;
  }
  .lib-search {
    height: 2rem;
    flex: 1 1 10rem;
    min-width:0;
    padding: 0 0.75rem;
  }
  .lib-search input {
    font-size: var(--text-sm);
  }
</style>
