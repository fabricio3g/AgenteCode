<svelte:options runes={true} />

<script lang="ts">
  import { LoaderCircle, Search as SearchIcon, X } from 'lucide-svelte';
  import { fade, fly } from 'svelte/transition';
  import { appStore } from '$lib/stores/app.svelte';
  import { openWebviewer } from '$lib/services/search';

  let query = $state('');

  function closeSidebar() {
    appStore.searchSidebarOpen = false;
  }

  async function runSearch() {
    await appStore.performWebSearch(query);
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

<div class="fixed inset-0 z-[260]">
  <button
    class="absolute inset-0 h-full w-full bg-black/35"
    aria-label="Close source search"
    transition:fade={{ duration: 160 }}
    onclick={closeSidebar}
  ></button>

  <aside
    class="absolute right-0 top-0 h-full w-full max-w-[420px] border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-xl)]"
    transition:fly={{ x: 24, duration: 220 }}
  >
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 class="text-sm font-semibold tracking-wide text-[var(--text)]">Source Search</h2>
        <button class="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]" onclick={closeSidebar} aria-label="Close">
          <X class="h-4 w-4" />
        </button>
      </div>

      <div class="border-b border-[var(--border)] p-3">
        <div class="flex items-center gap-2">
          <input
            type="text"
            class="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--border-strong)]"
            placeholder="Search the web sources..."
            bind:value={query}
            onkeydown={(event) => { if (event.key === 'Enter') void runSearch(); }}
          />
          <button
            class="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--border)] px-3 text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
            onclick={runSearch}
            disabled={appStore.searchLoading}
            aria-label="Run source search"
            title="Run search"
          >
            {#if appStore.searchLoading}
              <LoaderCircle class="h-4 w-4 animate-spin" />
            {:else}
              <SearchIcon class="h-4 w-4" />
            {/if}
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        {#if appStore.searchLoading}
          <div class="flex items-center gap-2 px-1 py-2 text-sm text-[var(--text-muted)]">
            <LoaderCircle class="h-4 w-4 animate-spin" />
            Searching...
          </div>
        {:else if !appStore.searchResults.length}
          <p class="px-1 py-2 text-sm text-[var(--text-muted)]">No results yet. Run a search to populate sources.</p>
        {:else}
          <div class="space-y-2">
            {#each appStore.searchResults as result (result.url)}
              <button
                class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition hover:bg-[var(--surface-highlight)]"
                onclick={() => openResult(result.url)}
              >
                <p class="line-clamp-2 text-sm font-semibold text-[var(--text)]">{result.title || result.url}</p>
                {#if result.snippet}
                  <p class="mt-1 line-clamp-3 text-xs text-[var(--text-secondary)]">{result.snippet}</p>
                {/if}
                <p class="mt-2 truncate text-[11px] text-[var(--text-muted)]">{result.url}</p>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </aside>
</div>
