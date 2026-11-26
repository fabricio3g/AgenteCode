<svelte:options runes={true} />

<!--
  Research trail — the search-engine way: each step a row, the ones that
  reached the web carrying the sites as small lettered marks, and every source
  gathered as pills at the end. Marks are drawn locally (a letter on a tint):
  nothing is fetched from the sites to draw them.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Globe } from '$lib/icons';
  import { entryDomains, type WorkLayoutProps } from '../work-layouts';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  const TONES = 5;
  function tone(domain: string): number {
    let hash = 0;
    for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % TONES;
  }

  const sources = $derived([...new Set(entries.flatMap((entry) => entryDomains(entry)))]);
</script>

<div class="wl wl-research">
  <LayoutHead title={line} sub={sources.length ? `${$t('code.layout.sources')} · ${sources.length}` : undefined} {span} {live} {open} {ontoggle}>
    {#snippet lead()}<span class="wl-icon is-tile is-done" aria-hidden="true"><Globe class="wl-icon-glyph" /></span>{/snippet}
  </LayoutHead>
  {#if open}
    <div class="wl-body">
      {#each entries as entry (entry.key)}
        {#if entry.step && entry.kind !== 'subagent'}
          {@const domains = entryDomains(entry, 3)}
          <EntryRow {entry} {detail} open={isOpen(entry)} ontoggle={() => toggleEntry(entry)}>
            {#snippet trail()}
              {#if domains.length}
                <span class="wl-marks" aria-hidden="true">
                  {#each domains as domain (domain)}<span class="wl-mark tone-{tone(domain)}">{domain[0]}</span>{/each}
                </span>
              {/if}
            {/snippet}
          </EntryRow>
        {:else}
          {@render row(entry.item)}
        {/if}
      {/each}
      {#if sources.length}
        <div class="wl-sources" aria-label={$t('code.layout.sources')}>
          {#each sources as domain (domain)}
            <span class="wl-source"><span class="wl-mark tone-{tone(domain)}" aria-hidden="true">{domain[0]}</span>{domain}</span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
