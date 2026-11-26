<svelte:options runes={true} />

<!--
  Step tiles — the dashboard way: one tile per kind of work (explored, edited,
  ran, result), each with its count and the fact that matters; a tile opens
  the steps behind it underneath the grid.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { CircleCheck, FilePen, LoaderCircle, Search, SquareTerminal, XCircle } from '$lib/icons';
  import { EXPLORE_KINDS, entryResult, type WorkEntry, type WorkLayoutProps } from '../work-layouts';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, totals, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  type TileId = 'explored' | 'edited' | 'ran' | 'result';
  let chosen = $state<TileId | null>(null);

  const steps = $derived(entries.filter((entry) => entry.step && entry.kind !== 'subagent'));
  const groups = $derived<Record<TileId, WorkEntry[]>>({
    explored: steps.filter((entry) => EXPLORE_KINDS.has(entry.kind)),
    edited: steps.filter((entry) => entry.kind === 'edit'),
    ran: steps.filter((entry) => entry.kind === 'command'),
    result: steps.filter((entry) => entry.kind === 'command').slice(-1)
  });
  const lastCommand = $derived(groups.ran.at(-1));
  const adds = $derived(totals.files.reduce((sum, file) => sum + file.additions, 0));
  const dels = $derived(totals.files.reduce((sum, file) => sum + file.deletions, 0));
  const rest = $derived(entries.filter((entry) => !entry.step || entry.kind === 'subagent'));

  const tiles = $derived(
    [
      { id: 'explored' as const, icon: Search, label: $t('code.layout.tile.explored'), value: [totals.explored ? $t('code.layout.files', { values: { n: totals.explored } }) : '', totals.searches ? $t('code.layout.searches', { values: { n: totals.searches } }) : ''].filter(Boolean).join(' · '), tone: 'muted' },
      { id: 'edited' as const, icon: FilePen, label: $t('code.layout.tile.edited'), value: totals.files.length ? `${$t('code.layout.files', { values: { n: totals.files.length } })} · +${adds} −${dels}` : '', tone: 'accent' },
      { id: 'ran' as const, icon: SquareTerminal, label: $t('code.layout.tile.ran'), value: totals.commands ? $t('code.layout.commands', { values: { n: totals.commands } }) : '', tone: 'muted' },
      {
        id: 'result' as const,
        icon: lastCommand?.status === 'running' ? LoaderCircle : lastCommand?.status === 'error' ? XCircle : CircleCheck,
        label: $t('code.layout.tile.result'),
        value: lastCommand ? entryResult(lastCommand, $t) || $t(lastCommand.status === 'error' ? 'code.layout.tile.failing' : 'code.layout.tile.passing') : '',
        tone: lastCommand?.status === 'error' ? 'error' : lastCommand?.status === 'running' ? 'accent' : 'success'
      }
    ].filter((tile) => tile.value)
  );
</script>

<div class="wl wl-tiles">
  <LayoutHead title={line} {span} {live} {open} {ontoggle} />
  {#if open}
    <div class="wl-body">
      <div class="wl-tile-grid">
        {#each tiles as tile (tile.id)}
          {@const Icon = tile.icon}
          {@const running = groups[tile.id].some((entry) => entry.status === 'running')}
          <button type="button" class="wl-tile" class:is-chosen={chosen === tile.id} aria-expanded={chosen === tile.id} onclick={() => (chosen = chosen === tile.id ? null : tile.id)}>
            <Icon class="wl-tile-icon tone-{tile.tone} {running || Icon === LoaderCircle ? 'wl-spin' : ''}" />
            <span class="wl-tile-label">{tile.label}</span>
            <span class="wl-tile-value" class:is-error={tile.tone === 'error'}>{tile.value}</span>
          </button>
        {/each}
      </div>
      {#if chosen}
        <div class="wl-nested">
          {#each groups[chosen] as entry (entry.key)}
            <EntryRow {entry} {detail} open={isOpen(entry)} ontoggle={() => toggleEntry(entry)} />
          {/each}
        </div>
      {/if}
      {#each rest as entry (entry.key)}{@render row(entry.item)}{/each}
    </div>
  {/if}
</div>
