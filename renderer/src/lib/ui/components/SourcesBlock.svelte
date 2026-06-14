<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { Globe } from 'lucide-svelte';
  import { providerLabel } from '$lib/ui/message-utils';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'];
    meta?: SearchMeta | null;
    messageId?: string;
  }

  let { sources = [], searchMode = 'chat', meta = null, messageId = '' }: Props = $props();

  const provider = $derived(providerLabel(meta?.providerUsed || meta?.requestedProvider || ''));
  const modeLabel = $derived(searchMode === 'max' ? 'Max search' : searchMode === 'deep' ? 'Deep search' : 'Web search');
  const isOpen = $derived(appStore.activityDrawerOpen && appStore.activityMessageId === messageId && appStore.activityDrawerTab === 'sources');

  function stopBubble(event: Event) {
    event.stopPropagation();
  }

  function openSources(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (messageId) appStore.openActivityDrawer(messageId, 'sources');
  }
</script>

{#if sources?.length}
  <div class="sources-block">
    <button
      type="button"
      class="source-trigger"
      aria-expanded={isOpen}
      onpointerdown={stopBubble}
      onmousedown={stopBubble}
      onclick={openSources}
    >
      <Globe class="h-3.5 w-3.5 shrink-0" />
      <span class="source-titleline">{modeLabel}</span>
      <span class="source-count">{sources.length} sources</span>
      {#if provider && provider.toLowerCase() !== 'auto'}
        <span class="source-provider">{provider}</span>
      {/if}
      <span class="source-open">Sources</span>
    </button>
  </div>
{/if}

<style>
  .sources-block {
    position: relative;
    margin: 0.25rem 0 0.7rem;
  }

  .source-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.42rem;
    max-width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.76rem;
    line-height: 1.4;
    box-shadow: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: color 0.15s ease;
  }

  .source-trigger:active,
  .source-trigger:focus {
    background: transparent;
    color: var(--text-secondary);
    outline: none;
  }

  .source-trigger:focus-visible {
    color: var(--text);
    outline: 1px solid color-mix(in srgb, var(--text-muted) 45%, transparent);
    outline-offset: 3px;
  }

  .source-trigger:hover {
    color: var(--text);
  }

  .source-titleline {
    font-weight: 600;
    color: var(--text-secondary);
  }

  .source-count {
    font-weight: 500;
    color: var(--text-muted);
  }

  .source-provider {
    min-width: 0;
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .source-open {
    color: var(--text-muted);
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 3px;
  }

</style>
