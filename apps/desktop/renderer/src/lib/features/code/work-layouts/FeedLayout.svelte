<svelte:options runes={true} />

<!--
  Activity feed — the chat-app way: one summary ("Used 6 tools") led by the
  kinds of work as stacked icons, opening to a two-line row per tool: what it
  did on top, what came back underneath.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { WorkLayoutProps } from '../work-layouts';
  import EntryIcon from './EntryIcon.svelte';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, totals, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  const kinds = $derived([...new Set(entries.filter((entry) => entry.step).map((entry) => entry.kind))].slice(0, 4));
  const title = $derived(live ? line : $t('code.layout.used', { values: { n: totals.total } }));
</script>

<div class="wl wl-feed">
  <LayoutHead {title} {span} {live} {open} {ontoggle}>
    {#snippet lead()}
      <span class="wl-stack" aria-hidden="true">
        {#each kinds as kind (kind)}<EntryIcon {kind} status="done" shape="node" />{/each}
      </span>
    {/snippet}
  </LayoutHead>
  {#if open}
    <div class="wl-body">
      {#each entries as entry (entry.key)}
        {#if entry.step && entry.kind !== 'subagent'}
          <EntryRow {entry} {detail} open={isOpen(entry)} ontoggle={() => toggleEntry(entry)} />
        {:else}
          {@render row(entry.item)}
        {/if}
      {/each}
    </div>
  {/if}
</div>
