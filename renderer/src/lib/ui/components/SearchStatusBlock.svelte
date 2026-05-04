<script lang="ts">
  import type { SearchMeta } from '$lib/types/chat';
  import { AlertCircle, Globe } from 'lucide-svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { getSearchStatus } from '../message-utils';

  interface Props {
    meta?: SearchMeta | null;
  }

  let { meta = null }: Props = $props();
  const status = $derived(getSearchStatus(meta));
  const researchSummary = $derived(meta?.researchSummary?.trim() || '');
  const summaryHtml = $derived(researchSummary ? renderMarkdown(researchSummary) : '');
  const sourceCount = $derived(Number(meta?.sourceCount || 0));
  const crawlPages = $derived(Number(meta?.researchStats?.pagesCrawled || 0));
  const crawlDepth = $derived(Number(meta?.researchStats?.maxDepthReached || 0));
</script>

{#if status}
  {#if researchSummary}
    <div class="research-summary">
      <div class="summary-trigger">
        <Globe class="h-3.5 w-3.5" />
        <span class="summary-title">Research</span>
        <span class="summary-meta">
          {#if sourceCount > 0}{sourceCount} src{/if}
          {#if crawlPages > 0} · {crawlPages} pages{/if}
          {#if crawlDepth > 0} · d{crawlDepth}{/if}
        </span>
      </div>
      <div class="summary-inline markdown-body">{@html summaryHtml}</div>
    </div>
  {:else}
    <div class="search-status">
      <AlertCircle class="h-3.5 w-3.5" />
      <span class="status-title">{status.title}</span>
      {#if status.detail}
        <span class="status-detail">{status.detail}</span>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .research-summary {
    display: grid;
    gap: 0.35rem;
    margin: 0.25rem 0 0.7rem;
  }

  .summary-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 0;
    background: transparent;
    border-radius: 0;
    color: var(--text-secondary);
    padding: 0;
    max-width: fit-content;
    font-size: 0.77rem;
    box-shadow: none;
  }

  .summary-trigger:hover {
    color: var(--text);
  }

  .summary-title {
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .summary-meta {
    color: var(--text-muted);
    font-size: 0.72rem;
  }

  .summary-inline {
    border-left: 1px solid var(--border);
    padding-left: 0.75rem;
    color: var(--text-secondary);
  }

  .research-summary :global(.markdown-body) {
    font-size: 0.9375rem;
    line-height: 1.7;
  }

  .research-summary :global(.markdown-body > :first-child) {
    margin-top: 0;
  }

  .research-summary :global(.markdown-body > :last-child) {
    margin-bottom: 0;
  }

  .research-summary :global(.markdown-body h1),
  .research-summary :global(.markdown-body h2),
  .research-summary :global(.markdown-body h3) {
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .research-summary :global(.markdown-body h1) {
    font-size: 1.125rem;
  }

  .research-summary :global(.markdown-body h2) {
    font-size: 1rem;
  }

  .research-summary :global(.markdown-body h3) {
    font-size: 0.9375rem;
  }

  .search-status {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8125rem;
    margin: 0.25rem 0 0.7rem;
    color: var(--text-muted);
  }

  .status-title {
    color: var(--text-secondary);
    font-weight: 500;
  }

  .status-detail {
    color: var(--text-muted);
  }
</style>
