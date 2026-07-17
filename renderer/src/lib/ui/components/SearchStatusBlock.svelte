<script lang="ts">
  import type { SearchMeta } from '$lib/types/chat';
  import { AlertCircle, ChevronDown, Globe } from 'lucide-svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { getSearchStatus } from '../message-utils';
  import { slide } from 'svelte/transition';

  interface Props {
    meta?: SearchMeta | null;
    /** When true, hide status if it only repeats sources (answer already present). */
    hasAnswer?: boolean;
    hasSources?: boolean;
  }

  let { meta = null, hasAnswer = false, hasSources = false }: Props = $props();
  const status = $derived(getSearchStatus(meta));
  const researchSummary = $derived(meta?.researchSummary?.trim() || '');
  const summaryHtml = $derived(researchSummary ? renderMarkdown(researchSummary) : '');
  const sourceCount = $derived(Number(meta?.sourceCount || 0));
  const crawlPages = $derived(Number(meta?.researchStats?.pagesCrawled || 0));
  const crawlDepth = $derived(Number(meta?.researchStats?.maxDepthReached || 0));

  let briefOpen = $state(false);

  // Hide thin status when answer + sources already carry the story
  const showErrorStatus = $derived(!!status && !researchSummary && !(hasAnswer && hasSources));
  const showBrief = $derived(!!researchSummary && (!hasAnswer || researchSummary.length > 120));
</script>

{#if showBrief}
  <div class="research-brief">
    <button type="button" class="brief-trigger" onclick={() => (briefOpen = !briefOpen)} aria-expanded={briefOpen}>
      <Globe class="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span class="brief-title">Research brief</span>
      <span class="brief-meta">
        {#if sourceCount > 0}{sourceCount} src{/if}
        {#if crawlPages > 0} · {crawlPages} pages{/if}
        {#if crawlDepth > 0} · d{crawlDepth}{/if}
      </span>
      <ChevronDown class={`h-3 w-3 shrink-0 opacity-60 transition-transform ${briefOpen ? 'rotate-180' : ''}`} />
    </button>
    {#if briefOpen}
      <div class="brief-body markdown-body" transition:slide={{ duration: 140 }}>
        {@html summaryHtml}
      </div>
    {/if}
  </div>
{:else if showErrorStatus && status}
  <div class="search-status">
    <AlertCircle class="h-3.5 w-3.5 shrink-0" />
    <span class="status-title">{status.title}</span>
    {#if status.detail}
      <span class="status-detail">{status.detail}</span>
    {/if}
  </div>
{/if}

<style>
  .research-brief {
    margin: 0.35rem 0 0.55rem;
  }

  .brief-trigger {
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
    transition: color 0.15s ease;
  }

  .brief-trigger:hover {
    color: var(--foreground);
  }

  .brief-title {
    font-weight: 650;
  }

  .brief-meta {
    font-size: 0.72rem;
    font-weight: 450;
    opacity: 0.9;
  }

  .brief-body {
    margin-top: 0.4rem;
    padding: 0.55rem 0.65rem;
    border-radius: var(--artifact-radius, var(--radius-md));
    background: var(--artifact-surface, color-mix(in srgb, var(--surface) 88%, var(--chat-bg)));
    color: var(--text-secondary);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .search-status {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.35rem 0 0.55rem;
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }

  .status-title {
    font-weight: 600;
  }

  .status-detail {
    opacity: 0.85;
  }
</style>
