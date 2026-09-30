<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronRight, Square } from 'lucide-svelte';
  import type { CodeChild } from '$shared/agente-protocol';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import CodeStepRow from './CodeStepRow.svelte';
  import { spendLabel } from './accounting';

  let { child }: { child: CodeChild } = $props();
  async function stop() {
    try { await invoke('agente_child_cancel', { runId: child.id }); }
    catch (error) { toastStore.error(String(error)); }
  }
</script>

<details class="subagent min-w-0" open={child.status === 'error'}>
  <summary class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted" class:text-error={child.status === 'error'}>
    <ChevronRight class="chevron size-3 shrink-0 transition-transform" />
    <span class="min-w-0 flex-1 truncate">{child.description || child.kind}</span>
    <span class="shrink-0">{child.status}</span>
  </summary>
  <div class="ml-3 max-h-80 space-y-3 overflow-auto px-2 py-2 text-sm">
    {#if child.status === 'running'}<button type="button" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onclick={stop}><Square class="size-3" />{$t('code.stopSubagent')}</button>{/if}
    {#if child.text}<RichContent content={child.text} />{/if}
    {#each child.tools as tool (tool.id)}
      <CodeStepRow step={{ id: tool.id, type: 'tool', label: tool.name, toolName: tool.name, status: tool.status, output: tool.output }} />
    {/each}
    {#if child.summary}<RichContent content={child.summary} />{/if}
    {#if spendLabel(child.spend)}<p class="text-[11px] tabular-nums text-muted-foreground">{spendLabel(child.spend)}</p>{/if}
  </div>
</details>

<style>
  summary { list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .subagent[open] > summary :global(.chevron) { transform: rotate(90deg); }
</style>
