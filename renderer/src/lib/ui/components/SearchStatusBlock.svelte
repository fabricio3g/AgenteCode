<script lang="ts">
  import type { SearchMeta } from '$lib/types/chat';
  import { Globe } from 'lucide-svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { getSearchStatus, providerLabel } from '../message-utils';

  interface Props {
    meta?: SearchMeta | null;
  }

  let { meta = null }: Props = $props();
  const status = $derived(getSearchStatus(meta));
  const researchSummary = $derived(meta?.researchSummary?.trim() || '');
  const summaryHtml = $derived(researchSummary ? renderMarkdown(researchSummary) : '');
  const provider = $derived.by(() => {
    const label = providerLabel(meta?.providerUsed || meta?.requestedProvider || '');
    return label.toLowerCase() === 'auto' ? '' : label;
  });
  const sourceCount = $derived(Number(meta?.sourceCount || 0));
</script>

{#if status}
  {#if researchSummary}
    <div class="research-summary mb-4">
      <div class="markdown-body">{@html summaryHtml}</div>
      {#if provider || sourceCount > 0}
        <div class="research-meta">
          {#if provider}
            <span class="meta-item"><Globe class="h-3 w-3" />{provider}</span>
          {/if}
          {#if sourceCount > 0}
            <span class="meta-item">{sourceCount} {sourceCount === 1 ? 'source' : 'sources'}</span>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="search-status mb-3">
      <span class="status-title">{status.title}</span>
      {#if status.detail}
        <span class="status-detail">{status.detail}</span>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .research-summary {
    border-left: 2px solid var(--border);
    padding-left: 1rem;
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

  .research-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .search-status {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }

  .status-title {
    color: var(--text-secondary);
    font-weight: 500;
  }

  .status-detail {
    color: var(--text-muted);
  }
</style>
