<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import DownloadsButton from './DownloadsButton.svelte';
  import { onMount } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { MoonStar, SunMedium, ArrowLeft } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { Button } from '$lib/components/ui';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import PanelTabs from './PanelTabs.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import SpaceTabs from './SpaceTabs.svelte';
  import TitlebarLeftTools from './TitlebarLeftTools.svelte';

  let { sidebarPreview = false, settingsOpen = false, onleaveSettings, onSidebarEnter, onSidebarLeave, onSidebarToggle }: {
    sidebarPreview?: boolean;
    /** Settings owns the window: no sidebar, no tools, one way back. */
    settingsOpen?: boolean;
    onleaveSettings?: () => void;
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

  onMount(() => {
    void downloadsStore.refresh();
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

<!-- The app's own buttons, the same on every platform: downloads and theme.
     The agent browser used to sit here too, but a pane belongs with the other
     panes, and five Code panes plus this row ran into the caption buttons. -->
{#snippet appTools()}
  <div class="titlebar-app-tools flex items-center">
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
  <div class="titlebar-safe">
    <div class="titlebar-left flex min-w-0 items-center">
      <!-- Settings takes the whole window: the sidebar and its tools are gone,
           and the one button that matters stands where they were. -->
      {#if settingsOpen}
        <div class="titlebar-no-drag flex min-w-0 items-center">
          <Button variant="ghost" size="sm" data-back-to-chat onclick={() => onleaveSettings?.()}>
            <ArrowLeft class="size-3.5" />
            {$t('settingsNav.backToChat')}
          </Button>
        </div>
      {:else}
        <TitlebarLeftTools expanded={appStore.sidebarOpen || sidebarPreview} onToggle={onSidebarToggle} onEnter={onSidebarEnter} onLeave={onSidebarLeave} />
      {/if}
    </div>

    {#if !settingsOpen}
      <div class="titlebar-center titlebar-no-drag flex min-w-0 items-center justify-center gap-1.5 px-3">
        <SpaceTabs />
      </div>
    {:else}
      <div class="titlebar-center flex min-w-0 flex-1 items-center"></div>
    {/if}

    <div class="titlebar-right flex items-center justify-end">
      {#if !settingsOpen}{@render appTools()}{/if}
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
   * The area the OS caption buttons leave free. Electron measures it from the
   * window edge and updates it per DPI and per user setting, so it stays
   * correct under RTL and when the user moves the controls to the left — none
   * of which a hardcoded button width survives. The trailing pad is on top of
   * that measurement: it keeps the app's own right-hand buttons off the OS
   * glyphs, which `titlebar-area-width` alone does not guarantee on Windows.
   */
  .titlebar-safe {
    width: env(titlebar-area-width, 100%);
    margin-inline-start: env(titlebar-area-x, 0px);
    height: 100%;
    padding-inline-end: 0.5rem;
    display: grid;
    /* Symmetric side tracks so the space tabs sit dead centre. The `0`
       minimums matter: `max-content` tracks would refuse to shrink and push
       the right-hand buttons under the native caption controls. */
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
    .titlebar-app-tools { display: none; }
    .titlebar-center { padding-inline: 0.25rem; }
  }
  @container (max-width: 400px) {
    .titlebar-left :global(.titlebar-secondary) { display: none; }
  }
</style>