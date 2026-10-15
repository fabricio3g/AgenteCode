<svelte:options runes={true} />

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import DownloadsButton from './DownloadsButton.svelte';
  import { onMount } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { ArrowLeft, Globe, MoonStar, SunMedium } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { Button } from '$lib/components/ui';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { browserPanelStore, type BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { untrack } from 'svelte';
  import { workspaceLayout, type WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import { conversationScope } from '$shared/workspace-scope';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import PanelTabs from './PanelTabs.svelte';
  import TitlebarLeftTools from './TitlebarLeftTools.svelte';
  import WindowControls from './WindowControls.svelte';

  let { sidebarPreview = false, settingsOpen = false, onSidebarEnter, onSidebarLeave, onSidebarToggle }: {
    sidebarPreview?: boolean;
    /** Settings owns the window, so the bar's own tools stay out of the way. */
    settingsOpen?: boolean;
    onSidebarEnter: () => void;
    onSidebarLeave: (event: PointerEvent) => void;
    onSidebarToggle: () => void;
  } = $props();

  /** The open Code conversation: its tools sit in this bar unless the centre is split. */
  const codeChat = $derived.by(() => {
    const chat = appStore.currentChat;
    return appStore.activeTab === 'code' && chat && chat.projectId && isCodeSession(chat) ? chat : null;
  });
  const codeProject = $derived(codeStore.projectById(codeChat?.projectId ?? null));
  const scope = $derived(codeChat ? conversationScope(codeChat.id) : null);
  // The conversation's own stores are created on demand, which writes state: that
  // belongs in an effect, never in a $derived or the template.
  let chatLayout = $state<WorkspaceLayoutStore>(workspaceLayout);
  let chatBrowser = $state<BrowserPanelStore>(browserPanelStore);
  $effect(() => {
    const id = scope;
    untrack(() => {
      chatLayout = id ? workspaceLayout.scoped(id) : workspaceLayout;
      chatBrowser = id ? browserPanelStore.forScope(id) : browserPanelStore;
    });
  });
  // Settings owns the window: a conversation's pane toggles have nothing to act on there.
  const toolsHere = $derived(!settingsOpen && !!codeChat && !!codeProject && workspaceLayout.panes.length < 2);

  const platform = typeof window !== 'undefined' ? (window.electronAPI?.platform ?? 'linux') : 'linux';
  const isMac = platform === 'darwin';

  let safeEl = $state<HTMLElement | undefined>(undefined);

  type OverlayControls = EventTarget & {
    visible?: boolean;
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
      // A window without a caption overlay (Linux draws its own buttons) still
      // exposes the API, with an empty rect: reserving from it pushed every
      // button on the right out of the bar.
      const overlay = overlayControls();
      rect = overlay?.visible ? overlay.getTitlebarAreaRect() : undefined;
    } catch {
      rect = undefined;
    }
    if (!rect || rect.width <= 0) {
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
     the activity rail. Code pane toggles live with each conversation. -->
{#snippet appTools()}
  <div class="flex items-center gap-0.5">
    {#if toolsHere && codeChat && codeProject}
      <div class="titlebar-no-drag flex items-center">
        <PanelTabs inline chat={codeChat} project={codeProject} layout={chatLayout} browser={chatBrowser} />
      </div>
      <span class="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden="true"></span>
    {/if}
    <!-- Home, Roleplay and Bots have no pane strip, so the browser opens from here.
         Code draws the same globe in its strip, on the conversation's own browser. -->
    {#if !codeChat}
      <Tooltip label={$t('browser.title')} position="bottom">
        <UiIconButton label={$t('browser.title')} size="sm"
          type="button"
          class={uiClass(" titlebar-no-drag", {"selected": browserPanelStore.open})}

          aria-pressed={browserPanelStore.open}

          data-panel-tab="browser"
          onclick={() => void browserPanelStore.toggle().catch((error) => toastStore.error(String(error)))}
        >
          <Globe class="size-4" />
        </UiIconButton>
      </Tooltip>
    {/if}
    <DownloadsButton />
    <Tooltip label={$t('titlebar.theme')} position="bottom">
      <UiIconButton label={$t('titlebar.theme')} size="sm"

        onclick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          themeStore.toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }}

      >
        {#if themeStore.current === 'dark'}
          <SunMedium class="size-4" />
        {:else}
          <MoonStar class="size-4" />
        {/if}
      </UiIconButton>
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
      class="pointer-events-none absolute inset-y-0 left-0 w-[236px] border-r border-[var(--border)] bg-sidebar"
      aria-hidden="true"
    ></div>
  {/if}

  <div class="titlebar-safe" bind:this={safeEl}>
    <div class="titlebar-left flex min-w-0 items-center">
      {#if !settingsOpen}
        <TitlebarLeftTools expanded={appStore.sidebarOpen || sidebarPreview} onToggle={onSidebarToggle} onEnter={onSidebarEnter} onLeave={onSidebarLeave} />
      {:else}
        <div class="flex items-center gap-1.5 pl-1.5">
          <Tooltip label={$t('shortcuts.backToConversation')} shortcut="escape">
            <UiIconButton label={$t('shortcuts.backToConversation')} size="sm"
              type="button"
              class={uiClass(" titlebar-no-drag")}
              onclick={() => appStore.closeSettings()}

            >
              <ArrowLeft class="size-4" />
            </UiIconButton>
          </Tooltip>
          <span class="px-1 text-[length:var(--text-sm)] font-semibold text-foreground">{$t('sidebar.settings')}</span>
        </div>
      {/if}
    </div>

    <div class="titlebar-center flex min-w-0 flex-1 items-center"></div>

    <div class="titlebar-right flex items-center justify-end">
      {@render appTools()}
      <WindowControls />
    </div>
  </div>
</div>

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
    /* Above the settings strip (absolute, painted first) so its back button shows. */
    position: relative;
    z-index: 1;
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
