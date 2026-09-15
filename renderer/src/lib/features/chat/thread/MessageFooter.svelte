<svelte:options runes={true} />

<!--
  One quiet row under an assistant answer.

  This replaces four stacked blocks that each drew their own strip of chrome:
  a context-badge row, a sources trigger, a five-chip research export bar, and a
  search-status line — followed by a separate token/speed line. On a Deep
  research answer that was five full-width rows of furniture under the text, two
  of which reported the same source count.

  Everything now sits on one line: work context, sources, the research brief,
  a warning chip when something actually went wrong, exports behind a menu, and
  the run stats. Anything with more to say opens the activity drawer or expands
  in place.
-->

<script lang="ts">
  import { AlertCircle, BriefcaseBusiness, ChevronDown, Download, Globe } from 'lucide-svelte';
  import { slide } from 'svelte/transition';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
  import { formatCount, formatDuration } from '$lib/utils/format';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { getSearchStatus } from '$lib/ui/message-utils';
  import { Menu, MenuItem } from '$lib/components/ui';
  import {
    buildResearchExportFiles,
    downloadResearchExportFile,
    suggestedExportKinds,
    type ResearchExportKind
  } from '$lib/services/research-artifacts';
  import { useMessage } from './message-context';
  import { hasSearchStatus } from './message-parts';

  const ctx = useMessage();

  let briefOpen = $state(false);
  let exportMenuOpen = $state(false);
  let exportError = $state('');

  // Sources are de-duplicated by URL: providers routinely return the same page
  // twice, and a count that disagrees with the drawer's list is worse than none.
  const sourceCount = $derived.by(() => {
    const seen = new Set<string>();
    for (const source of ctx.message.sources || []) {
      const key = String(source.url || source.title || '')
        .trim()
        .toLowerCase()
        .replace(/#.*$/, '');
      if (key) seen.add(key);
    }
    return seen.size || ctx.message.sources?.length || 0;
  });

  const searchModeLabel = $derived(
    ctx.message.searchMode === 'max'
      ? 'Max'
      : ctx.message.searchMode === 'deep'
        ? 'Deep'
        : ctx.message.searchMode === 'search'
          ? 'Search'
          : ''
  );
  const isResearch = $derived(!!searchModeLabel);

  const workContext = $derived(ctx.message.workContext);

  const researchBrief = $derived(ctx.displaySearchMeta?.researchSummary?.trim() || '');
  const briefHtml = $derived(researchBrief ? renderMarkdown(researchBrief) : '');

  // A status line is only worth a slot when it says something the source count
  // doesn't already imply.
  const status = $derived(
    hasSearchStatus(ctx.displaySearchMeta, sourceCount > 0) && !researchBrief
      ? getSearchStatus(ctx.displaySearchMeta)
      : null
  );

  const exportKinds = $derived(
    isResearch && sourceCount > 0 ? suggestedExportKinds(ctx.message.searchMode) : []
  );

  const EXPORT_LABELS: Record<ResearchExportKind, string> = {
    shortlist: 'Source shortlist',
    citations: 'Citations',
    matrix: 'Evidence matrix',
    bibliography: 'Bibliography',
    protocol: 'Search protocol'
  };

  const exportTitle = $derived(
    ctx.message.content?.split('\n').find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') ||
      'Research'
  );

  // Output tokens and generation speed — not total prompt tokens, and only when
  // the provider or runtime actually reported usage rather than estimating it.
  const stats = $derived.by(() => {
    const meta = ctx.footerMetadata;
    if (!meta) return null;
    if (meta.usageSource !== 'provider' && meta.usageSource !== 'runtime') return null;

    const tokens = meta.outputTokens ?? meta.tokens ?? 0;
    const elapsed = formatDuration(meta.totalElapsedSeconds);
    const rate = meta.tokensPerSecond ? `${meta.tokensPerSecond.toFixed(0)} tok/s` : '';

    const segments = [
      tokens ? `${formatCount(tokens)} ${copy.thread.outputTokens}` : '',
      rate,
      elapsed ? `${elapsed} total` : ''
    ].filter(Boolean);
    return segments.length ? segments.join(' · ') : null;
  });

  const hasAnything = $derived(
    !!workContext || sourceCount > 0 || !!researchBrief || !!status || !!stats
  );

  function openSources(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    appStore.openActivityDrawer(ctx.message.id, 'sources');
  }

  function runExport(kind: ResearchExportKind) {
    exportMenuOpen = false;
    exportError = '';
    const sources = ctx.message.sources;
    if (!sources?.length) {
      exportError = 'No sources to export yet.';
      return;
    }
    try {
      const files = buildResearchExportFiles({
        sources,
        kinds: [kind],
        title: exportTitle,
        query: exportTitle,
        searchMode: ctx.message.searchMode,
        meta: ctx.displaySearchMeta
      });
      if (!files.length) {
        exportError = 'Nothing to export from these sources.';
        return;
      }
      for (const file of files) downloadResearchExportFile(file);
    } catch (err) {
      exportError = err instanceof Error ? err.message : 'Export failed.';
    }
  }
</script>

{#if hasAnything}
  <div class="message-footer">
    <div class="footer-row">
      {#if workContext}
        <span class="footer-pill work" title={workContext.rootName}>
          <BriefcaseBusiness class="size-3" />
          {say.files(workContext.indexedCount)}
        </span>
      {/if}

      {#if sourceCount > 0}
        <button type="button" class="footer-action" onclick={openSources}>
          <Globe class="size-3.5 shrink-0 opacity-70" />
          {#if searchModeLabel}<span class="footer-strong">{searchModeLabel}</span>
            <span class="footer-sep" aria-hidden="true">·</span>{/if}
          <span>{say.sources(sourceCount)}</span>
        </button>
      {/if}

      {#if researchBrief}
        <button
          type="button"
          class="footer-action"
          aria-expanded={briefOpen}
          onclick={() => (briefOpen = !briefOpen)}
        >
          <span class="footer-strong">Research brief</span>
          <ChevronDown class="size-3 shrink-0 opacity-60 transition-transform {briefOpen ? 'rotate-180' : ''}" />
        </button>
      {/if}

      {#if status}
        <span class="footer-warning" title={status.detail}>
          <AlertCircle class="size-3.5 shrink-0" />
          {status.title}
        </span>
      {/if}

      {#if exportKinds.length}
        <Menu bind:open={exportMenuOpen} placement="top-start" label="Research exports" minWidth="11rem">
          {#snippet trigger(props)}
            <button type="button" class="footer-action" {...props}>
              <Download class="size-3 shrink-0 opacity-70" />
              {copy.actions.export}
            </button>
          {/snippet}
          {#each exportKinds as kind (kind)}
            <MenuItem label={EXPORT_LABELS[kind]} onselect={() => runExport(kind)} />
          {/each}
        </Menu>
      {/if}

      {#if stats}
        <span class="footer-stats">{stats}</span>
      {/if}
    </div>

    {#if briefOpen && briefHtml}
      <div class="footer-brief markdown-body" transition:slide={{ duration: 140 }}>
        {@html briefHtml}
      </div>
    {/if}

    {#if exportError}
      <span class="footer-error">{exportError}</span>
    {/if}
  </div>
{/if}

<style>
  .message-footer {
    margin-top: 0.4rem;
  }

  .footer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
    font-size: 0.78rem;
    color: var(--muted-foreground);
  }

  .footer-action {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    line-height: 1.35;
    transition: color 0.15s ease;
  }

  .footer-action:hover,
  .footer-action:focus-visible {
    color: var(--foreground);
    outline: none;
  }

  .footer-strong {
    font-weight: 650;
  }

  .footer-sep {
    opacity: 0.55;
  }

  .footer-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--muted);
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .footer-pill.work {
    color: var(--work-accent-strong);
    background: var(--work-accent-soft);
  }

  .footer-warning {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--warning);
    font-weight: 500;
  }

  .footer-stats {
    margin-left: auto;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }

  .footer-brief {
    margin-top: 0.4rem;
    padding: 0.55rem 0.65rem;
    border-radius: var(--radius-md);
    background: var(--artifact-surface);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .footer-error {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: var(--error);
  }
</style>
