<svelte:options runes={true} />

<!--
  The spaces as one tab group in the top bar: icons only, all inside a single
  bordered container, the one you are in on a filled tab; each names itself in
  a tooltip, and a dot marks a space whose work runs while you are elsewhere.
  The top bar spans the window, so the tabs sit at one place whether
  the sidebar is open, closed or Settings is up. It reuses `SegmentedControl`
  for roving tabindex, Arrow/Home/End and the sliding indicator.
-->

<script lang="ts">
  import type { Icon as AppIcon } from '$lib/icons';
  import { Code2, Drama, House, PenTool } from '$lib/icons';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { copy } from '$lib/copy';
  import type { ChatContextMode } from '$lib/types/chat';

  const spaces: Array<{ id: ChatContextMode; label: string; icon: AppIcon }> = [
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    { id: 'design', label: copy.spaces.design, icon: PenTool },
    { id: 'roleplay', label: copy.spaces.roleplay, icon: Drama }
  ];
  const tabs = $derived(spaces.filter((space) => appStore.spaceEnabled(space.id)));
  const busy = $derived<Partial<Record<ChatContextMode, boolean>>>({
    code: Object.values(codeStore.runs).some((run) => run.running),
    design: appStore.chats.some((chat) => chat.contextMode === 'design' && appStore.isChatGenerating(chat.id))
  });
  // The active space needs no dot: its work is already on screen.
  const options = $derived(
    tabs.map((tab) => ({
      value: tab.id,
      label: tab.label,
      icon: tab.icon,
      dot: !!(busy[tab.id] && appStore.activeTab !== tab.id)
    }))
  );

  function activate(id: ChatContextMode) {
    if (appStore.settingsScreenOpen) appStore.closeSettings();
    appStore.setActiveSpace(id);
  }
</script>

<!-- `id="space"` keeps the `space-tab-<space>` ids that AppShell focuses after
     Settings closes. -->
<div class="space-group titlebar-no-drag" class:is-dimmed={appStore.settingsScreenOpen} data-space-switcher>
  <SegmentedControl
    variant="tabs"
    shape="soft"
    id="space"
    controlsPanels={false}
    labels="none"
    class="space-strip"
    label={copy.spaces.label}
    value={appStore.activeTab}
    {options}
    onchange={(next) => activate(next as ChatContextMode)}
  />
</div>

<style>
  /* The bar is a window drag region: without this a press on a tab drags the
     window instead of switching the space. */
  .space-group {
    display: flex;
    align-items: center;
    -webkit-app-region: no-drag;
  }

  /* One container for the group: a hairline border around all the tabs, the
     space in effect on a filled tab inside it. */
  .space-group :global(.space-strip) {
    gap: 0.125rem;
    padding: 0.125rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--float-row-radius) + 0.125rem);
    background: transparent;
  }

  .space-group :global(.space-strip > span[aria-hidden='true']) {
    border: 0;
    border-radius: var(--float-row-radius);
    background: var(--float-row-selected);
    box-shadow: none;
  }

  .space-group :global(.space-strip [role='tab']) {
    width: 1.875rem;
    min-width: 1.875rem;
    height: 1.75rem;
    padding: 0;
    justify-content: center;
    border-radius: var(--float-row-radius);
    color: var(--text-secondary);
  }

  .space-group :global(.space-strip [role='tab'][aria-selected='true']) {
    color: var(--foreground);
  }

  .space-group :global(.space-strip [role='tab']:not([aria-selected='true']):hover) {
    background: var(--float-row-hover);
    color: var(--foreground);
  }

  /* Settings is up: the tab under it is where you return, not where you are. */
  .space-group.is-dimmed :global(.space-strip > span[aria-hidden='true']) {
    background: var(--float-row-hover);
  }
</style>
