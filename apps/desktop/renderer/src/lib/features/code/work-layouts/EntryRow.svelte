<svelte:options runes={true} />

<!--
  One step as a desktop row: a mark, the verb and what it touched on the first
  line, and what came back on the second ("120 lines", "+6 −2", "Failed").
  Clicking opens the step's own detail — the diff, the command's output —
  under the row. Layouts swap the mark (`lead`) or add to the right (`trail`).
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { WorkItem } from '../work-blocks';
  import { canOpen, entryResult, entryVerb, type WorkEntry } from '../work-layouts';
  import EntryIcon from './EntryIcon.svelte';

  let {
    entry,
    open,
    ontoggle,
    detail,
    compact = false,
    showFolder = true,
    lead,
    trail
  }: {
    entry: WorkEntry;
    open: boolean;
    ontoggle: () => void;
    detail: Snippet<[WorkItem]>;
    /** One line, no result: for lists folded inside another layout's group. */
    compact?: boolean;
    showFolder?: boolean;
    lead?: Snippet;
    trail?: Snippet;
  } = $props();

  const result = $derived(entryResult(entry, $t));
  const openable = $derived(canOpen(entry));
  const diff = $derived(entry.additions > 0 || entry.deletions > 0);
  const hasSub = $derived(!compact && (!!result || diff || (showFolder && !!entry.folder) || entry.status === 'error'));
</script>

<div class="wl-entry">
  <button
    type="button"
    class="wl-row"
    class:is-compact={compact}
    disabled={!openable}
    aria-expanded={openable ? open : undefined}
    onclick={ontoggle}
  >
    {#if lead}{@render lead()}{:else}<EntryIcon kind={entry.kind} status={entry.status} />{/if}
    <span class="wl-text">
      <span class="wl-title">
        <span class:ui-shimmer-text={entry.status === 'running'}>{entryVerb(entry, $t)}</span>
        {#if entry.name}<span class="wl-target">{entry.name}</span>{/if}
        {#if compact && diff}<span class="wl-diff"><span class="is-add">+{entry.additions}</span> <span class="is-del">−{entry.deletions}</span></span>{/if}
      </span>
      {#if hasSub}
        <span class="wl-sub">
          {#if diff}<span class="wl-diff"><span class="is-add">+{entry.additions}</span> <span class="is-del">−{entry.deletions}</span></span>{/if}
          {#if showFolder && entry.folder}<span class="wl-folder">{entry.folder}</span>{/if}
          {#if entry.status === 'error' && !result}<span class="is-error">{$t('code.layout.failed')}</span>{/if}
          {#if result}<span class="wl-result" class:is-error={entry.status === 'error'} class:is-ask={entry.status === 'ask'}>{result}</span>{/if}
        </span>
      {/if}
    </span>
    {#if trail}{@render trail()}{/if}
  </button>
  {#if open && openable}<div class="wl-detail">{@render detail(entry.item)}</div>{/if}
</div>
