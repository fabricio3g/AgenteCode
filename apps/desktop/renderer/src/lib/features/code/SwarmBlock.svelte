<svelte:options runes={true} />

<!--
  A swarm in the transcript: one block instead of a pile of subagent cards.
  The members of a turn's swarm are a team working one board, so they read as
  one — a lane per card, then what they told each other.

  - Edges: the lane's status and card id hard left, its title and who works it
    beside them, what it is doing (or how it ended) hard right.
  - Contrast, not colour: only the running lanes are bright; done lanes and
    the links between cards (waits for / feeds) stay dim. Review takes the
    amber mark — the one state that needs someone.
  - Findings sit under the lanes as a short log, routed `c1 → c2`, so who
    told whom what is one glance; the Board pane keeps the full log.
  - Fitts: the whole lane opens its subagent.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/ui/Button.svelte';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { LayoutGrid } from '$lib/icons';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import type { CodeChild, SwarmCard } from '$shared/agente-protocol';
  import { subagentFocus } from './subagent-focus.svelte';
  import { childElapsedMs, childModelLabel, subagentDisplay } from './subagent-row';
  import { feedsOf, lanesFor, recentFindings } from './swarm-lanes';
  import SwarmFindingList from './SwarmFindingList.svelte';
  import { swarmStore } from './swarm.svelte';

  /** Findings the block shows before pointing at the Board pane. */
  const SHOWN_FINDINGS = 4;

  let {
    chatId,
    children,
    stopping = false
  }: {
    chatId: string;
    /** The turn's subagents; the ones working board cards become lanes. */
    children: readonly CodeChild[];
    stopping?: boolean;
  } = $props();

  const board = $derived(swarmStore.boardFor(chatId));
  const byId = $derived(new Map(children.map((child) => [child.id, child])));
  const lanes = $derived(lanesFor(board, new Set(byId.keys())));
  const laneIds = $derived(new Set(lanes.map((card) => card.id)));
  const touching = $derived(recentFindings(board, Number.MAX_SAFE_INTEGER, laneIds));
  const findings = $derived(touching.slice(Math.max(0, touching.length - SHOWN_FINDINGS)));
  const hidden = $derived(touching.length - findings.length);
  const working = $derived(lanes.filter((card) => card.status === 'working').length);
  const review = $derived(lanes.filter((card) => card.status === 'review').length);

  let now = $state(Date.now());
  $effect(() => {
    if (!working) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function childOf(card: SwarmCard): CodeChild | undefined {
    return card.child_id ? byId.get(card.child_id) : undefined;
  }

  /** The right edge: what a working lane is doing, or where its card is. */
  function stateText(card: SwarmCard, child: CodeChild | undefined): string {
    if (card.status === 'working') return (child && subagentDisplay(child, { now }).activity) || $t('code.swarm.column.working');
    if (card.status === 'failed') return $t('code.swarm.lane.failed');
    return $t(`code.swarm.column.${card.status}`);
  }

  /** The dim line under a lane: what it waits for and whom it feeds. */
  function links(card: SwarmCard): string {
    const parts: string[] = [];
    if (card.status === 'backlog' && card.depends_on?.length) parts.push($t('code.swarm.waitsFor', { values: { cards: card.depends_on.join(', ') } }));
    const feeds = feedsOf(board, card);
    if (feeds.length) parts.push($t('code.swarm.lane.feeds', { values: { cards: feeds.join(', ') } }));
    return parts.join(' · ');
  }

  function open(card: SwarmCard) {
    if (card.child_id) subagentFocus.open(chatId, card.child_id);
  }

  function openBoard() {
    workspaceLayout.show('board');
  }
</script>

{#if lanes.length}
  <section class="swarm" aria-label={$t('code.swarm.lane.title')} data-swarm-block>
    <header class="head">
      {#if working}<TileMeter mode={stopping ? 'stopped' : 'busy'} />{:else}<LayoutGrid class="size-3.5" />{/if}
      <span class="title">{$t('code.swarm.lane.title')}</span>
      <span class="sep">·</span>
      <span>{$t('code.swarm.cards', { values: { n: lanes.length } })}</span>
      {#if working}<span class="sep">·</span><span class="live">{$t('code.swarm.working', { values: { n: working } })}</span>{/if}
      {#if review}<span class="sep">·</span><span class="needs-you">{$t('code.swarm.toReview', { values: { n: review } })}</span>{/if}
      <Button variant="plain" type="button" class="board-link ui-local-5a1f0c2e" onclick={openBoard}>{$t('code.swarm.board')}</Button>
    </header>

    <ol class="lanes">
      {#each lanes as card (card.id)}
        {@const child = childOf(card)}
        {@const elapsed = child ? childElapsedMs(child, now) : undefined}
        {@const linkText = links(card)}
        <li>
          <Button variant="plain" type="button" class="lane status-{card.status} ui-local-5a1f0c2e" disabled={!card.child_id} onclick={() => open(card)} title={card.child_id ? $t('code.swarm.openCard') : undefined}>
            <span class="mark" aria-hidden="true">
              {#if card.status === 'working'}<TileMeter mode={stopping ? 'stopped' : 'busy'} />{:else}{card.status === 'done' ? '✓' : card.status === 'failed' ? '✕' : card.status === 'review' ? '◆' : '○'}{/if}
            </span>
            <span class="id">{card.id}</span>
            <span class="who">
              <span class="card-title">{card.title}</span>
              <span class="role">{card.role}{#if child?.model || card.model}{' · '}{child ? childModelLabel(child) : card.model}{/if}</span>
            </span>
            <span class="state">{stateText(card, child)}</span>
            <span class="elapsed">{elapsed !== undefined && card.status !== 'backlog' ? formatToolDuration(elapsed) : ''}</span>
            {#if linkText}<span class="links">{linkText}</span>{/if}
          </Button>
        </li>
      {/each}
    </ol>

    {#if findings.length}
      <div class="findings">
        <h4>{$t('code.swarm.lane.findings')}</h4>
        <SwarmFindingList {findings} />
        {#if hidden > 0}
          <Button variant="plain" type="button" class="more ui-local-5a1f0c2e" onclick={openBoard}>{$t('code.swarm.lane.more', { values: { n: hidden } })}</Button>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .swarm { display: grid; gap: 0.375rem; min-width: 0; font-size: var(--text-xs); color: var(--muted-foreground); }
  .head { display: flex; align-items: center; gap: 0.375rem; min-height: 1.75rem; font-variant-numeric: tabular-nums; }
  .title { font-weight: 500; color: var(--foreground); }
  .sep { opacity: 0.6; }
  .live { color: var(--foreground); }
  .needs-you { color: var(--warning); font-weight: 500; }
  :global(.board-link.ui-local-5a1f0c2e) { margin-left: auto; height: 1.5rem; padding: 0 0.5rem; border-radius: var(--radius-full); color: var(--muted-foreground); font-size: var(--text-xs); transition: background-color var(--motion-instant) var(--motion-ease); }
  :global(.board-link.ui-local-5a1f0c2e:hover) { background: var(--float-row-hover); color: var(--foreground); }

  .lanes { display: grid; gap: 1px; margin-inline: -0.5rem; }
  /* mark · id · title+role · state · elapsed — the id and the right edge are columns, so lanes line up. */
  :global(.lane.ui-local-5a1f0c2e) {
    display: grid; grid-template-columns: 1rem 1.75rem minmax(0, 1fr) minmax(0, max-content) 3rem;
    align-items: baseline; column-gap: 0.5rem; width: 100%; min-width: 0; padding: 0.375rem 0.5rem;
    border-radius: 0.5rem; text-align: left; font: inherit; font-size: var(--text-xs); color: inherit;
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  :global(.lane.ui-local-5a1f0c2e:not(:disabled)) { cursor: pointer; }
  :global(.lane.ui-local-5a1f0c2e:not(:disabled):hover), :global(.lane.ui-local-5a1f0c2e:focus-visible) { background: var(--float-row-hover); }
  .mark { display: inline-flex; justify-content: center; align-self: center; }
  :global(.status-review.ui-local-5a1f0c2e) .mark { color: var(--warning); }
  :global(.status-failed.ui-local-5a1f0c2e) .mark, :global(.status-failed.ui-local-5a1f0c2e) .state { color: var(--error); }
  .id { font-variant-numeric: tabular-nums; }
  .who { display: flex; min-width: 0; align-items: baseline; gap: 0.5rem; }
  .card-title { flex-shrink: 0; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--text-secondary, var(--foreground)); }
  :global(.status-working.ui-local-5a1f0c2e) .card-title { color: var(--foreground); font-weight: 500; }
  :global(.status-done.ui-local-5a1f0c2e) .card-title { color: var(--muted-foreground); }
  .role { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
  :global(.status-working.ui-local-5a1f0c2e) .state { color: var(--foreground); }
  .elapsed { text-align: right; font-variant-numeric: tabular-nums; }
  .links { grid-column: 3 / -1; opacity: 0.8; }

  .findings { display: grid; gap: 0.25rem; padding-top: 0.25rem; }
  .findings h4 { font-size: var(--text-xs); font-weight: 500; color: var(--muted-foreground); }
  :global(.more.ui-local-5a1f0c2e) { justify-self: start; height: 1.5rem; padding: 0 0.5rem; margin-inline: -0.5rem; border-radius: var(--radius-full); color: var(--muted-foreground); font-size: var(--text-xs); }
  :global(.more.ui-local-5a1f0c2e:hover) { background: var(--float-row-hover); color: var(--foreground); }
</style>
