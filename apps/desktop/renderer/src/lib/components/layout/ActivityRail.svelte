<svelte:options runes={true} />

<!--
  The activity rail: the window's always-on icon strip beside the sidebar.

  It owns the doors that used to live in two places — the space tabs in the
  titlebar center and the Settings row in the sidebar footer. Downloads and
  the theme toggle ride the titlebar right, clear of the OS caption buttons.
  Unlike the sidebar the rail never collapses and it stays up while Settings
  owns the content area, so every space stays one click away from anywhere.
  Icon-only throughout: every button carries its label in the shared Tooltip
  on hover and focus.

  It is the sidebar's own plane, not a strip beside it: same surface, same
  hover band, and the current space wears the sidebar's current-row face, so
  rail and list read as one column. The app mark heads it, as an app's
  identity, not a button.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Bot, Code2, Drama, House, PenTool, Settings as SettingsIcon } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import type { ChatContextMode } from '$lib/types/chat';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';

  /** macOS draws its traffic lights over the window's top-left: the mark starts below them. */
  const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

  type TabId = ChatContextMode | 'bots';
  const tabs: Array<{ id: TabId; label: string; icon: typeof House }> = [
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    { id: 'roleplay', label: copy.spaces.roleplay, icon: Drama },
    { id: 'design', label: copy.spaces.design, icon: PenTool },
    { id: 'bots', label: copy.spaces.bots, icon: Bot }
  ];

  /** A space with work going on in it shows a quiet dot, so the rail reports as well as navigates. */
  const busy = $derived<Partial<Record<TabId, boolean>>>({
    code: Object.values(codeStore.runs).some((run) => run.running),
    design: appStore.chats.some((chat) => chat.contextMode === 'design' && appStore.isChatGenerating(chat.id)),
    bots: botsStore.working.length > 0
  });

  function activate(id: TabId) {
    if (appStore.settingsScreenOpen) {
      appStore.closeSettings();
    }
    if (id === 'bots') {
      appStore.showBots();
      return;
    }
    if (id === 'roleplay' && !appStore.roleplayEnabled) void appStore.setRoleplayEnabled(true);
    appStore.setActiveSpace(id);
  }

  /**
   * Settings is a screen like the spaces, not a modal: picking it again leaves.
   * Without the toggle the only way back would be Escape or Ctrl+, once the
   * screen paints over the title bar that used to hold the button.
   */
  function toggleSettings() {
    if (appStore.settingsScreenOpen) appStore.closeSettings();
    else appStore.openSettings('general');
  }

  /** Roving focus across the spaces, the same grammar the titlebar tabs used. */
  function onSpacesKeydown(event: KeyboardEvent) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === appStore.activeTab);
    const at = index < 0 ? 0 : index;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
    activate(tabs[next].id);
    queueMicrotask(() => document.getElementById(`space-tab-${tabs[next].id}`)?.focus());
  }

</script>

