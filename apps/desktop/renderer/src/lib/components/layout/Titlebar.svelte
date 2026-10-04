<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import DownloadsButton from './DownloadsButton.svelte';
  import { onMount } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { ArrowLeft, MoonStar, SunMedium } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { Button } from '$lib/components/ui';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import PanelTabs from './PanelTabs.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import TitlebarLeftTools from './TitlebarLeftTools.svelte';

  let { sidebarPreview = false, settingsOpen = false, onSidebarEnter, onSidebarLeave, onSidebarToggle }: {
    sidebarPreview?: boolean;
    /** Settings owns the window, so the bar's own tools stay out of the way. */
    settingsOpen?: boolean;
    onSidebarEnter: () => void;
    onSidebarLeave: (event: PointerEvent) => void;
    onSidebarToggle: () => void;
  } = $props();

  /** The open Code conversation, when there is one: its pane toggles live here. */
  const codeChat = $derived.by(() => {
    const chat = appStore.currentChat;
    return appStore.activeTab === 'code' && chat && chat.projectId && isCodeSession(chat) ? chat : null;
  });
  const codeProject = $derived(codeStore.projectById(codeChat?.projectId ?? null));

  const platform = typeof window !== 'undefined' ? (window.electronAPI?.platform ?? 'linux') : 'linux';
  const isMac = platform === 'darwin';

  let safeEl = $state<HTMLElement | undefined>(undefined);

  type OverlayControls = EventTarget & {
    getTitlebarAreaRect(): { x: number; width: number };
  };
  function overlayControls(): OverlayControls | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as Navigator & { windowControlsOverlay?: OverlayControls }).windowControlsOverlay;
  }

  /**
   * Trailing reserve for the OS caption buttons, measured live. The CSS
   * `titlebar-area-*` env can lag window-state changes, so the overlay rect
   * is read directly and kept fresh on resize plus the overlay's own
   * `geometrychange`. Without an overlay the vars stay unset and the bar
   * falls back to full width with a plain gap.
   */
  function syncCaptionReserve() {
    if (!safeEl || typeof window === 'undefined') return;
    let rect: { x: number; width: number } | undefined;
    try {
      rect = overlayControls()?.getTitlebarAreaRect();
    } catch {
      rect = undefined;
    }
    if (!rect) {
      safeEl.style.removeProperty('--caption-inline-start');
      safeEl.style.removeProperty('--caption-reserve');
      return;
    }
    safeEl.style.setProperty('--caption-inline-start', `${Math.max(0, Math.round(rect.x))}px`);
    safeEl.style.setProperty(
      '--caption-reserve',
      `${Math.max(12, Math.ceil(window.innerWidth - rect.x - rect.width) + 12)}px`
    );
  }

  $effect(() => {
    if (safeEl) syncCaptionReserve();
  });

  onMount(() => {
    void downloadsStore.refresh();
    syncCaptionReserve();
    const overlay = overlayControls();
    window.addEventListener('resize', syncCaptionReserve);
    overlay?.addEventListener('geometrychange', syncCaptionReserve);
    return () => {
      window.removeEventListener('resize', syncCaptionReserve);
      overlay?.removeEventListener('geometrychange', syncCaptionReserve);
    };
  });
</script>

<!--
  No caption buttons here, on any platform. The window is frameless, so on
  Windows and Linux the OS draws minimize/maximize/close itself through
  `titleBarOverlay`, and on macOS `titleBarStyle: 'hiddenInset'` leaves the
  real traffic lights in place. Both sit outside the web contents, so Electron
  reports the free area as `env(titlebar-area-*)` and `.titlebar-safe` stays
  inside it. Hover states, hit areas at every DPI, the Win11 snap-layout
  flyout, the system menu and the maximized restore glyph all come from the OS
  that way — none of it survives being hand-drawn as SVG.
-->

