<svelte:options runes={true} />

<!--
  The spawns no step points at: background children, and any the transcript
  lost track of. A child whose `task` step is in this message already draws on
  that step's row, so it is not repeated here.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { CodeChild } from '$shared/agente-protocol';
  import { disclosureKey } from './disclosure.svelte';
  import Disclosure from './Disclosure.svelte';
  import SubagentCard from './SubagentCard.svelte';

  let {
    children,
    chatId,
    messageId
  }: { children: CodeChild[]; chatId: string; messageId: string } = $props();

  const running = $derived(children.filter((child) => child.status === 'running').length);
  /** A failure is never folded away: it is the one thing worth reading. */
  const failed = $derived(children.filter((child) => child.status === 'error'));
  const quiet = $derived(children.filter((child) => child.status !== 'error'));
</script>

{#if quiet.length}
  <Disclosure id={disclosureKey(chatId, messageId, 'subagents')} level="block" chevron="leading" defaultOpen={false}>
    {#snippet header()}
      <span class="line">{$t(`code.activity.subagents.${running ? 'running' : 'done'}`)}</span>
      <span class="count tabular-nums">{running || quiet.length}</span>
    {/snippet}

    {#snippet body()}
      {#each quiet as child (child.id)}
        <SubagentCard {child} id={disclosureKey(chatId, messageId, `child-${child.id}`)} />
      {/each}
    {/snippet}
  </Disclosure>
{/if}
{#each failed as child (child.id)}
  <SubagentCard {child} id={disclosureKey(chatId, messageId, `child-${child.id}`)} />
{/each}

<style>
  .line {
    font-size: var(--text-code);
  }
  .count {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
</style>
