<svelte:options runes={true} />

<!--
  The swarm board: the main model plans cards, the subagents it creates work
  them. Laid out by the Laws of UX:
  - Jakob: a kanban — Backlog, Working, Review, Done — columns side by side
    when the pane is wide, stacked sections when it is a side pane.
  - Von Restorff: Review is the one thing that needs the user, so review
    cards carry the amber rail and the tally names them; done cards dim.
  - Chunking + proximity: a card is its title, then `role · model`, then
    what it waits for / owns, then its result — one block per card.
  - Hick + Occam: the board is read-only; the agent moves cards. The only
    controls are the swarm switch and "Clear board".
  - Fitts: the whole card opens its subagent.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Switch } from '$lib/components/ui';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { SwarmCard } from '$shared/agente-protocol';
  import { subagentFocus } from './subagent-focus.svelte';
  import { columnsOf, swarmStore, tallyOf } from './swarm.svelte';

  let { chatId }: { chatId: string } = $props();

  const board = $derived(swarmStore.boardFor(chatId));
  const enabled = $derived(!!board?.enabled);
  const columns = $derived(columnsOf(board));
  const tally = $derived(tallyOf(board));
  let switching = $state(false);
  /** The switch follows the store; a failed change puts it back. */
  let checked = $state(false);
  $effect(() => { checked = enabled; });

  onMount(() => {
    void swarmStore.load(chatId).catch(() => {});
  });

  async function toggle(on: boolean) {
    switching = true;
    try {
      await swarmStore.setEnabled(chatId, on);
    } catch (error) {
      checked = swarmStore.enabled(chatId);
      toastStore.error(String(error));
    } finally {
      switching = false;
    }
  }

  function open(card: SwarmCard) {
    if (card.child_id) subagentFocus.open(chatId, card.child_id);
  }

  function owned(card: SwarmCard): string {
    const owns = card.owns ?? [];
    if (owns.length <= 2) return owns.join(', ');
    return `${owns.slice(0, 2).join(', ')} +${owns.length - 2}`;
  }
</script>

