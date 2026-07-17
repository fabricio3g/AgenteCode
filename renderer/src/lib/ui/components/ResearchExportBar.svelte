<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, SearchMeta } from '$lib/types/chat';
  import {
    buildResearchExportFiles,
    downloadResearchExportFile,
    suggestedExportKinds,
    type ResearchExportKind
  } from '$lib/services/research-artifacts';
  import { Download } from 'lucide-svelte';

  interface Props {
    sources?: ChatMessage['sources'];
    searchMode?: ChatMessage['searchMode'] | null;
    meta?: SearchMeta | null;
    title?: string;
    query?: string;
    onExported?: (paths: string[]) => void;
  }

  let {
    sources = [],
    searchMode = null,
    meta = null,
    title = 'Research',
    query = '',
    onExported
  }: Props = $props();

  const hasSources = $derived((sources?.length || 0) > 0);
  const isResearch = $derived(
    searchMode === 'search' || searchMode === 'deep' || searchMode === 'max'
  );

  type Chip = { kind: ResearchExportKind; label: string };
  const chips = $derived.by((): Chip[] => {
    const kinds = suggestedExportKinds(searchMode);
    const labels: Record<ResearchExportKind, string> = {
      shortlist: 'Source shortlist',
      citations: 'Citations',
      matrix: 'Evidence matrix',
      bibliography: 'Bibliography',
      protocol: 'Search protocol'
    };
    return kinds.map((kind) => ({ kind, label: labels[kind] }));
  });

  let busyKind = $state<ResearchExportKind | null>(null);
  let lastError = $state('');

  function exportKind(kind: ResearchExportKind) {
    lastError = '';
    if (!sources?.length) {
      lastError = 'No sources to export yet.';
      return;
    }
    busyKind = kind;
    try {
      const files = buildResearchExportFiles({
        sources,
        kinds: [kind],
        title: title || 'Research',
        query: query || title || '',
        searchMode,
        meta
      });
      if (!files.length) {
        lastError = 'Nothing to export from these sources.';
        return;
      }
      for (const file of files) {
        downloadResearchExportFile(file);
      }
      onExported?.(files.map((f) => f.path));
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Export failed.';
    } finally {
      busyKind = null;
    }
  }
</script>

{#if isResearch && hasSources}
  <div class="research-export" role="group" aria-label="Research exports">
    <span class="export-label">
      <Download class="h-3 w-3 opacity-70" />
      Export
    </span>
    <div class="export-chips">
      {#each chips as chip (chip.kind)}
        <button
          type="button"
          class="export-chip"
          class:busy={busyKind === chip.kind}
          disabled={busyKind !== null}
          onclick={() => exportKind(chip.kind)}
        >
          {chip.label}
        </button>
      {/each}
    </div>
    {#if lastError}
      <span class="export-error">{lastError}</span>
    {/if}
  </div>
{/if}

<style>
  .research-export {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.5rem;
    margin: 0.15rem 0 0.45rem;
  }

  .export-label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-tertiary, var(--text-muted));
  }

  .export-chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .export-chip {
    border: 1px solid var(--border);
    background: var(--surface, transparent);
    color: var(--text-secondary, var(--text));
    border-radius: 999px;
    padding: 0.18rem 0.55rem;
    font-size: 0.75rem;
    line-height: 1.2;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
  }

  .export-chip:hover:not(:disabled) {
    background: var(--surface-hover, rgba(127, 127, 127, 0.08));
    border-color: var(--border-strong, var(--border));
  }

  .export-chip:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .export-chip.busy {
    opacity: 0.7;
  }

  .export-error {
    width: 100%;
    font-size: 0.7rem;
    color: var(--error, #c44);
  }
</style>
