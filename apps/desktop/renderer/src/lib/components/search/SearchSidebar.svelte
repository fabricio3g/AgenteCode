<svelte:options runes={true} />

<script lang="ts">
  import { Button, Tooltip } from '$lib/components/ui';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { LoaderCircle, Search as SearchIcon, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
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
    aria-label={$t('search.source.closeLabel')}
    transition:motionFade={{ duration: 160 }}
    onclick={closeSidebar}
  ></button>

  <aside
    class="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-border bg-background shadow-lg"
    transition:motionFly={{ x: 24, duration: 220 }}
  >
    <header class="flex shrink-0 items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-foreground">{$t('search.source.title')}</h2>
      <Tooltip label={$t('common.close')} position="bottom"><button type="button" class="ui-icon-button" onclick={closeSidebar} aria-label={$t('common.close')}>
        <X class="size-4" />
      </button></Tooltip>
    </header>

    <div class="shrink-0 px-3 pb-3">
      <div class="flex items-center gap-2">
        <input
          type="text"
          class="ui-input flex-1"
          placeholder={$t('search.source.placeholder')}
          bind:value={query}
          onkeydown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
        />
        <Tooltip label={$t('search.source.run')} position="bottom"><Button variant="default" size="icon-lg"
          type="button"
          onclick={runSearch}
          disabled={currentSearchState.loading}
          aria-label={$t('search.source.run')}
         
        >
          {#if currentSearchState.loading}
            <LoaderCircle class="size-4 animate-spin" />
          {:else}
            <SearchIcon class="size-4" />
          {/if}
        </Button></Tooltip>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {#if currentSearchState.loading}
        <div class="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
          <LoaderCircle class="size-4 animate-spin" />
          {$t('search.source.searching')}
        </div>
      {:else if !currentSearchState.results.length}
        <p class="px-2 py-8 text-center text-sm text-muted-foreground">
          {$t('search.source.empty')}
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
              <p class="mt-1.5 truncate text-[12px] text-muted-foreground">{result.url}</p>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </aside>
</div>
