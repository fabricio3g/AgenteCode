<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Globe, ExternalLink } from 'lucide-svelte';
  import { domainLabel, faviconUrl } from '../message-utils';
  import { openWebviewer } from '$lib/services/search';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'];
    meta?: SearchMeta | null;
  }

  let { sources = [], searchMode = 'chat', meta = null }: Props = $props();

  let expanded = $state(true);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function updateScroll() {
    if (!scroller) return;
    canScrollLeft = scroller.scrollLeft > 4;
    canScrollRight = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4;
  }

  function scroll(dir: 'left' | 'right') {
    if (!scroller) return;
    scroller.scrollBy({ left: dir === 'left' ? -200 : 200, behavior: 'smooth' });
    setTimeout(updateScroll, 300);
  }

  function observeOverflow(node: HTMLElement) {
    const check = () => {
      canScrollLeft = node.scrollLeft > 4;
      canScrollRight = node.scrollLeft + node.clientWidth < node.scrollWidth - 4;
    };
    requestAnimationFrame(check);
    const ro = new ResizeObserver(check);
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }

  async function handleSourceClick(source: { url: string; title: string }) {
    try {
      await openWebviewer(source.url, source.title);
    } catch (e) {
      console.error('Failed to open webviewer:', e);
      window.open(source.url, '_blank', 'noreferrer');
    }
  }
</script>

{#if sources?.length}
  <div class="mb-3">
    <button
      class="source-toggle flex items-center gap-1.5 py-1 text-sm font-medium text-[var(--text-secondary)] transition hover:text-[var(--text)]"
      onclick={() => (expanded = !expanded)}
    >
      <Globe class="h-4 w-4" />
      {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      {#if expanded}
        <ChevronUp class="h-3.5 w-3.5 opacity-60" />
      {:else}
        <ChevronDown class="h-3.5 w-3.5 opacity-60" />
      {/if}
    </button>

    {#if expanded}
      <div class="relative mt-2" transition:slide={{ duration: 200, easing: quintOut }}>
        {#if canScrollLeft}
          <button
            class="scroll-btn absolute left-0 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--text-secondary)] shadow-sm transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
            onclick={() => scroll('left')}
            aria-label="Scroll sources left"
          >
            <ChevronLeft class="h-4 w-4" />
          </button>
        {/if}
        {#if canScrollRight}
          <button
            class="scroll-btn absolute right-0 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--text-secondary)] shadow-sm transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
            onclick={() => scroll('right')}
            aria-label="Scroll sources right"
          >
            <ChevronRight class="h-4 w-4" />
          </button>
        {/if}
        <div
          bind:this={scroller}
          onscroll={updateScroll}
          class="flex gap-2 overflow-x-auto pb-1"
          style="scrollbar-width:none"
          use:observeOverflow
        >
          {#each sources as source, index (`${source.url}-${index}`)}
            <button
              class="source-card group flex w-44 shrink-0 flex-col gap-2 rounded-xl px-3 py-2.5 text-left transition-colors cursor-pointer"
              title={source.title}
              onclick={() => handleSourceClick(source)}
            >
              <div class="flex items-center gap-2">
                {#if faviconUrl(source.url)}
                  <img src={faviconUrl(source.url)} alt="" class="h-4 w-4 rounded-sm" onerror={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />
                {:else}
                  <Globe class="h-4 w-4 text-[var(--text-muted)]" />
                {/if}
                <span class="source-domain flex-1 truncate text-xs text-[var(--text-muted)]">{domainLabel(source.url)}</span>
                <ExternalLink class="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
              </div>
              <p class="source-title line-clamp-2 text-sm font-medium leading-5 text-[var(--text)]">{source.title}</p>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .source-toggle {
    letter-spacing: -0.01em;
  }

  .source-card {
    background: var(--surface);
    border: 1px solid var(--border);
  }

  .source-card:hover {
    background: var(--surface-highlight);
    border-color: color-mix(in srgb, var(--border) 140%, transparent);
  }

  .source-card:hover .source-title {
    color: var(--text);
  }

  .source-card:hover .source-domain {
    color: var(--text-secondary);
  }
</style>
