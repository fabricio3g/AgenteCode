<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { Globe } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'];
    meta?: SearchMeta | null;
    messageId?: string;
  }

  let { sources = [], searchMode = 'chat', meta = null, messageId = '' }: Props = $props();

  const modeLabel = $derived(
    searchMode === 'max' ? 'Max' : searchMode === 'deep' ? 'Deep' : searchMode === 'search' ? 'Search' : ''
  );
  const sourceCount = $derived.by(() => {
    const seen = new Set<string>();
    for (const source of sources || []) {
      const key = String(source.url || source.title || '')
        .trim()
        .toLowerCase()
        .replace(/#.*$/, '');
      if (key) seen.add(key);
    }
    return seen.size || sources?.length || 0;
  });
  const isOpen = $derived(
    appStore.activityDrawerOpen &&
      appStore.activityMessageId === messageId &&
      appStore.activityDrawerTab === 'sources'
  );

  function stopBubble(event: Event) {
    event.stopPropagation();
  }

  function openSources(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (messageId) appStore.openActivityDrawer(messageId, 'sources');
  }
</script>

{#if sourceCount}
  <div class="sources-block">
    <button
      type="button"
      class="source-trigger"
      aria-expanded={isOpen}
      onpointerdown={stopBubble}
      onmousedown={stopBubble}
      onclick={openSources}
    >
      <Globe class="h-3.5 w-3.5 shrink-0 opacity-70" />
      {#if modeLabel}
        <span class="source-mode">{modeLabel}</span>
        <span class="source-sep" aria-hidden="true">·</span>
      {/if}
      <span class="source-count">{sourceCount} source{sourceCount === 1 ? '' : 's'}</span>
      <span class="source-open">View</span>
    </button>
  </div>
{/if}

<style>
  .sources-block {
    margin: 0.35rem 0 0.55rem;
  }

  .source-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 100%;
    padding: 0.2rem 0;
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 0.78rem;
    line-height: 1.35;
    transition: color 0.15s ease;
  }

  .source-trigger:hover,
  .source-trigger:focus-visible {
    color: var(--foreground);
    outline: none;
  }

  .source-mode {
    font-weight: 650;
    color: inherit;
  }

  .source-sep {
    opacity: 0.55;
  }

  .source-count {
    font-weight: 500;
  }

  .source-open {
    margin-left: 0.1rem;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
    text-underline-offset: 3px;
    font-weight: 500;
  }
</style>
