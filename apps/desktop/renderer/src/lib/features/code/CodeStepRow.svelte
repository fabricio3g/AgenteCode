<svelte:options runes={true} />

<!--
  Dispatches a work-block step: a `task` call is the spawn of an agent
  (SubagentCard), while every other tool call renders through the leaf
  ToolStepRow. Keeping the dispatch here avoids a cycle between SubagentCard
  and tool step rendering.
-->

<script lang="ts">
  import type { AgentStep } from '$lib/types/chat';
  import type { CodeChild } from '$shared/agente-protocol';
  import { isRunning } from './work-blocks';
  import { childFromStep } from './subagent-row';
  import SubagentCard from './SubagentCard.svelte';
  import ToolStepRow from './ToolStepRow.svelte';

  let {
    step,
    id,
    chatId,
    children,
    codeActions = true,
    onstop
  }: {
    step: AgentStep;
    /** Disclosure store key; `disclosureKey(chatId, messageId, entryKey)`. */
    id: string;
    chatId?: string;
    /** The run's children, so a spawn finds the one it started. */
    children?: CodeChild[];
    codeActions?: boolean;
    onstop?: () => void;
  } = $props();

  const isSpawn = $derived(step.toolName === 'task');
  const child = $derived(children?.find((candidate) => candidate.id === step.subagentId));
  const running = $derived(isRunning(step));
</script>

{#if isSpawn}
  <SubagentCard child={child ?? childFromStep(step)} {id} {chatId} pending={!child && running} />
{:else}
  <ToolStepRow {step} {id} {chatId} {codeActions} {onstop} />
{/if}
