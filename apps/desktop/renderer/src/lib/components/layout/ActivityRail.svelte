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

  type TabId = ChatContextMode | 'bots';
  const tabs: Array<{ id: TabId; label: string; icon: typeof House }> = [
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    { id: 'roleplay', label: copy.spaces.roleplay, icon: Drama },
    { id: 'bots', label: copy.spaces.bots, icon: Bot }
  ];

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
        </button>
      </Tooltip>
    {/each}
  </div>

  <!-- Settings anchors the rail bottom, one click away from anywhere. -->
  <div class="rail-bottom">
    <Tooltip label={$t('sidebar.settings')} position="right">
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
  /* Its own plane: a step off the sidebar surface (--rail-bg) plus the one
     hairline that separates the two columns. */
  .activity-rail {
    display: flex;
    width: var(--rail-w);
    flex-shrink: 0;
    flex-direction: column;
    align-items: center;
    padding-block: 0.75rem;
    /* The fallback keeps an unresolved color-mix from painting the rail through. */
    background: var(--rail-bg, var(--sidebar));
    border-right: 1px solid var(--border);
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

  .rail-button {
    width: var(--rail-btn);
    height: var(--rail-btn);
    /* The app's selected row is a soft squircle, not a disc: the same shape the
       settings rail uses, so one look carries both strips. */
    border-radius: 0.5rem;
    /* The chrome's 14px mark is too small for a 52px strip. `.ui-icon-button`
       already sizes its svg from --icon, so the rail rebinds the token here;
       the `size-4` utility that used to sit on the icon lost to that rule on
       specificity and never took effect. */
    --icon: var(--rail-icon);
  }

  /* Lucide scales its stroke with the glyph, so an 18px mark carries 0.75x the
     weight it has at 24px. 2.1 lands at ~1.6px: a hair above the default 1.5px
     the chrome's marks read at, without the heaviness of a full step up. */
  .rail-button :global(svg) {
    stroke-width: 2.1;
  }

  .rail-button.is-active {
    background: var(--surface-active);
    color: var(--foreground);
    /* The fill alone floats on the rail's own surface; the hairline seats it. */
    border: 1px solid var(--border-hover);
  }

  /* `.ui-icon-button` drops the browser outline, so keyboard focus needs the
     app's own ring — the rail is roving-focus and was invisible when tabbed to. */
  .rail-button:focus-visible {
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ring) 45%, transparent);
  }
</style>
