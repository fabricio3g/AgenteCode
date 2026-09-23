<svelte:options runes={true} />

<script lang="ts">
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { LoaderCircle, Search as SearchIcon, X } from 'lucide-svelte';
  import { motionFade, motionFly } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { openWebviewer } from '$lib/services/search';

  let query = $state('');
  const currentSearchState = $derived(appStore.currentSearchState);

  function closeSidebar() {
    appStore.searchSidebarOpen = false;
  }

  async function runSearch() {
    await appStore.performWebSearch(query, appStore.currentChatId || '');
  }

  async function openResult(url: string) {
    if (!url) return;
    await openWebviewer(url);
  }

  $effect(() => {
    if (appStore.searchSidebarOpen) return;
    query = '';
  });
</script>

<div class="fixed inset-0" use:modalLayer={{ onclose: closeSidebar, zToken: '--z-drawer' }}>
  <button
    type="button"
    class="absolute inset-0 h-full w-full bg-overlay"
    aria-label="Close source search"
    transition:motionFade={{ duration: 160 }}
    onclick={closeSidebar}
  ></button>

  <aside
    class="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-border bg-background shadow-lg"
    transition:motionFly={{ x: 24, duration: 220 }}
  >
    <header class="flex shrink-0 items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-foreground">Source Search</h2>
      <button type="button" class="aui-icon-button size-8" onclick={closeSidebar} aria-label="Close">
        <X class="size-4" />
      </button>
    </header>

    <div class="shrink-0 px-3 pb-3">
      <div class="flex items-center gap-2">
        <input
          type="text"
          class="aui-input flex-1"
          placeholder="Search the web sources..."
          bind:value={query}
          onkeydown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
        />
        <button
          type="button"
          class="aui-btn aui-btn-primary size-9 shrink-0 !p-0"
          onclick={runSearch}
          disabled={currentSearchState.loading}
          aria-label="Run source search"
          title="Run search"
        >
          {#if currentSearchState.loading}
            <LoaderCircle class="size-4 animate-spin" />
          {:else}
            <SearchIcon class="size-4" />
          {/if}
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {#if currentSearchState.loading}
        <div class="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
          <LoaderCircle class="size-4 animate-spin" />
          Searching...
        </div>
      {:else if !currentSearchState.results.length}
        <p class="px-2 py-8 text-center text-sm text-muted-foreground">
          No results yet. Run a search to populate sources.
        </p>
      {:else}
        <div class="flex flex-col gap-0.5">
          {#each currentSearchState.results as result (result.url)}
            <button
              type="button"
              class="w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted"
              onclick={() => openResult(result.url)}
            >
              <p class="line-clamp-2 text-sm font-medium text-foreground">{result.title || result.url}</p>
              {#if result.snippet}
                <p class="mt-1 line-clamp-3 text-xs text-muted-foreground">{result.snippet}</p>
              {/if}
              <p class="mt-1.5 truncate text-[11px] text-muted-foreground">{result.url}</p>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </aside>
</div>
