<svelte:options runes={true} />

<!--
  The spawns no step points at: background children, and any the transcript
  lost track of. A child whose `task` step is in this message already draws on
  that step's row, so it is not repeated here.

  The header carries the whole block the way a card carries its child: how many
  children, how many are still working, how many broke, what they cost together
  and how long the oldest has been at it. The old header was a bare count, and
  a failed child was excluded from it — the one number you would want to be
  wrong about.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { CodeChild } from '$shared/agente-protocol';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import { emptySpend } from './code-run';
  import { spendCostLabel, spendLabel } from './accounting';
  import { disclosureKey } from './disclosure.svelte';
  import Disclosure from './Disclosure.svelte';
  import SubagentCard from './SubagentCard.svelte';
  import { childElapsedMs } from './subagent-row';

  let {
    children,
    chatId,
    messageId
  }: { children: CodeChild[]; chatId: string; messageId: string } = $props();

  const running = $derived(children.filter((child) => child.status === 'running').length);
  /** A failure is never folded away: it is the one thing worth reading. */
  const failed = $derived(children.filter((child) => child.status === 'error'));
  const quiet = $derived(children.filter((child) => child.status !== 'error'));

  /** Every child's spend, added up the way `conversationSpend` adds up turns. */
  const spend = $derived(
    children.reduce((total, child) => {
      total.costUsd += child.spend.costUsd;
      total.promptTokens += child.spend.promptTokens;
      total.cacheReadTokens += child.spend.cacheReadTokens;
      total.cacheWriteTokens += child.spend.cacheWriteTokens;
      total.estimated ||= child.spend.estimated;
      total.unpriced ||= child.spend.unpriced;
      return total;
    }, emptySpend())
  );
  const cost = $derived(spendCostLabel(spend));
  /** The cache rate belongs in the tooltip here: the header has no room to say what it is a rate of. */
  const cacheDetail = $derived(spendLabel(spend).includes('cached') ? spendLabel(spend) : '');

  // Wall-clock, like the cards: the block's age is the oldest child's age.
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });
  const longest = $derived(children.reduce((max, child) => Math.max(max, childElapsedMs(child, now) ?? 0), 0));
</script>

{#if quiet.length}
  <Disclosure id={disclosureKey(chatId, messageId, 'subagents')} level="block" chevron="leading" defaultOpen={false}>
    {#snippet header()}
      <span class="line">{$t(`code.activity.subagents.${running ? 'running' : 'done'}`)}</span>
      <span class="count tabular-nums">{children.length}</span>
      {#if running}
        <span class="pill is-live tabular-nums">{$t('code.activity.subagents.working', { values: { n: running } })}</span>
      {/if}
      {#if failed.length}
        <span class="pill is-error tabular-nums">{$t('code.activity.subagents.failed', { values: { n: failed.length } })}</span>
      {/if}
      <span class="flex-1"></span>
      {#if cost}<span class="total tabular-nums" title={cacheDetail || undefined}>{cost}</span>{/if}
      {#if longest > 0}<span class="total tabular-nums">{formatToolDuration(longest)}</span>{/if}
    {/snippet}

    {#snippet body()}
      <div class="cards">
        {#each quiet as child (child.id)}
          <SubagentCard {child} {chatId} id={disclosureKey(chatId, messageId, `child-${child.id}`)} />
        {/each}
      </div>
    {/snippet}
  </Disclosure>
{/if}
{#each failed as child (child.id)}
  <SubagentCard {child} {chatId} id={disclosureKey(chatId, messageId, `child-${child.id}`)} />
{/each}

<style>
  .line {
    font-size: var(--text-code);
  }
  .count {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  /* Cards space themselves: the margin each one carries is the gap, so a work
     block and a group arrange their children the same way. */
  .cards {
    display: flex;
    flex-direction: column;
  }
  .pill {
    flex-shrink: 0;
    padding: 0.0625rem 0.375rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .pill.is-live {
    background: color-mix(in srgb, var(--brand-accent) 12%, transparent);
    color: var(--brand-accent);
  }
  .pill.is-error {
    background: color-mix(in srgb, var(--error) 12%, transparent);
    color: var(--error);
  }
  .total {
    flex-shrink: 0;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }
</style>
