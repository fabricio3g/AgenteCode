<svelte:options runes={true} />

<!--
  File stream — the app-builder way: the files the run writes are the story,
  each a row with its type's mark, its folder, its churn and a check (or a
  spinner while it is written). Reading and running fold into one line above.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Check, FileCode, LoaderCircle, XCircle } from '$lib/icons';
  import { EXPLORE_KINDS, fileTone, type WorkLayoutProps } from '../work-layouts';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, totals, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  let showOthers = $state(false);
  const edits = $derived(entries.filter((entry) => entry.kind === 'edit'));
  const others = $derived(entries.filter((entry) => entry.step && entry.kind !== 'edit' && entry.kind !== 'subagent'));
  const rest = $derived(entries.filter((entry) => !entry.step || entry.kind === 'subagent'));
  const othersLine = $derived(
    [
      totals.explored ? $t('code.layout.explored', { values: { n: totals.explored } }) : '',
      totals.searches ? $t('code.layout.searches', { values: { n: totals.searches } }) : '',
      totals.commands ? $t('code.layout.commands', { values: { n: totals.commands } }) : ''
    ].filter(Boolean).join(' · ')
  );
  const exploring = $derived(others.some((entry) => entry.status === 'running' && EXPLORE_KINDS.has(entry.kind)));
  const title = $derived(totals.files.length ? $t('code.work.files', { values: { n: totals.files.length } }) : line);
</script>

<div class="wl wl-files">
  <LayoutHead {title} sub={totals.files.length ? othersLine : undefined} {span} {live} {open} {ontoggle}>
    {#snippet lead()}<span class="wl-icon is-tile is-done" aria-hidden="true"><FileCode class="wl-icon-glyph" /></span>{/snippet}
  </LayoutHead>
  {#if open}
    <div class="wl-body">
      {#if others.length}
        <button type="button" class="wl-fold" aria-expanded={showOthers} onclick={() => (showOthers = !showOthers)}>
          <span class:ui-shimmer-text={exploring}>{othersLine}</span>
        </button>
        {#if showOthers}
          <div class="wl-nested">
            {#each others as entry (entry.key)}
              <EntryRow {entry} {detail} compact open={isOpen(entry)} ontoggle={() => toggleEntry(entry)} />
            {/each}
          </div>
        {/if}
      {/if}
      {#each edits as entry (entry.key)}
        <EntryRow {entry} {detail} open={isOpen(entry)} ontoggle={() => toggleEntry(entry)}>
          {#snippet lead()}
            <span class="wl-file-mark is-{fileTone(entry.name)}" aria-hidden="true"><FileCode class="wl-icon-glyph" /></span>
          {/snippet}
          {#snippet trail()}
            <span class="wl-status is-{entry.status}" aria-hidden="true">
              {#if entry.status === 'running'}<LoaderCircle class="wl-icon-glyph wl-spin" />{:else if entry.status === 'error'}<XCircle class="wl-icon-glyph" />{:else}<Check class="wl-icon-glyph" />{/if}
            </span>
          {/snippet}
        </EntryRow>
      {/each}
      {#each rest as entry (entry.key)}{@render row(entry.item)}{/each}
    </div>
  {/if}
</div>
