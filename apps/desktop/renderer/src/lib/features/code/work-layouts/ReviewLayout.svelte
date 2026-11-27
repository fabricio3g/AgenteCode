<svelte:options runes={true} />

<!--
  Diff review — the editor-panel way: what the run looked at folds into one
  line, and every edit is a card showing its first changed lines with a way
  to open the file in Changes. Commands sit underneath with their result on
  the right.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { FileCode, LoaderCircle } from '$lib/icons';
  import { Button } from '$lib/components/ui';
  import { EXPLORE_KINDS, diffPreview, entryResult, type WorkLayoutProps } from '../work-layouts';
  import { codeWorkspace } from '../workspace.svelte';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, totals, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  let showExplored = $state(false);
  const explored = $derived(entries.filter((entry) => entry.step && EXPLORE_KINDS.has(entry.kind)));
  const exploredLine = $derived(
    [
      totals.explored ? $t('code.layout.explored', { values: { n: totals.explored } }) : '',
      totals.searches ? $t('code.layout.searches', { values: { n: totals.searches } }) : ''
    ].filter(Boolean).join(' · ')
  );
  const exploring = $derived(explored.some((entry) => entry.status === 'running'));
</script>

<div class="wl wl-review">
  <LayoutHead title={line} {span} {live} {open} {ontoggle} />
  {#if open}
    <div class="wl-body">
      {#if explored.length}
        <Button variant="plain" type="button" class="wl-fold" aria-expanded={showExplored} onclick={() => (showExplored = !showExplored)}>
          <span class:ui-shimmer-text={exploring}>{exploredLine}</span>
        </Button>
        {#if showExplored}
          <div class="wl-nested">
            {#each explored as entry (entry.key)}
              <EntryRow {entry} {detail} compact open={isOpen(entry)} ontoggle={() => toggleEntry(entry)} />
            {/each}
          </div>
        {/if}
      {/if}
      {#each entries as entry (entry.key)}
        {#if entry.kind === 'edit' && entry.step}
          {@const file = entry.step.diffStats?.[0]}
          {@const preview = diffPreview(file?.patch)}
          <div class="wl-card" class:is-running={entry.status === 'running'}>
            <div class="wl-card-head">
              <Button variant="plain" type="button" class="wl-card-title" aria-expanded={isOpen(entry)} onclick={() => toggleEntry(entry)}>
                {#if entry.status === 'running'}<LoaderCircle class="wl-icon-glyph wl-spin wl-accent" />{:else}<FileCode class="wl-icon-glyph wl-accent" />{/if}
                <span class="wl-target">{entry.name}</span>
                {#if entry.folder}<span class="wl-folder">{entry.folder}</span>{/if}
                <span class="wl-diff"><span class="is-add">+{entry.additions}</span> <span class="is-del">−{entry.deletions}</span></span>
              </Button>
              {#if file && entry.status === 'done'}
                <Button variant="plain" type="button" class="wl-chip-button" onclick={() => codeWorkspace.showFileInChanges(file.path)}>{$t('code.layout.open')}</Button>
              {/if}
            </div>
            {#if isOpen(entry)}
              <div class="wl-detail">{@render detail(entry.item)}</div>
            {:else if preview.length}
              <div class="wl-diff-preview">
                {#each preview as change, index (index)}<div class="is-{change.sign === '+' ? 'add' : 'del'}">{change.sign} {change.text}</div>{/each}
              </div>
            {/if}
          </div>
        {:else if entry.kind === 'command' && entry.step}
          {@const result = entryResult(entry, $t)}
          <EntryRow {entry} {detail} compact open={isOpen(entry)} ontoggle={() => toggleEntry(entry)}>
            {#snippet trail()}
              {#if result || entry.status === 'error'}<span class="wl-trail" class:is-error={entry.status === 'error'}>{result || $t('code.layout.failed')}</span>{/if}
            {/snippet}
          </EntryRow>
        {:else if !entry.step || entry.kind === 'subagent'}
          {@render row(entry.item)}
        {/if}
      {/each}
    </div>
  {/if}
</div>
