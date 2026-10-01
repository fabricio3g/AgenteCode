<svelte:options runes={true} />

<!--
  One file's change, sized for the transcript (assistant-ui's code diff): the
  file name with its +/− counts, then the hunks with old/new line numbers,
  additions and removals tinted. "View changes" opens the file in the
  Changes pane.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { parsePatch } from './patch';

  let { path, patch, additions = 0, deletions = 0, onopen }: { path: string; patch: string; additions?: number; deletions?: number; onopen?: () => void } = $props();

  const rows = $derived(parsePatch(patch));
  const name = $derived(path.split(/[\\/]/).pop() || path);
</script>

<div class="diff-card">
  <div class="diff-head">
    <span class="min-w-0 flex-1 truncate" title={path}>{name}</span>
    <span class="shrink-0 tabular-nums">
      {#if additions}<span class="text-success">+{additions}</span>{/if}
      {#if deletions}<span class="ml-1 text-error">−{deletions}</span>{/if}
    </span>
    {#if onopen}<button type="button" class="diff-open" onclick={onopen}>{$t('codeWs.viewChanges')}</button>{/if}
  </div>
  {#if rows.length}
    <div class="diff-body" role="table" aria-label={$t('codeWs.diff')}>
      {#each rows as row, index (index)}
        {#if row.kind === 'hunk'}
          <div class="hunk" aria-hidden="true">⋯</div>
        {:else}
          <div class="line {row.kind}" role="row">
            <span class="num" aria-hidden="true">{row.oldNo ?? ''}</span>
            <span class="num" aria-hidden="true">{row.newNo ?? ''}</span>
            <span class="sign" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
            <span class="code">{row.text || ' '}</span>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff-card {
    overflow: hidden;
    border-radius: 0.625rem;
    border: 1px solid var(--border-subtle);
    background: var(--background);
  }
  .diff-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem;
    border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    color: var(--foreground);
  }
  .diff-open {
    flex-shrink: 0;
    font-family: var(--font-sans, inherit);
    font-size: 11px;
    color: var(--muted-foreground);
  }
  .diff-open:hover {
    color: var(--foreground);
  }
  .diff-body {
    max-height: 20rem;
    overflow: auto;
    padding: 0.25rem 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .line {
    display: flex;
    min-width: max-content;
    color: var(--foreground);
  }
  .line.add {
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .line.del {
    background: color-mix(in srgb, var(--error) 11%, transparent);
  }
  .num {
    width: 2.5rem;
    flex-shrink: 0;
    padding-right: 0.5rem;
    text-align: right;
    color: color-mix(in srgb, var(--muted-foreground) 70%, transparent);
    user-select: none;
  }
  .sign {
    width: 1rem;
    flex-shrink: 0;
    color: var(--muted-foreground);
    user-select: none;
  }
  .code {
    padding-right: 0.75rem;
    white-space: pre;
  }
  .hunk {
    padding: 0 0.75rem 0 5.5rem;
    color: var(--muted-foreground);
    user-select: none;
  }
</style>
