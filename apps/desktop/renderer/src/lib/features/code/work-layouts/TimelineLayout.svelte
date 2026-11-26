<svelte:options runes={true} />

<!--
  Timeline — the session-log way: the clock time each step started on the
  left, a node on one line (ticked, crossed, or turning), and the step with
  its result beside it.
-->

<script lang="ts">
  import type { WorkLayoutProps } from '../work-layouts';
  import EntryIcon from './EntryIcon.svelte';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const time = (at: number | undefined) => (at === undefined ? '' : clock.format(at));
</script>

<div class="wl wl-timeline">
  <LayoutHead title={line} {span} {live} {open} {ontoggle} />
  {#if open}
    <ol class="wl-body wl-log">
      {#each entries as entry (entry.key)}
        <li class="wl-log-item">
          <span class="wl-time">{time(entry.startedAt)}</span>
          <div class="wl-log-main">
            {#if entry.step && entry.kind !== 'subagent'}
              <EntryRow {entry} {detail} open={isOpen(entry)} ontoggle={() => toggleEntry(entry)}>
                {#snippet lead()}<EntryIcon kind={entry.kind} status={entry.status} shape="node" settled="check" />{/snippet}
              </EntryRow>
            {:else}
              {@render row(entry.item)}
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</div>
