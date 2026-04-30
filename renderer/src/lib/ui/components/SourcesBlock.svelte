<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { ExternalLink, XCircle } from 'lucide-svelte';
  import { fade, slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { faviconUrl, domainLabel } from '$lib/ui/message-utils';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'];
    meta?: SearchMeta | null;
  }

  let { sources = [], searchMode = 'chat', meta = null }: Props = $props();

  let open = $state(false);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let hoveredSource: (typeof sources)[number] | null = null;

  function toggle() {
    open = !open;
  }

  function onSourceHover(source: (typeof sources)[number]) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoveredSource = source;
    }, 150);
  }

  function onSourceLeave() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoveredSource = null;
  }

  function hideOnError(e: Event) {
    (e.currentTarget as HTMLElement).style.display = 'none';
  }
</script>

{#if sources?.length}
  <div class="sources-block">
    <div class="source-pills" onclick={toggle}>
      <div class="pill-stack">
        {#each sources as source, i}
          <img
            class="pill-favicon"
            src={faviconUrl(source.url)}
            alt=""
            loading="lazy"
            style={`z-index: ${sources.length - i}; --pill-offset: ${i * 5}px`}
            onerror={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')}
          />
        {/each}
      </div>
      <span class="source-count">{sources.length}</span>
    </div>

    {#if open}
      <div class="source-list" transition:slide={{ duration: 150, easing: cubicOut }}>
        {#each sources as source, i}
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            class="source-item"
            onmouseenter={() => onSourceHover(source)}
            onmouseleave={onSourceLeave}
          >
            <img class="source-favicon" src={faviconUrl(source.url)} alt="" loading="lazy" onerror={hideOnError} />
            <span class="source-text">
              <span class="source-title">{source.title || source.url}</span>
              <span class="source-domain">{domainLabel(source.url)}</span>
            </span>
            <ExternalLink class="source-link-icon h-3 w-3" />
          </a>
        {/each}
      </div>
    {/if}

    <!-- Hover popover card -->
    {#if hoveredSource}
      <div
        class="source-popover"
        transition:fade={{ duration: 100 }}
        onmouseenter={() => {}}
        onmouseleave={onSourceLeave}
      >
        <img class="popover-favicon" src={faviconUrl(hoveredSource.url)} alt="" loading="lazy" onerror={hideOnError} />
        <span class="popover-domain">{domainLabel(hoveredSource.url)}</span>
        <span class="popover-title">{hoveredSource.title || hoveredSource.url}</span>
        {#if hoveredSource.snippet}
          <span class="popover-desc">{hoveredSource.snippet}</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .sources-block {
    position: relative;
    margin-bottom: 0.5rem;
  }

  .source-pills {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .pill-stack {
    position: relative;
    display: flex;
    align-items: center;
    width: calc(1rem + 10px);
    height: 1rem;
  }

  .pill-favicon {
    position: absolute;
    width: 1rem;
    height: 1rem;
    border-radius: 9999px;
    border: 1.5px solid var(--chat-bg, var(--background));
    background: var(--surface);
    transform: translateX(var(--pill-offset, 0));
    transition: transform 0.2s ease;
    object-fit: cover;
  }

  .source-count {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .source-list {
    margin-top: 0.375rem;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .source-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-sm);
    text-decoration: none;
    transition: background 0.12s ease;
    cursor: pointer;
  }
  .source-item:hover {
    background: var(--surface-hover);
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

  .source-link-icon {
    flex-shrink: 0;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .source-item:hover .source-link-icon {
    opacity: 1;
  }

  /* Hover popover card */
  .source-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 300px;
    max-width: 360px;
    padding: 0.75rem 0.875rem;
    border-radius: var(--radius-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-xl);
    pointer-events: auto;
    animation: popoverSlideIn 150ms ease-out;
  }

  @keyframes popoverSlideIn {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .popover-favicon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
  }

  .popover-domain {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .popover-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.35;
  }

  .popover-desc {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
