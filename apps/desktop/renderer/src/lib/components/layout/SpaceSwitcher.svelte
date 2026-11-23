<svelte:options runes={true} />

<!--
  The spaces, as one segmented control: a soft track with a raised segment on
  the space you are in. It reuses `SegmentedControl` rather than drawing its own
  pills, so the control matches every picker in Settings — and inherits
  roving tabindex, Arrow/Home/End, the sliding indicator and reduced motion.
  Glyphs only: each segment names itself in a tooltip. It heads the sidebar,
  and the titlebar while the sidebar is closed.
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
<div class="space-group titlebar-no-drag" data-space-switcher>
  <SegmentedControl
    variant="tabs"
    shape="soft"
    id="space"
    controlsPanels={false}
    labels="active"
    class="space-strip"
    label={copy.spaces.label}
    value={appStore.activeTab}
    {options}
    onchange={(next) => activate(next as ChatContextMode)}
  />
</div>

<style>
  /* The head is a window drag region: without this a press on a tab drags
     the window instead of switching the space. */
  .space-group {
    display: flex;
    align-items: stretch;
    height: 100%;
    padding-inline: 0.375rem;
    -webkit-app-region: no-drag;
  }

  /* Flush tab strip: no pill track, no floating capsule — just clean tabs
     with a sliding 2px accent underline on the active space. */
  .space-group :global(.space-strip) {
    align-items: stretch;
    gap: 0.125rem;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .space-group :global(.space-strip > span[aria-hidden='true']) {
    top: auto !important;
    bottom: 0;
    height: 2px !important;
    border: 0;
    border-radius: 9999px;
    background: var(--brand-accent);
    box-shadow: none;
  }

  .space-group :global(.space-strip [role='tab']) {
    height: 100%;
    min-height: 2rem;
    border-radius: 0;
  }
</style>
