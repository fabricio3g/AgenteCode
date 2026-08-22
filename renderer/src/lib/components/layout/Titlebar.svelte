<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { appWindow } from '$lib/services/window';
  import { countOf } from '$lib/utils/format';
  import { appStore } from '$lib/stores/app.svelte';
  import { Search, ExternalLink, SlidersHorizontal, MoonStar, SunMedium, Download, Loader2 } from 'lucide-svelte';
  import ModelSwitcher from '$lib/features/chat/ModelSwitcher.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';

  let isMaximized = $state(false);

  /**
   * The indicator deep-links into the Hub's Library pane — downloads render
   * inline on their model rows there, so there is no separate modal to open.
   */
  function openDownloads() {
    void downloadsStore.refresh();
    appStore.modelManagerOpenSection = 'library';
    appStore.modelManagerOpen = true;
  }

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

<div
  class="titlebar-row titlebar-drag relative z-20 flex h-9 shrink-0 select-none bg-sidebar"
  ondblclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }}
  role="banner"
>
  <div class="titlebar-left flex min-w-0 flex-1 items-center gap-0.5 pl-1.5" style="{isMac ? 'padding-left: 78px;' : ''}">
    <!-- The sidebar toggle lives on the sidebar itself — in its header when
         expanded, at the top of the rail when collapsed. -->
    <Tooltip label="Search conversations">
      <button
        class="aui-icon-button size-8 titlebar-no-drag"
        onclick={() => (appStore.chatSearchOpen = true)}
        aria-label="Search chats"
      >
        <Search class="size-4" />
      </button>
    </Tooltip>
    <Tooltip label="LLM settings">
      <button
        class="aui-icon-button size-8 titlebar-no-drag"
        onclick={() => (appStore.llmDrawerOpen = true)}
        aria-label="LLM settings"
      >
        <SlidersHorizontal class="size-4" />
      </button>
    </Tooltip>
  </div>

  <div
    class="titlebar-center titlebar-no-drag flex min-w-0 flex-1 items-center justify-center gap-1.5 px-3"
    style="-webkit-app-region: no-drag;"
  >
    <div class="titlebar-no-drag" style="-webkit-app-region: no-drag; pointer-events: auto;">
      <!-- The model selector now lives in the composer's control row, beside
           the attach button, so the active model sits where you compose. -->
    </div>
    <Tooltip label="Open Models">
      <button
        class="aui-icon-button size-8 titlebar-no-drag"
        style="-webkit-app-region: no-drag;"
        onclick={() => { appStore.modelManagerOpenSection = 'models'; appStore.modelManagerOpen = true; }}
        aria-label="Open Models"
      >
        <ExternalLink class="size-4" />
      </button>
    </Tooltip>
  </div>

  <div class="titlebar-right flex flex-1 items-center justify-end">
    {#if isMac}
      <div class="traffic-lights titlebar-no-drag flex items-center gap-1.5 pl-3">
        <div class="relative flex items-center">
          <Tooltip label={downloadsStore.activeCount > 0 ? countOf(downloadsStore.activeCount, 'active download') : 'Downloads'} position="left">
            <button
              class="aui-icon-button download-btn relative size-8"
              class:is-active={downloadsStore.hasActive}
              onclick={openDownloads}
              aria-label="Downloads"
            >
              {#if downloadsStore.hasActive}
                <Loader2 class="size-4 animate-spin" />
                <span class="download-badge">{downloadsStore.activeCount}</span>
              {:else}
                <Download class="size-4" />
              {/if}
            </button>
          </Tooltip>
        </div>
        <Tooltip label="Toggle theme" position="left">
          <button
            class="aui-icon-button size-8"
            onclick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              themeStore.toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}
            aria-label="Toggle theme"
          >
            {#if themeStore.current === 'dark'}
              <SunMedium class="size-4" />
            {:else}
              <MoonStar class="size-4" />
            {/if}
          </button>
        </Tooltip>
        <button class="dot dot-close" onclick={() => appWindow.close()} aria-label="Close" title="Close"></button>
        <button class="dot dot-minimize" onclick={() => appWindow.minimize()} aria-label="Minimize" title="Minimize"></button>
        <button class="dot dot-maximize" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? 'Restore' : 'Maximize'} title={isMaximized ? 'Restore' : 'Maximize'}></button>
      </div>
    {:else}
      <div class="win-controls titlebar-no-drag flex h-full items-center">
        <div class="relative flex items-center">
          <Tooltip label={downloadsStore.activeCount > 0 ? countOf(downloadsStore.activeCount, 'active download') : 'Downloads'} position="left">
            <button
              class="aui-icon-button download-btn relative mr-0.5 size-8"
              class:is-active={downloadsStore.hasActive}
              onclick={openDownloads}
              aria-label="Downloads"
            >
              {#if downloadsStore.hasActive}
                <Loader2 class="size-4 animate-spin" />
                <span class="download-badge">{downloadsStore.activeCount}</span>
              {:else}
                <Download class="size-4" />
              {/if}
            </button>
          </Tooltip>
        </div>
        <Tooltip label="Toggle theme" position="left">
          <button
            class="aui-icon-button mr-0.5 size-8"
            onclick={() => themeStore.toggle()}
            aria-label="Toggle theme"
          >
            {#if themeStore.current === 'dark'}
              <SunMedium class="size-4" />
            {:else}
              <MoonStar class="size-4" />
            {/if}
          </button>
        </Tooltip>
        <button class="win-btn" onclick={() => appWindow.minimize()} aria-label="Minimize" title="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="win-btn" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? 'Restore' : 'Maximize'} title={isMaximized ? 'Restore' : 'Maximize'}>
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
        <button class="win-btn win-btn-close" onclick={() => appWindow.close()} aria-label="Close" title="Close">
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
    display: flex;
    width: 100%;
    position: relative;
    border-bottom: none;
  }

  .titlebar-left {
    flex-shrink: 0;
  }

  .download-badge {
    position: absolute;
    right: -2px;
    top: -2px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--sidebar-primary);
    color: var(--sidebar-primary-foreground);
    font-size: 9px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
  }

  .titlebar-right {
    min-width: 0;
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
