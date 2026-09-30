<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import DownloadsButton from './DownloadsButton.svelte';
  import { onMount } from 'svelte';
  import { appWindow } from '$lib/services/window';
  import { appStore } from '$lib/stores/app.svelte';
  import { Search, SlidersHorizontal, MoonStar, SunMedium, Globe, PanelLeftClose, PanelLeftOpen } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import CodeTitlebarTools from '$lib/features/code/CodeTitlebarTools.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import SpaceTabs from './SpaceTabs.svelte';

  let { sidebarPreview = false, onSidebarEnter, onSidebarLeave, onSidebarToggle }: {
    sidebarPreview?: boolean;
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

  let isMaximized = $state(false);


  const platform = typeof window !== 'undefined' ? (window.electronAPI?.platform ?? 'linux') : 'linux';
  const isMac = platform === 'darwin';

  async function checkMaximized() {
    isMaximized = await appWindow.isMaximized();
  }

  onMount(() => {
    void checkMaximized();
    void downloadsStore.refresh();
  });
</script>

<!-- The app's own buttons, the same on every platform: the agent browser
     (a dock pane, beside the Code pane toggles), then downloads and theme. -->
{#snippet appTools()}
  <div class="titlebar-app-tools flex items-center">
  <Tooltip label={$t('titlebar.browser')} position="bottom">
    <button
      class="ui-icon-button"
      class:is-active={browserPanelStore.open}
      onclick={() => void browserPanelStore.toggle()}
      aria-label={$t('titlebar.browser')}
      aria-pressed={browserPanelStore.open}
    >
      <Globe class="size-4" />
    </button>
  </Tooltip>
  <span class="mx-1.5 h-4 w-px bg-[var(--border)]" aria-hidden="true"></span>
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
  class="titlebar-row titlebar-drag relative z-20 flex h-9 shrink-0 select-none bg-sidebar"
  ondblclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }}
  role="banner"
>
  <div class="titlebar-left flex min-w-0 flex-1 items-center gap-0.5 pl-1.5" style="{isMac ? 'padding-left: 78px;' : ''}">
    <Tooltip label={appStore.sidebarOpen ? $t('titlebar.hideSidebar') : $t('titlebar.showSidebar')}>
      <button
        class="ui-icon-button titlebar-no-drag"
        data-sidebar-toggle
        onclick={onSidebarToggle}
        onpointerenter={onSidebarEnter}
        onpointerleave={onSidebarLeave}
        aria-controls="app-sidebar"
        aria-expanded={appStore.sidebarOpen || sidebarPreview}
        aria-pressed={appStore.sidebarOpen}
        aria-label={appStore.sidebarOpen ? $t('titlebar.hideSidebar') : $t('titlebar.showSidebar')}
      >
        {#if appStore.sidebarOpen}
          <PanelLeftClose class="size-4" />
        {:else}
          <PanelLeftOpen class="size-4" />
        {/if}
      </button>
    </Tooltip>
    <Tooltip label={$t('titlebar.search')}>
      <button
        class="ui-icon-button titlebar-no-drag titlebar-secondary"
        onclick={() => appStore.openSearch()}
        aria-label={$t('titlebar.search')}
      >
        <Search class="size-4" />
      </button>
    </Tooltip>
    <Tooltip label={$t('titlebar.llmSettings')}>
      <button
        class="ui-icon-button titlebar-no-drag titlebar-secondary"
        onclick={() => (appStore.llmDrawerOpen = true)}
        aria-label={$t('titlebar.llmSettings')}
      >
        <SlidersHorizontal class="size-4" />
      </button>
    </Tooltip>
  </div>

  <div
    class="titlebar-center titlebar-no-drag flex min-w-0 flex-1 items-center justify-center gap-1.5 px-3"
    style="-webkit-app-region: no-drag;"
  >
    <SpaceTabs />
  </div>

  <div class="titlebar-right flex flex-1 items-center justify-end">
    {#if codeChat && codeProject}
      <CodeTitlebarTools chat={codeChat} project={codeProject} />
    {/if}
    {#if isMac}
      <div class="traffic-lights titlebar-no-drag flex items-center gap-1.5 pl-3">
        {@render appTools()}
        <button class="dot dot-close" onclick={() => appWindow.close()} aria-label={$t('titlebar.close')} title={$t('titlebar.close')}></button>
        <button class="dot dot-minimize" onclick={() => appWindow.minimize()} aria-label={$t('titlebar.minimize')} title={$t('titlebar.minimize')}></button>
        <button class="dot dot-maximize" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? $t('titlebar.restore') : $t('titlebar.maximize')} title={isMaximized ? $t('titlebar.restore') : $t('titlebar.maximize')}></button>
      </div>
    {:else}
      <div class="win-controls titlebar-no-drag flex h-full items-center">
        {@render appTools()}
        <button class="win-btn" onclick={() => appWindow.minimize()} aria-label={$t('titlebar.minimize')} title={$t('titlebar.minimize')}>
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="win-btn" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? $t('titlebar.restore') : $t('titlebar.maximize')} title={isMaximized ? $t('titlebar.restore') : $t('titlebar.maximize')}>
          {#if isMaximized}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
              <rect x="0.5" y="2.5" width="7" height="7" rx="0.5"/>
              <polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" fill="none"/>
            </svg>
          {:else}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.5"/>
            </svg>
          {/if}
        </button>
        <button class="win-btn win-btn-close" onclick={() => appWindow.close()} aria-label={$t('titlebar.close')} title={$t('titlebar.close')}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
            <line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/>
          </svg>
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .titlebar-row {
    display: grid;
    grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr);
    container-type: inline-size;
    width: 100%;
    position: relative;
    border-bottom: none;
  }

  .titlebar-left {
    flex-shrink: 0;
  }

  .titlebar-right {
    min-width: 0;
  }

  @container (max-width: 520px) {
    .titlebar-app-tools { display: none; }
    .win-btn { width: 32px; }
    .titlebar-center { padding-inline: 0.25rem; }
  }

  @container (max-width: 400px) {
    .titlebar-secondary { display: none; }
  }

  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    cursor: default;
    transition: filter 0.1s;
    flex-shrink: 0;
    position: relative;
  }
  .dot::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.1s;
    background-size: 8px 8px;
    background-repeat: no-repeat;
    background-position: center;
  }
  .traffic-lights:hover .dot::after { opacity: 1; }

  .dot-close   { background: #ff5f57; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12); }
  .dot-minimize { background: #ffbd2e; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12); }
  .dot-maximize { background: #28c840; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12); }

  .dot-close::after    { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 1.5l5 5M6.5 1.5l-5 5' stroke='%234d0000' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  .dot-minimize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4h5' stroke='%23593000' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  .dot-maximize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4.5l2.5-3 2.5 3M1.5 3.5l2.5 3 2.5-3' stroke='%230d3d00' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }

  .win-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 100%;
    border: none;
    background: transparent;
    cursor: default;
    transition: background 0.1s;
    color: var(--sidebar-foreground);
    box-shadow: none;
  }

  .win-btn:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .win-btn-close:hover {
    background: #e81123 !important;
    color: white !important;
  }
</style>
