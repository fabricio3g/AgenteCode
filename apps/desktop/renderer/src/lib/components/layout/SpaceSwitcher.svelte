<svelte:options runes={true} />

<!--
  The space switcher: the sidebar's head row, five glyphs on one line.

  Tabs on the app's segmented track, the width of the column. It replaced
  the activity rail, a 44px column that sat beside the sidebar on
  its own plane: in dark it read as a black strip the sidebar's list did not
  share, and it carried the app mark the title bar never needed. The spaces
  now head the list they switch, so the left edge is one column again. The row
  sits level with the title bar and is a drag region like it.

  `lead` draws before the glyphs: the floating preview puts the title bar's
  sidebar toggle there, in the same spot it occupies on the sheet. Settings is
  the sidebar footer's row; while the sidebar is away the title bar's toggle
  and Ctrl+, reach both.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Bot, Code2, Drama, House, PenTool } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import type { ChatContextMode } from '$lib/types/chat';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';

  let { lead }: { lead?: Snippet } = $props();

  /** macOS draws its traffic lights over the window's top-left: the glyphs start after them. */
  const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

  type TabId = ChatContextMode | 'bots';
  const spaces: Array<{ id: TabId; label: string; icon: typeof House }> = [
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    { id: 'design', label: copy.spaces.design, icon: PenTool },
    { id: 'bots', label: copy.spaces.bots, icon: Bot },
    { id: 'roleplay', label: copy.spaces.roleplay, icon: Drama }
  ];
  /** The core spaces first; Bots and Roleplay last, since Settings → General can switch them off. */
  const tabs = $derived(spaces.filter((tab) =>
    tab.id === 'bots' ? appStore.botsEnabled : tab.id === 'roleplay' ? appStore.roleplayEnabled : true
  ));

  /** A space with work going on in it shows a quiet dot, so the row reports as well as navigates. */
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
    appStore.setActiveSpace(id);
  }

  /** Roving focus across the spaces: arrows walk the row, Home/End jump to its ends. */
  function onKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === appStore.activeTab);
    const at = index < 0 ? 0 : index;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activate(tabs[next].id);
    queueMicrotask(() => document.getElementById(`space-tab-${tabs[next].id}`)?.focus());
  }
</script>

<div class="space-head" class:is-mac={isMac && !lead} class:has-lead={!!lead} data-space-switcher>
  {#if lead}{@render lead()}{/if}
  <div class="ui-segmented ui-segmented-fill space-group" role="tablist" tabindex="-1" aria-label={copy.spaces.label} onkeydown={onKeydown}>
    {#each tabs as tab (tab.id)}
      {@const Icon = tab.icon}
      {@const active = appStore.activeTab === tab.id}
      <Tooltip label={tab.label} position="bottom" class="space-slot">
        <UiIconButton label={tab.label} size="sm"
          type="button"
          class={uiClass("ui-segmented-item space-button", "ui-local-5b1e07c3", {"is-active": active})}
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
</div>

<style>
  /* Level with the title bar: the sheet starts --sheet-gap below the window
     top, and its bar is 2.25rem tall, so the row's centre line is the bar's. */
  .space-head {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    block-size: calc(var(--sheet-gap) + 2.25rem);
    padding-block-start: var(--sheet-gap);
    padding-inline: 0.5rem;
    -webkit-app-region: drag;
  }
  .space-head.is-mac { padding-inline-start: 78px; }
  /* The lead brings its own inset, the title bar's (TitlebarLeftTools). */
  .space-head.has-lead { padding-inline-start: 0; }
  .space-head :global(button) { -webkit-app-region: no-drag; }

  /* The app's segmented track (app.css .ui-segmented), run the width of the
     column: five equal tabs, the current one a raised pill. */
  .space-group {
    flex: 1;
    min-width: 0;
    outline: none;
  }
  .space-group :global(.space-slot) { flex: 1 1 0; min-width: 0; }

  :global(.space-button.ui-local-5b1e07c3) {
    position: relative;
    inline-size: 100%;
    height: var(--space-btn);
    border-color: transparent;
    box-shadow: none;
    --icon: var(--space-icon);
  }
  /* Lucide scales its stroke with the glyph; 1.75 reads at ~1.2px on 16px. */
  :global(.space-button.ui-local-5b1e07c3) :global(svg) {
    width: var(--space-icon);
    height: var(--space-icon);
    stroke-width: 1.75;
  }
  :global(.space-button.is-active.ui-local-5b1e07c3) {
    background: var(--segment-active-bg);
    box-shadow: var(--segment-active-shadow);
    color: var(--foreground);
  }
  :global(.space-button.is-active.ui-local-5b1e07c3) :global(svg) { stroke-width: 2; }
  :global(.space-button:focus-visible.ui-local-5b1e07c3) {
    outline: 2px solid var(--brand-accent);
    outline-offset: -2px;
  }

  .busy-dot {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    inline-size: 0.375rem;
    block-size: 0.375rem;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
    box-shadow: 0 0 0 2px var(--muted);
    animation: space-pulse 1.6s ease-in-out infinite;
  }
  @keyframes space-pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .busy-dot { animation: none; } }
</style>
