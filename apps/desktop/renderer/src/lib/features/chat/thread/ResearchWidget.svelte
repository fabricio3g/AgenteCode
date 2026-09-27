<svelte:options runes={true} />

<!--
  Search, Deep and Max runs, as one widget at the top of the answer: what the
  assistant searched, which pages it read, the sources it found, the research
  brief and the exports. One quiet line while collapsed; it opens by itself
  while the research is running.
-->

<script lang="ts">
  import { ChevronDown, Download, FileText, Loader2, Search } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import type { AgentStep } from '$lib/types/chat';
  import type { SearchResult } from '$lib/types/bridge';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { formatDuration } from '$lib/utils/format';
  import {
    buildResearchExportFiles,
    downloadResearchExportFile,
    suggestedExportKinds,
    type ResearchExportKind
  } from '$lib/services/research-artifacts';
  import { useMessage } from './message-context';
  import { resolveTotalElapsed } from './message-parts';

  const ctx = useMessage();
  const SOURCES_SHOWN = 6;

  const mode = $derived(ctx.message.searchMode === 'max' ? 'max' : ctx.message.searchMode === 'deep' ? 'deep' : 'search');
  const running = $derived(ctx.message.status === 'streaming');
  const steps = $derived((ctx.message.agentSteps || []).filter((step) => !step.preface));

  // Sources de-duplicated by URL, in the order they were found.
  const sources = $derived.by(() => {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const source of ctx.message.sources || []) {
      const key = String(source.url || source.title || '').trim().toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
    return out;
  });

  type Row = { id: string; kind: 'search' | 'read' | 'other'; text: string; meta?: string; running: boolean; failed: boolean };
  const rows = $derived(
    steps
      .filter((step) => step.type !== 'thinking' && step.type !== 'planning' && step.type !== 'approval')
      .map((step): Row => {
        const isSearch = step.toolName === 'web_search' || step.type === 'searching';
        const isRead = step.toolName === 'fetch_url' || (step.type === 'reading' && !!step.research?.url);
        const runningStep = step.status === 'running' || step.status === 'pending';
        if (isSearch) {
          const query = step.research?.query || (runningStep ? step.detail : '') || '';
          const count = step.research?.results;
          return {
            id: step.id,
            kind: 'search',
            text: query,
            meta: typeof count === 'number' ? $t('research.results', { values: { n: count } }) : undefined,
            running: runningStep,
            failed: step.status === 'error'
          };
        }
        if (isRead) {
          const url = step.research?.url || '';
          return { id: step.id, kind: 'read', text: step.research?.title || hostOf(url) || step.detail || '', meta: hostOf(url), running: runningStep, failed: step.status === 'error' };
        }
        return { id: step.id, kind: 'other', text: step.label + (step.detail ? ` · ${step.detail}` : ''), running: runningStep, failed: step.status === 'error' };
      })
  );

  const searches = $derived(rows.filter((row) => row.kind === 'search').length);
  const reads = $derived(rows.filter((row) => row.kind === 'read').length);

  /** What is happening right now, for the collapsed line while running. */
  const phase = $derived.by(() => {
    const active = [...steps].reverse().find((step: AgentStep) => step.status === 'running');
    if (active?.toolName === 'web_search' || active?.type === 'searching') return $t('research.phase.searching');
    if (active?.toolName === 'fetch_url' || active?.type === 'reading') return $t('research.phase.reading');
    if (ctx.displayContent) return $t('research.phase.writing');
    return $t('research.phase.planning');
  });

  const elapsed = $derived(formatDuration(resolveTotalElapsed(ctx.message, ctx.displayMetadata)));
  const brief = $derived(ctx.displaySearchMeta?.researchSummary?.trim() || '');
  const briefHtml = $derived(brief ? renderMarkdown(brief) : '');
  const exportKinds = $derived(sources.length ? suggestedExportKinds(mode) : []);

  let open = $state(false);
  let userToggled = $state(false);
  let showAll = $state(false);
  let exportError = $state('');
  $effect(() => {
    // Open while researching; fold away once the answer is written.
    if (!userToggled) open = running;
  });

  function toggle() {
    userToggled = true;
    open = !open;
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function exportFiles(kind: ResearchExportKind) {
    exportError = '';
    const title = ctx.message.content?.split('\n').find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') || $t(`research.mode.${mode}`);
    try {
      const files = buildResearchExportFiles({ sources, kinds: [kind], title, query: title, searchMode: mode, meta: ctx.displaySearchMeta });
      if (!files.length) {
        exportError = $t('research.exportEmpty');
        return;
      }
      for (const file of files) downloadResearchExportFile(file);
    } catch (err) {
      exportError = err instanceof Error ? err.message : $t('research.exportFailed');
    }
  }

  const faviconFailed = $state<Record<string, boolean>>({});
</script>

{#snippet favicon(url: string, size = 'size-4')}
  {@const host = hostOf(url)}
  {#if host && !faviconFailed[host]}
    <img class="fav {size}" src={`https://${host}/favicon.ico`} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => (faviconFailed[host] = true)} />
  {:else}
    <span class="fav fav-letter {size}" aria-hidden="true">{(host || '?').charAt(0).toUpperCase()}</span>
  {/if}
{/snippet}

<section class="research" class:is-open={open}>
  <button type="button" class="research-head" onclick={toggle} aria-expanded={open}>
    {#if running}<Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" />{/if}
    <span class="research-title">{$t(`research.mode.${mode}`)}</span>
    <span class="research-meta">
      {#if running}
        {phase}
      {:else}
        {$t('research.sourcesCount', { values: { n: sources.length } })}{#if elapsed} · {elapsed}{/if}
      {/if}
    </span>
    {#if sources.length}
      <span class="fav-stack" aria-hidden="true">
        {#each sources.slice(0, 4) as source (source.url)}{@render favicon(source.url)}{/each}
      </span>
    {/if}
    <ChevronDown class="size-3.5 shrink-0 text-muted-foreground transition-transform {open ? 'rotate-180' : ''}" />
  </button>

  {#if open}
    <div class="research-body" transition:slide={{ duration: 160 }}>
      {#if rows.length}
        <ol class="timeline" aria-label={$t('research.steps')}>
          {#each rows as row (row.id)}
            <li class="step" class:is-failed={row.failed}>
              <span class="step-icon" aria-hidden="true">
                {#if row.running}<Loader2 class="size-3 animate-spin" />
                {:else if row.kind === 'search'}<Search class="size-3" />
                {:else if row.kind === 'read'}<FileText class="size-3" />
                {:else}<span class="dot"></span>{/if}
              </span>
              <span class="step-text">
                {#if row.kind === 'search'}
                  <span class="step-verb">{$t('research.searched')}</span> <span class="step-query">{row.text}</span>
                {:else if row.kind === 'read'}
                  <span class="step-verb">{$t('research.read')}</span> {row.text}
                {:else}
                  {row.text}
                {/if}
              </span>
              {#if row.meta && row.kind === 'search'}<span class="step-meta">{row.meta}</span>{/if}
            </li>
          {/each}
        </ol>
        <p class="summary-line">
          {$t('research.summary', { values: { searches, reads, sources: sources.length } })}
        </p>
      {/if}

      {#if sources.length}
        <ol class="sources" aria-label={$t('research.sourcesLabel')}>
          {#each showAll ? sources : sources.slice(0, SOURCES_SHOWN) as source, index (source.url)}
            <li>
              <a class="source" href={source.url} target="_blank" rel="noreferrer" title={source.url}>
                <span class="source-num">{index + 1}</span>
                {@render favicon(source.url, 'size-3.5')}
                <span class="min-w-0 flex-1">
                  <span class="source-title">{source.title || hostOf(source.url)}</span>
                  <span class="source-host">{hostOf(source.url)}</span>
                </span>
              </a>
            </li>
          {/each}
        </ol>
        {#if sources.length > SOURCES_SHOWN}
          <button type="button" class="link-btn" onclick={() => (showAll = !showAll)}>
            {showAll ? $t('research.showFewer') : $t('research.showAll', { values: { n: sources.length } })}
          </button>
        {/if}
      {/if}

      {#if briefHtml}
        <div class="brief">
          <p class="brief-label">{$t('research.brief')}</p>
          <div class="markdown-body">{@html briefHtml}</div>
        </div>
      {/if}

      {#if exportKinds.length && !running}
        <div class="exports">
          <Download class="size-3.5 shrink-0 text-muted-foreground" />
          {#each exportKinds as kind (kind)}
            <button type="button" class="chip" onclick={() => exportFiles(kind)}>{$t(`research.export.${kind}`)}</button>
          {/each}
        </div>
        {#if exportError}<p class="export-error">{exportError}</p>{/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .research {
    width: min(100%, 40rem);
    margin-bottom: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    background: var(--background);
    overflow: hidden;
  }
  .research-head {
    display: flex;
    width: 100%;
    min-height: 2.5rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.875rem;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .research-head:hover {
    background: var(--surface-hover);
  }
  .research-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--foreground);
    white-space: nowrap;
  }
  .research-meta {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .fav-stack {
    display: flex;
    flex-shrink: 0;
  }
  .fav-stack :global(.fav + .fav) {
    margin-left: -0.3rem;
  }
  .fav {
    flex-shrink: 0;
    padding: 1px;
    border-radius: 9999px;
    /* Site icons are drawn for light backgrounds; give them one in dark mode too. */
    background: #fff;
    box-shadow: 0 0 0 1.5px var(--background);
    object-fit: contain;
  }
  .fav-letter {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 9px;
    font-weight: 600;
  }

  .research-body {
    border-top: 1px solid var(--border-subtle);
    padding: 0.625rem 0.875rem 0.875rem;
  }
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 12.5px;
    color: var(--foreground);
  }
  .step.is-failed {
    color: var(--muted-foreground);
    text-decoration: line-through;
  }
  .step-icon {
    display: inline-flex;
    width: 0.875rem;
    flex-shrink: 0;
    justify-content: center;
    color: var(--muted-foreground);
    transform: translateY(0.1rem);
  }
  .dot {
    width: 0.3rem;
    height: 0.3rem;
    border-radius: 9999px;
    background: currentColor;
  }
  .step-text {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-verb {
    color: var(--muted-foreground);
  }
  .step-query::before {
    content: '“';
  }
  .step-query::after {
    content: '”';
  }
  .step-meta {
    flex-shrink: 0;
    font-size: 11.5px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .summary-line {
    margin: 0.5rem 0 0;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }

  .sources {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.375rem;
    margin: 0.75rem 0 0;
    padding: 0;
    list-style: none;
  }
  .source {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.6rem;
    background: var(--muted);
    text-decoration: none;
    color: inherit;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .source:hover {
    background: var(--surface-hover);
  }
  .source-num {
    width: 1rem;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .source-title,
  .source-host {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source-title {
    font-size: 12.5px;
    color: var(--foreground);
  }
  .source-host {
    font-size: 11px;
    color: var(--muted-foreground);
  }
  .link-btn {
    margin-top: 0.4rem;
    font-size: 12px;
    color: var(--muted-foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link-btn:hover {
    color: var(--foreground);
  }

  .brief {
    margin-top: 0.75rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0.6rem;
    background: var(--muted);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .brief-label {
    margin: 0 0 0.25rem;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .exports {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.75rem;
  }
  .chip {
    height: 1.625rem;
    padding: 0 0.625rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 12px;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .chip:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .export-error {
    margin: 0.35rem 0 0;
    font-size: 11.5px;
    color: var(--error);
  }
</style>
