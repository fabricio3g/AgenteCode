<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { ExternalLink, Globe, X } from 'lucide-svelte';
  import { fade } from 'svelte/transition';
  import { faviconUrl, domainLabel, providerLabel } from '$lib/ui/message-utils';
  import Portal from './Portal.svelte';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'];
    meta?: SearchMeta | null;
  }

  let { sources = [], searchMode = 'chat', meta = null }: Props = $props();

  let open = $state(false);
  const provider = $derived(providerLabel(meta?.providerUsed || meta?.requestedProvider || ''));
  const modeLabel = $derived(searchMode === 'deep' || searchMode === 'max' ? 'Deep research' : 'Web search');
  const attempts = $derived(meta?.providerAttempts || []);
  const warningText = $derived([
    meta?.searchError,
    meta?.searchFallbackReason,
    ...(meta?.providerWarnings || [])
  ].filter(Boolean).join(' '));

  function hideOnError(e: Event) {
    (e.currentTarget as HTMLElement).style.display = 'none';
  }

  function stopBubble(event: Event) {
    event.stopPropagation();
  }

  function openSources(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    open = true;
  }

  function closeSources(event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    open = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      open = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if sources?.length}
  <div class="sources-block">
    <button
      type="button"
      class="source-trigger"
      aria-expanded={open}
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

    {#if open}
      <Portal className="source-portal">
        <div class="source-modal-layer" transition:fade={{ duration: 120 }}>
          <button class="source-scrim" aria-label="Close sources" onclick={closeSources}></button>
        </div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="source-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Sources"
          tabindex="-1"
          transition:fade={{ duration: 120 }}
          onpointerdown={stopBubble}
        >
          <header class="drawer-header">
            <div>
              <div class="drawer-title">{modeLabel}</div>
              <div class="drawer-subtitle">
                {sources.length} source{sources.length === 1 ? '' : 's'}{#if provider && provider.toLowerCase() !== 'auto'} · {provider}{/if}
              </div>
            </div>
            <button type="button" class="drawer-close" onclick={closeSources} aria-label="Close sources" title="Close">
              <X class="h-4 w-4" />
            </button>
          </header>

          {#if warningText}
            <p class="drawer-warning">{warningText}</p>
          {/if}

          {#if attempts.length}
            <div class="attempts">
              {#each attempts as attempt}
                <span class="attempt" class:failed={!attempt.success}>
                  {providerLabel(attempt.provider)} · {attempt.resultCount}
                </span>
              {/each}
            </div>
          {/if}

          <div class="source-list">
            {#each sources as source, index}
              <a href={source.url} target="_blank" rel="noopener noreferrer" class="source-item">
                <span class="source-index">{index + 1}</span>
                <img class="source-favicon" src={faviconUrl(source.url)} alt="" loading="lazy" onerror={hideOnError} />
                <span class="source-text">
                  <span class="source-title">{source.title || source.url}</span>
                  <span class="source-domain">{domainLabel(source.url)}</span>
                  {#if source.snippet}
                    <span class="source-snippet">{source.snippet}</span>
                  {/if}
                </span>
                <ExternalLink class="source-link-icon h-3.5 w-3.5" />
              </a>
            {/each}
          </div>
        </div>
      </Portal>
    {/if}
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

  .source-modal-layer {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: block;
    pointer-events: none;
  }

  .source-scrim {
    position: absolute;
    inset: 0;
    pointer-events: auto;
    border: 0;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.18);
    box-shadow: none;
  }

  .source-modal {
    position: fixed;
    top: 50%;
    right: max(1rem, env(safe-area-inset-right));
    transform: translateY(-50%);
    z-index: 10001;
    width: min(25rem, 92vw);
    max-height: min(44rem, calc(100vh - 2rem));
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1rem;
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow: var(--shadow-xl);
  }

  @media (max-width: 640px) {
    .source-modal {
      inset: auto 0 0 0;
      width: 100vw;
      max-height: 82vh;
      transform: none;
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: 1rem 1rem 0 0;
    }
  }

  .source-list {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-height: 0;
    overflow: auto;
  }

  .source-item {
    display: grid;
    grid-template-columns: 1.4rem 1rem minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.55rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    text-decoration: none;
    color: inherit;
    transition: color 0.12s ease;
    cursor: pointer;
  }
  .source-item:hover {
    color: var(--text);
  }

  .source-index {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .source-favicon {
    width: 16px;
    height: 16px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .source-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .source-title {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source-domain {
    font-size: 0.65rem;
    color: var(--text-muted);
  }

  .source-snippet {
    margin-top: 0.2rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.45;
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  :global(.source-link-icon) {
    margin-top: 0.1rem;
    color: var(--text-muted);
  }

  .drawer-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .drawer-title {
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--text);
  }

  .drawer-subtitle,
  .drawer-warning {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .drawer-warning {
    margin: 0;
    color: var(--warning);
  }

  .drawer-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.8rem;
    height: 1.8rem;
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
  }

  .attempts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .attempt {
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .attempt.failed {
    color: var(--error);
  }
</style>