<div class="board">
  <label class="switch-row">
    <span class="switch-text">
      <span class="switch-title">{$t('code.swarm.mode')}</span>
      <span class="switch-hint">{enabled ? $t('code.swarm.onHint') : $t('code.swarm.offHint')}</span>
    </span>
    <Switch label={$t('code.swarm.mode')} bind:checked disabled={switching} onchange={(on) => void toggle(on)} />
  </label>

  {#if tally.total === 0}
    <p class="empty">{enabled ? $t('code.swarm.emptyOn') : $t('code.swarm.emptyOff')}</p>
  {:else}
    <p class="tally" role="status">
      {$t('code.swarm.cards', { values: { n: tally.total } })}
      {#if tally.working}<span> · {$t('code.swarm.working', { values: { n: tally.working } })}</span>{/if}
      {#if tally.review}<span class="needs-you"> · {$t('code.swarm.toReview', { values: { n: tally.review } })}</span>{/if}
      {#if tally.failed}<span class="failed-count"> · {$t('code.swarm.failed', { values: { n: tally.failed } })}</span>{/if}
    </p>

    <div class="columns">
      {#each columns as column (column.id)}
        <section class="column" aria-labelledby={`board-${chatId}-${column.id}`}>
          <h3 id={`board-${chatId}-${column.id}`}>
            {$t(`code.swarm.column.${column.id}`)}<span class="count">{column.cards.length}</span>
          </h3>
          {#each column.cards as card (card.id)}
            <button
              type="button"
              class="card status-{card.status}"
              disabled={!card.child_id}
              onclick={() => open(card)}
              title={card.child_id ? $t('code.swarm.openCard') : undefined}
            >
              <span class="card-head">
                {#if card.status === 'working'}
                  <span class="meter"><TileMeter mode="busy" /></span>
                {:else}
                  <span class="mark" aria-hidden="true">{card.status === 'done' ? '✓' : card.status === 'failed' ? '✕' : card.status === 'review' ? '◆' : '○'}</span>
                {/if}
                <span class="card-title">{card.title}</span>
                <span class="card-id">{card.id}</span>
              </span>
              <span class="card-who">{card.role}{#if card.model}<span class="model">{' · '}{card.model}</span>{/if}</span>
              {#if card.status === 'backlog' && card.depends_on?.length}
                <span class="card-meta">{$t('code.swarm.waitsFor', { values: { cards: card.depends_on.join(', ') } })}</span>
              {/if}
              {#if card.owns?.length && card.status !== 'done'}
                <span class="card-meta files" title={(card.owns ?? []).join('\n')}>{owned(card)}</span>
              {/if}
              {#if card.result && card.status !== 'working' && card.status !== 'backlog'}
                <span class="card-result">{card.result}</span>
              {/if}
            </button>
          {:else}
            <p class="column-empty">—</p>
          {/each}
        </section>
      {/each}
    </div>

    {#if !tally.working}
      <div class="foot"><Button size="sm" variant="ghost" onclick={() => void swarmStore.clear(chatId)}>{$t('code.swarm.clear')}</Button></div>
    {/if}
  {/if}
</div>

<style>
  .board { display: grid; align-content: start; gap: 0.75rem; height: 100%; overflow: auto; padding: 0.75rem; container-type: inline-size; }
  .switch-row { display: flex; align-items: center; gap: 1rem; border: 1px solid var(--border-subtle); border-radius: 0.75rem; padding: 0.625rem 0.75rem; cursor: pointer; }
  .switch-text { display: grid; min-width: 0; flex: 1; gap: 0.125rem; }
  .switch-title { font-size: var(--text-sm); font-weight: 500; color: var(--foreground); }
  .switch-hint { font-size: var(--text-xs); line-height: 1.45; color: var(--muted-foreground); }
  .empty { max-width: 48ch; padding: 0.5rem 0.25rem; font-size: var(--text-sm); line-height: 1.55; color: var(--muted-foreground); }
  .tally { font-size: var(--text-xs); color: var(--muted-foreground); }
  .tally .needs-you { color: var(--warning); font-weight: 500; }
  .tally .failed-count { color: var(--error); }

  /* Side pane: sections stacked. Wide pane: the kanban side by side. */
  .columns { display: grid; gap: 1rem; }
  @container (min-width: 44rem) { .columns { grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; } }
  .column { display: grid; gap: 0.5rem; min-width: 0; }
  .column h3 { display: flex; align-items: baseline; gap: 0.375rem; font-size: var(--text-xs); font-weight: 500; color: var(--muted-foreground); }
  .count { color: var(--text-muted, var(--muted-foreground)); font-variant-numeric: tabular-nums; }
  .column-empty { font-size: var(--text-xs); color: var(--muted-foreground); padding-left: 0.25rem; }

  .card { display: grid; gap: 0.25rem; width: 100%; min-width: 0; border: 1px solid var(--border-subtle); border-radius: 0.625rem; background: var(--card, transparent); padding: 0.625rem 0.75rem; text-align: left; transition: background var(--motion-instant) var(--motion-ease); }
  .card:not(:disabled) { cursor: pointer; }
  .card:not(:disabled):hover, .card:focus-visible { background: var(--surface-hover); }
  .card.status-review { box-shadow: inset 3px 0 0 var(--warning); }
  .card.status-failed { box-shadow: inset 3px 0 0 var(--error); }
  .card.status-done { opacity: 0.72; }
  .card-head { display: flex; min-width: 0; align-items: baseline; gap: 0.5rem; }
  .mark { width: 1rem; flex-shrink: 0; text-align: center; font-size: var(--text-xs); color: var(--muted-foreground); }
  .status-review .mark { color: var(--warning); }
  .status-failed .mark { color: var(--error); }
  .meter { display: inline-flex; width: 1rem; flex-shrink: 0; justify-content: center; align-self: center; }
  .card-title { min-width: 0; flex: 1; font-size: var(--text-sm); font-weight: 600; color: var(--foreground); overflow-wrap: anywhere; }
  .card-id { flex-shrink: 0; font-size: var(--text-xs); color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .card-who { padding-left: 1.5rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .card-meta { padding-left: 1.5rem; font-size: var(--text-xs); color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-meta.files { font-family: var(--font-mono); }
  .card-result { padding-left: 1.5rem; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--text-xs); line-height: 1.5; color: var(--prose-ink, var(--foreground)); }
  .foot { display: flex; justify-content: flex-end; }
</style>
