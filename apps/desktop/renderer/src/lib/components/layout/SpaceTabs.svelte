<svelte:options runes={true} />
<script lang="ts">
  import { Code2, Drama, House } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import type { ChatContextMode } from '$lib/types/chat';

  const tabs: Array<{ id: ChatContextMode; label: string; icon: typeof House }> = [
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    { id: 'roleplay', label: copy.spaces.roleplay, icon: Drama }
  ];
  function activate(id: ChatContextMode) {
    if (id === 'roleplay' && !appStore.roleplayEnabled) void appStore.setRoleplayEnabled(true);
    appStore.setActiveSpace(id);
  }
  function onKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === appStore.activeSpace);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activate(tabs[next].id);
    queueMicrotask(() => document.getElementById(`space-tab-${tabs[next].id}`)?.focus());
  }
</script>

<div class="space-tabs aui-segmented titlebar-no-drag" role="tablist" tabindex="-1" aria-label="Session type" onkeydown={onKeydown} ondblclick={(event) => event.stopPropagation()}>
  {#each tabs as tab (tab.id)}
    {@const Icon = tab.icon}
    <Tooltip label={tab.label} position="bottom">
      <button type="button" class="space-tab aui-segmented-item" class:is-active={appStore.activeSpace === tab.id} role="tab" id={`space-tab-${tab.id}`}
        tabindex={appStore.activeSpace === tab.id ? 0 : -1} aria-selected={appStore.activeSpace === tab.id} aria-label={tab.label} onclick={() => activate(tab.id)}>
        <Icon class="size-4" />
      </button>
    </Tooltip>
  {/each}
</div>

<style>
  .space-tabs { -webkit-app-region: no-drag; pointer-events: auto; }
  .space-tab { width: 2rem; height: 1.75rem; }
  .space-tab:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
  @media (prefers-reduced-motion: reduce) { .space-tab { transition: none; } }
</style>
