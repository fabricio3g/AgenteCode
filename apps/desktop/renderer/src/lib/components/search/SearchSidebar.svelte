<svelte:options runes={true} />

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, Tooltip } from '$lib/components/ui';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { LoaderCircle, Search as SearchIcon, X } from '$lib/icons';
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
  <div class="absolute inset-0" transition:motionFade={{ duration: 160 }}>
  <Button variant="plain"
    type="button"
    class="absolute inset-0 h-full w-full bg-overlay"
    aria-label={$t('search.source.closeLabel')}
    onclick={closeSidebar}
  ></Button>
  </div>

  <aside
    class="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-border bg-background shadow-lg"
    transition:motionFly={{ x: 24, duration: 220 }}
  >
    <header class="flex shrink-0 items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-foreground">{$t('search.source.title')}</h2>
      <Tooltip label={$t('common.close')} position="bottom"><UiIconButton label={$t('common.close')} size="sm" type="button"  onclick={closeSidebar} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </header>

    <div class="shrink-0 px-3 pb-3">
      <div class="flex items-center gap-2">
        <UiInput
          type="text"
          class={uiClass(" flex-1")}
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
        <p class="px-2 py-3 text-sm text-muted-foreground">
          {$t('search.source.empty')}
        </p>
      {:else}
        <div class="flex flex-col gap-0.5">
          {#each currentSearchState.results as result (result.url)}
            <Button variant="plain"
              type="button"
              class={uiClass("w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted")}
              onclick={() => openResult(result.url)}
            >
              <p class="line-clamp-2 text-sm font-medium text-foreground">{result.title || result.url}</p>
              {#if result.snippet}
                <p class="mt-1 line-clamp-3 text-xs text-muted-foreground">{result.snippet}</p>
              {/if}
              <p class="mt-1.5 truncate text-[length:var(--text-xs)] text-muted-foreground">{result.url}</p>
            </Button>
          {/each}
        </div>
      {/if}
    </div>
  </aside>
</div>
