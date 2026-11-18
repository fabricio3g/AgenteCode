<svelte:options runes={true} />
<script lang="ts">
  import { tick } from 'svelte';
  import { Monitor, Hand, Play, Square } from '$lib/icons';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { COMPUTER_TASK_PREFIX, isComputerTask } from '$shared/computer';
  import { computerStore, controlComputer } from './computer.svelte';

  let open = $state(false);
  const active = $derived(['active', 'preparing', 'paused', 'requesting'].includes(computerStore.state.phase));
  const owns = $derived(active && computerStore.owned && computerStore.state.chatId === appStore.currentChat?.id);
  const paused = $derived(computerStore.state.phase === 'paused');
  const unavailable = $derived(!computerStore.available ? 'Requires the Windows computer helper'
    : appStore.activeSpace === 'code' && !appStore.currentChat ? 'Open a Code conversation first'
    : appStore.activeSpace !== 'home' && appStore.activeSpace !== 'code' ? 'Available in Home and Code' : '');
  async function draft() {
    open = false;
    if (appStore.activeSpace === 'code') {
      window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: { chatId: appStore.currentChat?.id, text: COMPUTER_TASK_PREFIX } }));
    } else {
      const existing = appStore.composer;
      if (!appStore.currentChat) appStore.createChat('home');
      if (!isComputerTask(existing)) appStore.updateComposer(COMPUTER_TASK_PREFIX + existing.trimStart());
      await tick();
      window.dispatchEvent(new Event('focus-composer'));
    }
  }
</script>
<Menu bind:open placement="bottom-end" minWidth="18rem" label="Computer use">
  {#snippet trigger(props)}
    <UiIconButton label="Computer use" size="sm" type="button" class="titlebar-no-drag" aria-pressed={owns} {...props}>
      {#if owns && !paused}<TileMeter mode="quiet" />{:else}<Monitor class="size-4" />{/if}
    </UiIconButton>
  {/snippet}
  <div class="computer-summary">
    <p>{owns ? computerStore.state.activity : 'Use this computer'}</p>
    <span>{owns ? computerStore.state.task : 'Agente works in your real apps. A desktop overlay shows its pointer and activity. Escape gives control back to you.'}</span>
  </div>
  {#if owns}
    {#if paused}<MenuItem icon={Play} label="Resume computer task" disabled={!computerStore.state.canResume} onselect={() => void controlComputer('resume')} />
    {:else}<MenuItem icon={Hand} label="Take over" description="Esc" onselect={() => void controlComputer('takeover')} />{/if}
    <MenuItem icon={Square} label="End computer use" onselect={() => void controlComputer('end')} />
  {:else if active}
    <p class="computer-summary">Another chat owns computer control.</p>
  {:else}
    <MenuItem icon={Monitor} label="Ask Agente to use the computer" description={unavailable || 'Describe the task in your message'} disabled={!!unavailable} onselect={() => void draft()} />
  {/if}
</Menu>
<style>
  .computer-summary { padding:0.5rem 0.625rem; max-width:22rem; }
  .computer-summary p { margin:0 0 0.25rem; color:var(--foreground); font-size:var(--text-sm); font-weight:500; }
  .computer-summary span { display:block; color:var(--muted-foreground); font-size:var(--text-xs); }
</style>
