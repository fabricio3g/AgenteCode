<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronRight, Copy, Square } from 'lucide-svelte';
  import type { CodeChild } from '$shared/agente-protocol';
  import { invoke } from '$lib/services/bridge';
  import { copy } from '$lib/copy';
  import { toastStore } from '$lib/stores/toast.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import ClampedBlock from './ClampedBlock.svelte';
  import CodeStepRow from './CodeStepRow.svelte';
  import CodeErrorNotice from './CodeErrorNotice.svelte';
  import { titleCaseToolName } from '$lib/utils/tool-ui';
  import { spendLabel } from './accounting';

  let { child }: { child: CodeChild } = $props();
  let expanded = $state(false);
  $effect(() => { if (child.status === 'error') expanded = true; });
  const currentTool = $derived.by(() => {
    for (let index = child.tools.length - 1; index >= 0; index--) if (child.tools[index]!.status === 'running') return child.tools[index];
    return undefined;
  });
  const status = $derived(child.status === 'error' ? copy.tool.failed : child.status === 'done' ? copy.tool.done : currentTool ? titleCaseToolName(currentTool.name) : copy.status.working);
  const answer = $derived(child.summary || child.text);
  const failed = $derived(child.status === 'error');
  const errorDetail = $derived(failed ? child.summary || child.text : '');
  const reply = $derived(failed && child.text.trim() === errorDetail.trim() ? '' : child.text);


  /*
   * While the child is running its text arrives a delta at a time. Marking it
   * streaming keeps the renderer on its cheap path — the settled prefix is
   * written once and only the tail re-renders — instead of re-parsing the whole
   * answer, syntax highlighting included, on every delta.
   */
  const streamStatus = $derived(
    child.status === 'running' ? 'streaming' : child.status === 'error' ? 'error' : 'idle'
  );

  async function stop() {
    try { await invoke('agente_child_cancel', { runId: child.id }); }
    catch (error) { toastStore.error(String(error)); }
  }

  async function copyText() {
    try {
      if (!await writeToClipboard(answer)) throw new Error('Could not copy the subagent text');
      toastStore.success($t('chat.copied'));
    } catch (error) { toastStore.error(String(error)); }
  }
</script>

<details class="subagent min-w-0" bind:open={expanded}>
  <summary class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground" class:text-error={child.status === 'error'}>
    <ChevronRight class="chevron size-3 shrink-0 transition-transform" />
    <span class="min-w-0 flex-1 truncate">{child.description || child.kind}</span>
    <span class="child-status shrink-0" class:working={child.status === 'running'}><span class="status-dot" aria-hidden="true"></span>{status}</span>
  </summary>
  <!--
    No scroll box of its own: a nested scroller inside the transcript's own one
    is what made a long answer hard to read. The block is clamped with a fade
    and opened in place, and while the child streams it follows its tail.
  -->
  {#if expanded}
  <div class="child-body ml-3 space-y-3 px-2 py-2 text-sm">
    {#if child.status === 'running'}<button type="button" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onclick={stop}><Square class="size-3" />{$t('code.stopSubagent')}</button>{/if}
    {#if failed && errorDetail}<CodeErrorNotice detail={errorDetail} />{/if}
    {#if reply}
      <div>
        <ClampedBlock max="22rem" tail={child.status === 'running'}>
          <RichContent content={reply} status={streamStatus} />
        </ClampedBlock>
        {#if child.status !== 'running'}
          <button type="button" class="subagent-action" onclick={copyText}><Copy class="size-3" />{copy.actions.copy}</button>
        {/if}
      </div>
    {/if}
    {#each child.tools as tool (tool.id)}
      <CodeStepRow step={{ id: tool.id, type: 'tool', label: tool.name, toolName: tool.name, status: tool.status, output: tool.output }} />
    {/each}
    {#if !failed && child.summary && !child.text.trimEnd().endsWith(child.summary.trim())}<RichContent content={child.summary} />{/if}
    {#if spendLabel(child.spend)}<p class="text-xs tabular-nums text-muted-foreground">{spendLabel(child.spend)}</p>{/if}
  </div>
  {/if}
</details>

<style>
  summary { list-style: none; }
  .child-body { border-left: 1px solid var(--border); }
  .child-status { display: inline-flex; gap: .375rem; align-items: center; font-size: var(--text-xs); }
  .status-dot { width: .3rem; height: .3rem; border-radius: 50%; background: currentColor; opacity: .45; }
  .working .status-dot { opacity: .85; }

  summary::-webkit-details-marker { display: none; }
  .subagent[open] > summary :global(.chevron) { transform: rotate(90deg); }

  .subagent-action {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    transition: color var(--motion-fast) var(--motion-ease), background var(--motion-fast) var(--motion-ease);
  }
  .subagent-action:hover,
  .subagent-action:focus-visible {
    color: var(--foreground);
  }
</style>
