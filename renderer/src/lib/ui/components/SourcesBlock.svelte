<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { ChevronRight, Globe } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'];
    meta?: SearchMeta | null;
  }

  let { sources = [], searchMode = 'chat', meta = null }: Props = $props();

  function openSourcesSidebar() {
    appStore.openSearchSidebarWithResults(sources || []);
  }
</script>

{#if sources?.length}
  <div class="mb-3 flex">
    <button
      class="source-toggle inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
      onclick={openSourcesSidebar}
    >
      <Globe class="h-4 w-4" />
      {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      <ChevronRight class="h-3.5 w-3.5 opacity-60" />
    </button>
  </div>
{/if}

<style>
  .source-toggle {
    letter-spacing: -0.01em;
  }
</style>
