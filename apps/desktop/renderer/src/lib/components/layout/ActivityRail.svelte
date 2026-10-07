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
-->

<script lang="ts">
  import { Bot, Code2, Drama, House, Settings as SettingsIcon } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import type { ChatContextMode } from '$lib/types/chat';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';

  type TabId = ChatContextMode | 'bots';
  const tabs: Array<{ id: TabId; label: string; icon: typeof House }> = [
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    { id: 'roleplay', label: copy.spaces.roleplay, icon: Drama },
    { id: 'bots', label: copy.spaces.bots, icon: Bot }
  ];

  /** A space with work going on in it shows a quiet dot, so the rail reports as well as navigates. */
  const busy = $derived<Partial<Record<TabId, boolean>>>({
    code: Object.values(codeStore.runs).some((run) => run.running),
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

<nav class="activity-rail" data-activity-rail aria-label={copy.spaces.label}>
  <div class="rail-group" role="tablist" tabindex="-1" aria-label={copy.spaces.label} onkeydown={onSpacesKeydown}>
    {#each tabs as tab (tab.id)}
      {@const Icon = tab.icon}
      <!-- One screen at a time: while Settings is up, no space is the current
           one, so the rail never shows two active rows at once. -->
      {@const active = !appStore.settingsScreenOpen && appStore.activeTab === tab.id}
      <Tooltip label={tab.label} position="right">
        <button
          type="button"
          class="rail-button ui-icon-button"
          class:is-active={active}
          role="tab"
          id={`space-tab-${tab.id}`}
          tabindex={active ? 0 : -1}
          aria-selected={active}
          aria-label={tab.label}
          onclick={() => activate(tab.id)}
        >
          <Icon aria-hidden="true" />
          {#if busy[tab.id] && !active}<span class="busy-dot" aria-hidden="true"></span>{/if}
        </button>
      </Tooltip>
    {/each}
  </div>

  <!-- Settings anchors the rail bottom, one click away from anywhere. -->
  <div class="rail-bottom">
    <Tooltip label={$t('sidebar.settings')} shortcut="mod+," position="right">
      <button
        type="button"
        class="rail-button ui-icon-button"
        class:is-active={appStore.settingsScreenOpen}
        data-activity-settings
        aria-label={$t('sidebar.settings')}
        aria-pressed={appStore.settingsScreenOpen}
        onclick={toggleSettings}
      >
        <SettingsIcon aria-hidden="true" />
      </button>
    </Tooltip>
  </div>
</nav>

<style>
  /* One continuous plane with the sidebar, split by a single hairline. Nothing
     in it is boxed: a glyph is muted until hovered, and the current space is the
     only filled thing on the strip. */
  .activity-rail {
    display: flex;
    width: var(--rail-w);
    flex-shrink: 0;
    flex-direction: column;
    align-items: center;
    padding-block: 0.625rem;
    background: var(--rail-bg);
    border-right: 1px solid var(--border);
  }

  .rail-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    outline: none;
  }

  .rail-bottom {
    display: flex;
    margin-top: auto;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .rail-button {
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
  .rail-button:hover {
    background: var(--float-row-hover);
    border-color: transparent;
    color: var(--foreground);
  }

  /* Lucide scales its stroke with the glyph; 1.9 reads at ~1.3px on 16px. */
  .rail-button :global(svg) {
    stroke-width: 1.9;
  }

  /* The current space: a tinted chip plus an accent tick on the rail's edge.
     --nav-current-bg sits a shade off --rail-bg, too close to read here. */
  .rail-button.is-active,
  .rail-button.is-active:hover {
    background: color-mix(in srgb, var(--foreground) 9%, transparent);
    border-color: transparent;
    box-shadow: inset 0 0 0 1px var(--border-subtle);
    color: var(--foreground);
  }
  .rail-button.is-active::before {
    content: '';
    position: absolute;
    left: calc((var(--rail-btn) - var(--rail-w)) / 2 + 1px);
    top: 25%;
    bottom: 25%;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--brand-accent);
  }
  @media (prefers-reduced-motion: no-preference) {
    .rail-button { transition: background-color var(--motion-fast), color var(--motion-fast); }
  }

  .busy-dot {
    position: absolute;
    top: 0.3125rem;
    right: 0.3125rem;
    inline-size: 0.375rem;
    block-size: 0.375rem;
    border-radius: 9999px;
    background: var(--brand-accent);
    box-shadow: 0 0 0 2px var(--sidebar);
    animation: rail-pulse 1.6s ease-in-out infinite;
  }
  @keyframes rail-pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .busy-dot { animation: none; } }

  .rail-button:focus-visible {
    outline: 2px solid var(--brand-accent);
    outline-offset: -2px;
  }
</style>
