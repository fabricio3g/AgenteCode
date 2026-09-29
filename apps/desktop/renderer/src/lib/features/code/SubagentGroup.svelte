<svelte:options runes={true} />

<script lang="ts">
  import { ChevronRight } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { CodeChild } from '$shared/agente-protocol';
  import SubagentCard from './SubagentCard.svelte';

  let { children }: { children: CodeChild[] } = $props();
  const running = $derived(children.filter((child) => child.status === 'running').length);
  const failed = $derived(children.filter((child) => child.status === 'error'));
  const quiet = $derived(children.filter((child) => child.status !== 'error'));
</script>

{#if quiet.length}
  <details class="subagents min-w-0">
    <summary class="flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
      <ChevronRight class="chevron size-3 shrink-0 transition-transform" />
      <span>{$t(`code.activity.subagents.${running ? 'running' : 'done'}`)}</span>
      <span class="tabular-nums">{running || quiet.length}</span>
    </summary>
    <div class="ml-3 space-y-1 py-1">{#each quiet as child (child.id)}<SubagentCard {child} />{/each}</div>
  </details>
{/if}
{#each failed as child (child.id)}<SubagentCard {child} />{/each}

<style>
  summary { list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .subagents[open] > summary :global(.chevron) { transform: rotate(90deg); }
</style>