<!-- Downloads and theme ride the titlebar right; spaces and Settings live in
     the activity rail. Pane toggles sit in the PanelTabs strip below. -->
{#snippet appTools()}
  <div class="flex items-center gap-0.5">
    <DownloadsButton />
    <Tooltip label={$t('titlebar.theme')} position="bottom">
      <button
        class="ui-icon-button"
        onclick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          themeStore.toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }}
        aria-label={$t('titlebar.theme')}
      >
        {#if themeStore.current === 'dark'}
          <SunMedium class="size-4" />
        {:else}
          <MoonStar class="size-4" />
        {/if}
      </button>
    </Tooltip>
  </div>
{/snippet}
<div
  class="titlebar-row titlebar-drag relative z-20 h-9 shrink-0 select-none bg-background"
  class:is-mac={isMac}
  role="banner"
>
  {#if settingsOpen}
    <!-- Seamless sidebar continuation to topbar -->
    <div
      class="pointer-events-none absolute inset-y-0 left-0 w-[220px] border-r border-[var(--border)] bg-sidebar"
      aria-hidden="true"
    ></div>
  {/if}

  <div class="titlebar-safe" bind:this={safeEl}>
    <div class="titlebar-left flex min-w-0 items-center">
      {#if !settingsOpen}
        <TitlebarLeftTools expanded={appStore.sidebarOpen || sidebarPreview} onToggle={onSidebarToggle} onEnter={onSidebarEnter} onLeave={onSidebarLeave} />
      {:else}
        <div class="flex items-center gap-1.5 pl-1.5">
          <Tooltip label={$t('shortcuts.backToConversation')}>
            <button
              type="button"
              class="ui-icon-button titlebar-no-drag"
              onclick={() => appStore.closeSettings()}
              aria-label={$t('shortcuts.backToConversation')}
            >
              <ArrowLeft class="size-4" />
            </button>
          </Tooltip>
          <span class="text-xs font-semibold text-foreground px-1">{$t('sidebar.settings')}</span>
        </div>
      {/if}
    </div>

    <div class="titlebar-center flex min-w-0 flex-1 items-center"></div>

    <div class="titlebar-right flex items-center justify-end">
      {@render appTools()}
    </div>
  </div>
</div>

<!-- One strip for the panes of whichever space is open. It lives below the
     title bar so the bar keeps global chrome only and neither group has to
     compete for the same pixels. -->
{#if !settingsOpen}
  <PanelTabs chat={codeChat} project={codeProject} />
{/if}

<style>
  .titlebar-row {
    position: relative;
    width: 100%;
    container-type: inline-size;
    border-bottom: none;
  }

  /*
   * Clearance for the OS caption buttons, measured live (see
   * syncCaptionReserve): the overlay rect is read directly and stored as
   * vars, so the reserve tracks minimize/maximize/close exactly — no fixed
   * caption width to overshoot narrower setups, and no env measurement to
   * go stale across window-state changes. Without an overlay the vars stay
   * unset: full width, plain gap.
   */
  .titlebar-safe {
    width: calc(100% - var(--caption-inline-start, 0px));
    margin-inline-start: var(--caption-inline-start, 0px);
    height: 100%;
    padding-inline-end: max(0.75rem, var(--caption-reserve, 0px));
    display: grid;
    /* Symmetric side tracks so the drag space stays balanced. The `0`
       minimums matter: `max-content` tracks would refuse to shrink and push
       content under the native caption controls. */
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    overflow: hidden;
  }

  /*
   * macOS paints no overlay, so there is no `titlebar-area-*` to inset by. Its
   * traffic lights still sit on top of the content, so reserve their width
   * here instead, at the system inset.
   */
  .titlebar-row.is-mac .titlebar-safe {
    padding-inline-start: 78px;
  }

  .titlebar-center {
    justify-self: center;
    overflow: hidden;
  }

  .titlebar-right {
    justify-self: end;
    overflow: hidden;
  }

  .titlebar-left {
    flex-shrink: 0;
    justify-self: start;
    overflow: hidden;
  }

  @container (max-width: 520px) {
    .titlebar-center { padding-inline: 0.25rem; }
  }
  @container (max-width: 400px) {
    .titlebar-left :global(.titlebar-secondary) { display: none; }
  }
</style>