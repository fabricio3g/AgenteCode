<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { appWindow } from '$lib/services/window';
  import { appStore } from '$lib/stores/app.svelte';
  import { Search, PanelLeftClose, PanelLeftOpen, MessageSquare, ExternalLink, SlidersHorizontal, MoonStar, SunMedium } from 'lucide-svelte';
  import ModelSwitcher from '$lib/components/chat/ModelSwitcher.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';

  let isMaximized = $state(false);
  const platform = typeof window !== 'undefined' ? (window.electronAPI?.platform ?? 'linux') : 'linux';
  const isMac = platform === 'darwin';

  async function checkMaximized() {
    isMaximized = await appWindow.isMaximized();
  }

  onMount(() => {
    void checkMaximized();
  });
</script>

<div
  class="titlebar-row flex h-8 shrink-0 select-none"
  style="-webkit-app-region: drag;"
  ondblclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }}
  role="banner"
>
  <div class="titlebar-left flex min-w-0 flex-1 items-center gap-2" style="{isMac ? 'padding-left: 78px;' : ''}">
    <div class="titlebar-icon flex h-7 w-7 items-center justify-center">
      <MessageSquare class="h-5 w-5 text-[var(--text)]" />
    </div>
    <Tooltip label="Search conversations">
      <button
        class="titlebar-btn flex h-7 w-7 items-center justify-center transition"
        onclick={() => (appStore.chatSearchOpen = true)}
        aria-label="Search chats"
        style="-webkit-app-region: no-drag"
      >
        <Search class="h-4 w-4" />
      </button>
    </Tooltip>
    <Tooltip label="LLM settings">
      <button
        class="titlebar-btn flex h-7 w-7 items-center justify-center transition"
        onclick={() => (appStore.llmDrawerOpen = true)}
        aria-label="LLM settings"
        style="-webkit-app-region: no-drag"
      >
        <SlidersHorizontal class="h-4 w-4" />
      </button>
    </Tooltip>
    {#if appStore.sidebarOpen}
      <Tooltip label="Hide sidebar">
        <button
          class="titlebar-btn flex h-7 w-7 items-center justify-center transition"
          onclick={() => (appStore.sidebarOpen = false)}
          aria-label="Hide sidebar"
          style="-webkit-app-region: no-drag"
        >
          <PanelLeftClose class="h-4 w-4" />
        </button>
      </Tooltip>
    {:else}
      <Tooltip label="Show sidebar">
        <button
          class="titlebar-btn flex h-7 w-7 items-center justify-center transition"
          onclick={() => (appStore.sidebarOpen = true)}
          aria-label="Show sidebar"
          style="-webkit-app-region: no-drag"
        >
          <PanelLeftOpen class="h-4 w-4" />
        </button>
      </Tooltip>
    {/if}
  </div>

  <div class="titlebar-center flex min-w-0 flex-1 items-center justify-center gap-2 px-3" style="-webkit-app-region: no-drag">
    <ModelSwitcher />
    <Tooltip label="Open Model Hub">
      <button
        class="titlebar-btn flex h-7 w-7 items-center justify-center transition"
        onclick={() => { appStore.modelManagerOpenSection = 'models'; appStore.modelManagerOpen = true; }}
        aria-label="Open Model Hub"
      >
        <ExternalLink class="h-4 w-4" />
      </button>
    </Tooltip>
  </div>

  <div class="titlebar-right flex flex-1 items-center justify-end">
    {#if isMac}
      <div class="traffic-lights flex items-center gap-2 pl-3" style="-webkit-app-region: no-drag">
        <Tooltip label="Toggle theme" position="left">
          <button
            class="titlebar-btn flex h-7 w-7 items-center justify-center transition"
            onclick={() => themeStore.toggle()}
            aria-label="Toggle theme"
          >
            {#if themeStore.current === 'dark'}
              <SunMedium class="h-4 w-4" />
            {:else}
              <MoonStar class="h-4 w-4" />
            {/if}
          </button>
        </Tooltip>
        <button class="dot dot-close" onclick={() => appWindow.close()} aria-label="Close" title="Close"></button>
        <button class="dot dot-minimize" onclick={() => appWindow.minimize()} aria-label="Minimize" title="Minimize"></button>
        <button class="dot dot-maximize" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? 'Restore' : 'Maximize'} title={isMaximized ? 'Restore' : 'Maximize'}></button>
      </div>
    {:else}
      <div class="win-controls flex h-full items-center" style="-webkit-app-region: no-drag">
        <Tooltip label="Toggle theme" position="left">
          <button
            class="titlebar-btn flex h-7 w-7 items-center justify-center transition mr-1"
            onclick={() => themeStore.toggle()}
            aria-label="Toggle theme"
          >
            {#if themeStore.current === 'dark'}
              <SunMedium class="h-4 w-4" />
            {:else}
              <MoonStar class="h-4 w-4" />
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
  }

  .titlebar-left {
    background: var(--titlebar-bg, var(--surface));
    flex-shrink: 0;
    padding-left: 14px;
    gap: 0;
  }

  .titlebar-icon {
    flex-shrink: 0;
  }

  .titlebar-btn {
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .titlebar-btn:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  .titlebar-center {
    background: var(--titlebar-bg, var(--surface));
  }

  .titlebar-right {
    background: var(--titlebar-bg, var(--surface));
    min-width: 0;
    border-bottom-right-radius: 8px;
  }

  .dot {
    width: 12px; height: 12px;
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

  :global(.dark) .dot-close   { background: #ff5f57; box-shadow: 0 0 0 0.5px rgba(255,255,255,.15); }
  :global(.dark) .dot-minimize { background: #ffbd2e; box-shadow: 0 0 0 0.5px rgba(255,255,255,.15); }
  :global(.dark) .dot-maximize { background: #28c840; box-shadow: 0 0 0 0.5px rgba(255,255,255,.15); }

  .dot-close::after    { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 1.5l5 5M6.5 1.5l-5 5' stroke='%234d0000' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  .dot-minimize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4h5' stroke='%23593000' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  .dot-maximize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4.5l2.5-3 2.5 3M1.5 3.5l2.5 3 2.5-3' stroke='%230d3d00' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }

  :global(.dark) .dot-close::after    { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 1.5l5 5M6.5 1.5l-5 5' stroke='%23ffcccc' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  :global(.dark) .dot-minimize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4h5' stroke='%23ffdd99' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  :global(.dark) .dot-maximize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4.5l2.5-3 2.5 3M1.5 3.5l2.5 3 2.5-3' stroke='%2399ff99' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }

  .win-controls { margin-right: 0; }

  .win-btn {
    display: flex; align-items: center; justify-content: center;
    width: 46px; height: 100%;
    border: none; background: transparent; cursor: default;
    transition: background 0.1s;
    color: var(--text-muted);
  }

  .win-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .win-btn-close:hover {
    background: #e81123 !important;
    color: white !important;
  }

  :global(.dark) .win-btn:hover {
    background: rgba(255,255,255,0.08);
  }
  :global(.dark) .win-btn-close:hover {
    background: #e81123 !important;
    color: white !important;
  }
</style>
