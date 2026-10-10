<svelte:options runes={true} />

<!--
  One file's change, sized for the transcript (assistant-ui's code diff): the
  file name with its +/− counts, then the hunks with old/new line numbers,
  additions and removals tinted. "View changes" opens the file in the
  Changes pane.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { parsePatch } from './patch';
  import ClampedBlock from './ClampedBlock.svelte';
  import DiffRows from './DiffRows.svelte';

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
    {#if onopen}<UiButton variant="plain" type="button" class={uiClass("diff-open", "ui-local-ffdc8c3b")} onclick={onopen}>{$t('codeWs.viewChanges')}</UiButton>{/if}
  </div>
  {#if rows.length}
    <ClampedBlock max="20rem"><DiffRows {rows} {path} /></ClampedBlock>
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
    font-size: var(--text-code);
    color: var(--foreground);
  }
  :global(.diff-open.ui-local-ffdc8c3b) {
    flex-shrink: 0;
    font-family: var(--font-sans, inherit);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  :global(.diff-open:hover.ui-local-ffdc8c3b) {
    color: var(--foreground);
  }
</style>