<nav class="activity-rail" class:is-mac={isMac} data-activity-rail aria-label={copy.spaces.label}>
  <img class="rail-mark" src="./app-icon.svg" alt="" aria-hidden="true" draggable="false" />
  <div class="rail-group" role="tablist" tabindex="-1" aria-label={copy.spaces.label} onkeydown={onSpacesKeydown}>
    {#each tabs as tab (tab.id)}
      {@const Icon = tab.icon}
      <!-- One screen at a time: while Settings is up, no space is the current
           one, so the rail never shows two active rows at once. -->
      {@const active = !appStore.settingsScreenOpen && appStore.activeTab === tab.id}
      <Tooltip label={tab.label} position="right">
        <UiIconButton label={tab.label} size="sm"
          type="button"
          class={uiClass("rail-button ", "ui-local-e822ba2f", {"is-active": active})}

          role="tab"
          id={`space-tab-${tab.id}`}
          tabindex={active ? 0 : -1}
          aria-selected={active}

          onclick={() => activate(tab.id)}
        >
          <Icon aria-hidden="true" />
          {#if busy[tab.id] && !active}<span class="busy-dot" aria-hidden="true"></span>{/if}
        </UiIconButton>
      </Tooltip>
    {/each}
  </div>

  <!-- Settings anchors the rail bottom, one click away from anywhere. -->
  <div class="rail-bottom">
    <Tooltip label={$t('sidebar.settings')} shortcut="mod+," position="right">
      <UiIconButton label={$t('sidebar.settings')} size="sm"
        type="button"
        class={uiClass("rail-button ", "ui-local-e822ba2f", {"is-active": appStore.settingsScreenOpen})}

        data-activity-settings

        aria-pressed={appStore.settingsScreenOpen}
        onclick={toggleSettings}
      >
        <SettingsIcon aria-hidden="true" />
      </UiIconButton>
    </Tooltip>
  </div>
</nav>

<style>
  /* The sidebar's plane, the ground the canvas sheet rests on. Nothing in it is boxed:
     a glyph is muted until hovered, and the current space is the only raised
     thing on the strip — the same raised row the sidebar uses for its current
     conversation. */
  .activity-rail {
    display: flex;
    width: var(--rail-w);
    flex-shrink: 0;
    flex-direction: column;
    align-items: center;
    gap: 0.875rem;
    padding-block: 0.625rem;
    background: var(--sidebar);
    -webkit-app-region: drag;
  }
  .activity-rail.is-mac { padding-top: 2.5rem; }
  .activity-rail :global(button) { -webkit-app-region: no-drag; }

  /* Brand colours are fixed across themes, like the hero's mark. */
  .rail-mark {
    inline-size: var(--rail-logo);
    block-size: var(--rail-logo);
    flex-shrink: 0;
    user-select: none;
  }

  .rail-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    outline: none;
  }

  .rail-bottom {
    display: flex;
    margin-top: auto;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  :global(.rail-button.ui-local-e822ba2f) {
    position: relative;
    width: var(--rail-btn);
    height: var(--rail-btn);
    border-radius: var(--float-row-radius);
    /* Plain glyph: the shared icon button's ring and shadow are chrome the rail
       does not need. */
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    color: var(--muted-foreground);
    --icon: var(--rail-icon);
  }
  :global(.rail-button:hover.ui-local-e822ba2f) {
    background: var(--float-row-hover);
    border-color: transparent;
    color: var(--foreground);
  }

  /* Lucide scales its stroke with the glyph; 1.75 reads at ~1.2px on 16px. */
  :global(.rail-button.ui-local-e822ba2f) :global(svg) {
    width:var(--rail-icon);
    height:var(--rail-icon);
    stroke-width: 1.75;
  }

  /* The current space: the sidebar's current-row face, nothing extra. */
  :global(.rail-button.is-active.ui-local-e822ba2f),
  :global(.rail-button.is-active:hover.ui-local-e822ba2f) {
    background: var(--nav-current-bg);
    border-color: transparent;
    box-shadow: var(--nav-current-ring), var(--control-shadow);
    color: var(--foreground);
  }
  :global(.rail-button.is-active.ui-local-e822ba2f) :global(svg) { stroke-width: 2; }
  @media (prefers-reduced-motion: no-preference) {
    :global(.rail-button.ui-local-e822ba2f) { transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease); }
  }

  .busy-dot {
    position: absolute;
    top: 0.3125rem;
    right: 0.3125rem;
    inline-size: 0.375rem;
    block-size: 0.375rem;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
    box-shadow: 0 0 0 2px var(--sidebar);
    animation: rail-pulse 1.6s ease-in-out infinite;
  }
  @keyframes rail-pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .busy-dot { animation: none; } }

  :global(.rail-button:focus-visible.ui-local-e822ba2f) {
    outline: 2px solid var(--brand-accent);
    outline-offset: -2px;
  }
</style>
