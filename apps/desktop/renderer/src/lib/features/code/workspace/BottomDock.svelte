<svelte:options runes={true} />

<!--
  The bottom dock: the agent's processes and any number of terminals, as
  tabs. Terminals stay mounted while hidden so their scrollback survives.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Activity, ChevronDown, Plus, SquareTerminal, X } from 'lucide-svelte';
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
  <div class="dock-bar" role="tablist" aria-label={$t('codeWs.bottomDock')}>
    <button
      type="button"
      role="tab"
      aria-selected={codeWorkspace.bottomTab === 'processes'}
      class="tab"
      class:is-active={codeWorkspace.bottomTab === 'processes'}
      onclick={() => (codeWorkspace.bottomTab = 'processes')}
    >
      <Activity class="size-3" />
      {$t('codeWs.processes')}
      {#if running}<span class="tab-count">{running}</span>{/if}
    </button>
    {#each codeWorkspace.terminals as term (term.id)}
      {@const key = `terminal:${term.id}` as const}
      <div class="tab has-close" class:is-active={codeWorkspace.bottomTab === key}>
        <button type="button" role="tab" aria-selected={codeWorkspace.bottomTab === key} class="tab-label" onclick={() => (codeWorkspace.bottomTab = key)}>
          <SquareTerminal class="size-3" />
          <span class:line-through={term.exited}>{term.title}</span>
        </button>
        <button
          type="button"
          class="tab-close"
          aria-label={$t('codeWs.closeTerminal', { values: { name: term.title } })}
          onclick={() => codeWorkspace.closeTerminal(term.id)}
        >
          <X class="size-2.5" />
        </button>
      </div>
    {/each}
    <button type="button" class="ui-icon-button is-sm" onclick={() => void addTerminal()} aria-label={$t('codeWs.newTerminal')} title={$t('codeWs.newTerminal')}><Plus /></button>
    <div class="flex-1"></div>
    <button type="button" class="ui-icon-button is-sm" onclick={() => codeWorkspace.setLayout({ bottomOpen: false })} aria-label={$t('codeWs.hidePanel')} title={$t('codeWs.hidePanel')}><ChevronDown /></button>
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
    box-shadow: var(--panel-shadow);
  }

  /* The same slim bar as the browser panel's. */
  .dock-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.3rem 0 0.4rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    display: inline-flex;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.6rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 12px;
    white-space: nowrap;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  .tab.has-close {
    gap: 0.125rem;
    padding-right: 0.2rem;
  }
  .tab:hover,
  .tab.is-active {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .tab-label {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .tab-count {
    color: var(--muted-foreground);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .tab-close {
    display: inline-flex;
    padding: 0.2rem;
    border-radius: var(--radius-full);
    color: inherit;
    opacity: 0;
  }
  .tab:hover .tab-close,
  .tab.is-active .tab-close,
  .tab-close:focus-visible {
    opacity: 0.7;
  }
  .tab-close:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--foreground) 10%, transparent);
  }
</style>
