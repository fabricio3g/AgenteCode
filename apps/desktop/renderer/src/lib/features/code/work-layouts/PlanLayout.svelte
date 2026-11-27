<svelte:options runes={true} />

<!--
  Task plan — the planning-agent way: a progress ring in the header and the
  run told as phases (looked through the code, made changes, ran commands),
  each ticked when it is done. The phase in progress, or one that failed,
  stays open with its steps underneath.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { AlertCircle, ChevronDown, CircleCheck, LoaderCircle, XCircle } from '$lib/icons';
  import { Button } from '$lib/components/ui';
  import { workPhases, type WorkLayoutProps, type WorkPhase } from '../work-layouts';
  import EntryRow from './EntryRow.svelte';
  import LayoutHead from './LayoutHead.svelte';

  let { entries, totals, line, span, live, open, ontoggle, row, detail, isOpen, toggleEntry }: WorkLayoutProps = $props();

  const phases = $derived(workPhases(entries));
  const progress = $derived(totals.total ? (totals.done + totals.failed) / totals.total : 0);
  /** Red only when the run stopped on a failure, not for one it recovered from. */
  const endedInFailure = $derived(!totals.running && entries.filter((entry) => entry.step).at(-1)?.status === 'error');
  const RADIUS = 9;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  /** The reader's own choice per phase; otherwise the active or failed one is open. */
  let chosen = $state<Record<string, boolean>>({});
  function phaseOpen(phase: WorkPhase, index: number): boolean {
    if (phase.key in chosen) return chosen[phase.key];
    return phase.status !== 'done' || (live && index === phases.length - 1);
  }
</script>

<div class="wl wl-plan">
  <LayoutHead title={line} sub={$t('code.layout.progress', { values: { done: totals.done + totals.failed, total: totals.total } })} {span} {live} {open} {ontoggle}>
    {#snippet lead()}
      <svg class="wl-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={RADIUS} class="wl-ring-track" />
        <circle cx="12" cy="12" r={RADIUS} class="wl-ring-fill" class:is-error={endedInFailure} stroke-dasharray="{progress * CIRCUMFERENCE} {CIRCUMFERENCE}" transform="rotate(-90 12 12)" />
      </svg>
    {/snippet}
  </LayoutHead>
  {#if open}
    <ol class="wl-body wl-phases">
      {#each phases as phase, index (phase.key)}
        {@const expanded = phaseOpen(phase, index)}
        {@const steps = phase.entries.filter((entry) => entry.step)}
        <li class="wl-phase" class:is-current={phase.status !== 'done'}>
          {#if phase.kind === 'think' || phase.kind === 'delegate'}
            {#each phase.entries as entry (entry.key)}{@render row(entry.item)}{/each}
          {:else}
            <Button variant="plain" type="button" class="wl-phase-head" aria-expanded={expanded} onclick={() => (chosen = { ...chosen, [phase.key]: !expanded })}>
              <span class="wl-status is-{phase.status}" aria-hidden="true">
                {#if phase.status === 'running'}<LoaderCircle class="wl-icon-glyph wl-spin" />{:else if phase.status === 'error'}<XCircle class="wl-icon-glyph" />{:else if phase.status === 'ask'}<AlertCircle class="wl-icon-glyph" />{:else}<CircleCheck class="wl-icon-glyph" />{/if}
              </span>
              <span class="wl-phase-title">{$t(`code.layout.phase.${phase.kind}`)}</span>
              <span class="wl-fill"></span>
              <span class="wl-head-meta">{$t('code.work.steps', { values: { n: steps.length } })}</span>
              <ChevronDown class="wl-chev {expanded ? 'is-open' : ''}" />
            </Button>
            {#if expanded}
              <div class="wl-nested">
                {#each phase.entries as entry (entry.key)}
                  <EntryRow {entry} {detail} compact open={isOpen(entry)} ontoggle={() => toggleEntry(entry)} />
                {/each}
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>
