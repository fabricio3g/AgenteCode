<svelte:options runes={true} />

<!--
  The bottom dock: the agent's processes and any number of terminals, as
  tabs. Terminals stay mounted while hidden so their scrollback survives.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Activity, ChevronDown, Plus, SquareTerminal, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import ProcessesView from './ProcessesView.svelte';
  import TerminalView from './TerminalView.svelte';

  let { chatId, cwd }: { chatId: string; cwd: string } = $props();

  const running = $derived(codeWorkspace.runningCount(chatId));

  async function addTerminal() {
    try {
      await codeWorkspace.newTerminal(cwd);
    } catch (error) {
      toastStore.error($t('codeWs.terminalFailed', { values: { reason: (error as Error).message } }));
    }
  }
</script>

<!-- A rounded card like the right dock's, inset from the window edges. -->
<section class="dock-card flex h-full min-h-0 flex-col" aria-label={$t('codeWs.bottomDock')}>
  <div class="flex h-9 shrink-0 items-center gap-0.5 px-2" role="tablist" aria-label={$t('codeWs.bottomDock')}>
    <button
      type="button"
      role="tab"
      aria-selected={codeWorkspace.bottomTab === 'processes'}
      class="tab"
      class:is-active={codeWorkspace.bottomTab === 'processes'}
      onclick={() => (codeWorkspace.bottomTab = 'processes')}
    >
      <Activity class="size-3.5" />
      {$t('codeWs.processes')}
      {#if running}<span class="text-[11px] tabular-nums text-muted-foreground">{running}</span>{/if}
    </button>
    {#each codeWorkspace.terminals as term (term.id)}
      {@const key = `terminal:${term.id}` as const}
      <div class="tab group !pr-1" class:is-active={codeWorkspace.bottomTab === key}>
        <button type="button" role="tab" aria-selected={codeWorkspace.bottomTab === key} class="flex items-center gap-1.5" onclick={() => (codeWorkspace.bottomTab = key)}>
          <SquareTerminal class="size-3.5" />
          <span class:line-through={term.exited}>{term.title}</span>
        </button>
        <button
          type="button"
          class="ml-0.5 flex size-5 items-center justify-center rounded opacity-0 transition hover:bg-[var(--surface-active)] group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={$t('codeWs.closeTerminal', { values: { name: term.title } })}
          onclick={() => codeWorkspace.closeTerminal(term.id)}
        >
          <X class="size-3" />
        </button>
      </div>
    {/each}
    <Button variant="ghost" size="icon-sm" class="size-7" onclick={() => void addTerminal()} aria-label={$t('codeWs.newTerminal')} title={$t('codeWs.newTerminal')}><Plus /></Button>
    <div class="flex-1"></div>
    <Button variant="ghost" size="icon-sm" class="size-7" onclick={() => codeWorkspace.setLayout({ bottomOpen: false })} aria-label={$t('codeWs.hidePanel')} title={$t('codeWs.hidePanel')}><ChevronDown /></Button>
  </div>

  <div class="relative min-h-0 flex-1">
    {#if codeWorkspace.bottomTab === 'processes'}
      <ProcessesView {chatId} {cwd} />
    {/if}
    {#each codeWorkspace.terminals as term (term.id)}
      <div class="absolute inset-0" class:hidden={codeWorkspace.bottomTab !== `terminal:${term.id}`}>
        <TerminalView id={term.id} active={codeWorkspace.bottomTab === `terminal:${term.id}`} />
      </div>
    {/each}
  </div>
</section>

<style>
  .dock-card {
    overflow: hidden;
    border-radius: 0.875rem;
    border: 1px solid var(--border-hover);
    background: var(--card);
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.75rem;
    padding: 0 0.625rem;
    border-radius: 0.5rem;
    font-size: 12px;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .tab:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .tab.is-active {
    background: var(--surface-active);
    color: var(--foreground);
  }
</style>
