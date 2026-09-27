<svelte:options runes={true} />

<!--
  Docked agent browser sidebar.
  App DOM owns all chrome (tabs, URL bar, viewport select).
  The page renders in a main-process WebContentsView positioned
  over the empty viewport box below; guest content never
  touches this DOM.
-->

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { X, Plus, ArrowLeft, ArrowRight, RotateCw, LoaderCircle, Monitor, Laptop, Tablet, Smartphone, PanelRight, Hand, Bot } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { syncBrowserPanelBounds, type BrowserViewportPreset } from '$lib/services/browser';
  import { BROWSER_VIEWPORTS } from '$shared/browser-viewports';

  const VIEWPORT_META: Record<BrowserViewportPreset, { label: string; icon: typeof Monitor }> = {
    fit: { label: 'Fit', icon: PanelRight },
    desktop: { label: 'Desktop', icon: Monitor },
    laptop: { label: 'Laptop', icon: Laptop },
    tablet: { label: 'Tablet', icon: Tablet },
    mobile: { label: 'Mobile', icon: Smartphone }
  };

  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  let viewportEl = $state<HTMLDivElement | undefined>(undefined);

  async function syncBounds() {
    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    await syncBrowserPanelBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => {});
  }

  function onAddressKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void browserPanelStore.go().then(() => syncBounds());
    }
  }

  /** Drag the left edge to resize; the width is remembered. */
  function startResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = browserPanelStore.width;
    const onMove = (move: PointerEvent) => browserPanelStore.setWidth(startWidth + (startX - move.clientX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      void syncBounds();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function shortLabel(tab: { title: string; url: string }) {
    if (tab.title) return tab.title.slice(0, 18);
    try {
      return new URL(tab.url).hostname || 'New tab';
    } catch {
      return 'New tab';
    }
  }

  onMount(() => {
    browserPanelStore.init();
    void tick().then(() => void syncBounds());
    const onResize = () => void syncBounds();
    window.addEventListener('resize', onResize);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => void syncBounds());
    if (viewportEl && observer) observer.observe(viewportEl);
    if (panelEl && observer) observer.observe(panelEl);
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  });

  $effect(() => {
    void browserPanelStore.activeTabId;
    void browserPanelStore.tabs.length;
    void browserPanelStore.viewport;
    void tick().then(() => syncBounds());
  });
</script>

<div
  bind:this={panelEl}
  class="browser-panel"
  role="complementary"
  aria-label={$t('browser.title')}
  style={`width: ${browserPanelStore.width}px;`}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="browser-resize" title={$t('browser.resize')} onpointerdown={startResize}></div>
  <div class="browser-tabs" role="tablist" aria-label="Browser tabs">
    {#each browserPanelStore.tabs as tab (tab.id)}
      <div
        class="browser-tab"
        class:active={tab.id === browserPanelStore.activeTabId}
        role="tab"
        aria-selected={tab.id === browserPanelStore.activeTabId}
      >
        <button
          type="button"
          class="browser-tab-label"
          onclick={() => void browserPanelStore.selectTab(tab.id).then(() => syncBounds())}
          title={tab.url || 'New tab'}
        >
          {shortLabel(tab)}
        </button>
        <button
          type="button"
          class="browser-tab-close"
          onclick={() => void browserPanelStore.closeTab(tab.id)}
          aria-label={$t('browser.closeTab')}
          tabindex="-1"
        >
          <X class="size-3" />
        </button>
      </div>
    {/each}
    <button
      type="button"
      class="browser-icon-btn"
      onclick={() => void browserPanelStore.newTab().then(() => syncBounds())}
      aria-label={$t('browser.newTab')}
      title={$t('browser.newTab')}
    >
      <Plus class="size-3.5" />
    </button>
    <span class="browser-driving" class:on={browserPanelStore.agentDriving} title={browserPanelStore.agentDriving ? $t('browser.agentUsing') : ''}>
      <span class="browser-driving-dot" aria-hidden="true"></span>
      {browserPanelStore.agentDriving ? $t('browser.agent') : ''}
    </span>
  </div>

  <div class="browser-bar">
    <button type="button" class="browser-icon-btn" onclick={() => void browserPanelStore.history('back')} aria-label={$t('browser.back')} title={$t('browser.back')}>
      <ArrowLeft class="size-3.5" />
    </button>
    <button type="button" class="browser-icon-btn" onclick={() => void browserPanelStore.history('forward')} aria-label={$t('browser.forward')} title={$t('browser.forward')}>
      <ArrowRight class="size-3.5" />
    </button>
    <button type="button" class="browser-icon-btn" onclick={() => void browserPanelStore.history('reload')} aria-label={$t('browser.reload')} title={$t('browser.reload')}>
      <RotateCw class="size-3.5" />
    </button>
    <input
      id="browser-address-input"
      class="browser-url"
      placeholder={$t('browser.address')}
      bind:value={browserPanelStore.addressInput}
      onkeydown={onAddressKeydown}
      spellcheck={false}
      autocomplete="off"
    />
    <button
      type="button"
      class="browser-icon-btn"
      onclick={() => void browserPanelStore.go()}
      aria-label={$t('browser.go')}
      title={$t('browser.go')}
      disabled={browserPanelStore.loading}
    >
      {#if browserPanelStore.loading}
        <LoaderCircle class="size-3.5 animate-spin" />
      {:else}
        <ArrowRight class="size-3.5" />
      {/if}
    </button>
    <Menu placement="bottom-end" label={$t('browser.screenSize')}>
      {#snippet trigger(props)}
        {@const ActiveIcon = VIEWPORT_META[browserPanelStore.viewport]?.icon ?? Monitor}
        <IconButton
          {...props}
          label="{$t('browser.screenSize')}: {browserPanelStore.viewport === 'fit' ? $t('browser.fit') : VIEWPORT_META[browserPanelStore.viewport]?.label ?? ''}"
        >
          <ActiveIcon class="size-3.5" />
        </IconButton>
      {/snippet}
      <MenuItem
        icon={PanelRight}
        label={$t('browser.fit')}
        active={browserPanelStore.viewport === 'fit'}
        onselect={() => void browserPanelStore.setViewport('fit')}
      />
      {#each Object.entries(BROWSER_VIEWPORTS) as [id, preset] (id)}
        {@const ItemIcon = VIEWPORT_META[id as BrowserViewportPreset]?.icon ?? Monitor}
        <MenuItem
          icon={ItemIcon}
          label="{preset.label} · {preset.width}×{preset.height}"
          active={browserPanelStore.viewport === id}
          onselect={() => void browserPanelStore.setViewport(id as BrowserViewportPreset)}
        />
      {/each}
    </Menu>
    <button
      type="button"
      class="browser-icon-btn"
      onclick={() => void browserPanelStore.hide()}
      aria-label={$t('browser.closePanel')}
      title={$t('browser.closePanel')}
    >
      <X class="size-3.5" />
    </button>
  </div>

  {#if browserPanelStore.userTakeover}
    <div class="browser-banner">
      <Hand class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{$t('browser.youHaveControl')}</span>
      <button type="button" class="banner-btn" onclick={() => void browserPanelStore.setTakeover(false)}>{$t('browser.handBack')}</button>
    </div>
  {:else if browserPanelStore.agentDriving}
    <div class="browser-banner is-agent">
      <Bot class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{$t('browser.agentUsing')}</span>
      <button type="button" class="banner-btn" onclick={() => void browserPanelStore.setTakeover(true)}>{$t('browser.takeControl')}</button>
    </div>
  {/if}

  <div bind:this={viewportEl} class="browser-viewport-box" aria-label="Page view"></div>
</div>

<style>
  .browser-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 360px;
    max-width: 70%;
    flex-shrink: 0;
    overflow: hidden;
    border-left: 1px solid var(--border);
    background: var(--background);
  }

  /* Tab strip: quiet browser tabs, active reads as connected to page. */
  .browser-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0.375rem 0.5rem 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .browser-tabs::-webkit-scrollbar {
    display: none;
  }

  .browser-tab {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    max-width: 10rem;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    padding: 0.3rem 0.25rem 0.3rem 0.625rem;
    font-size: 12px;
    color: var(--muted-foreground);
    white-space: nowrap;
  }

  .browser-tab:hover {
    background: var(--muted);
  }

  .browser-tab.active {
    background: var(--card);
    color: var(--foreground);
    box-shadow: inset 0 2px 0 var(--sidebar-primary);
  }

  .browser-tab-label {
    border: none;
    background: transparent;
    color: inherit;
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0;
  }

  .browser-tab-close {
    display: inline-flex;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: inherit;
    padding: 0.2rem;
    opacity: 0;
  }

  .browser-tab:hover .browser-tab-close,
  .browser-tab.active .browser-tab-close {
    opacity: 0.7;
  }

  .browser-tab-close:hover {
    opacity: 1 !important;
    background: color-mix(in srgb, var(--foreground) 10%, transparent);
  }

  .browser-driving {
    margin-left: auto;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding-right: 0.25rem;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .browser-driving-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 9999px;
    background: var(--border);
  }

  .browser-driving.on {
    color: var(--foreground);
  }

  .browser-driving.on .browser-driving-dot {
    background: var(--sidebar-primary);
    animation: browser-drive-pulse 1.6s ease-in-out infinite;
  }

  @keyframes browser-drive-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* Address row: one slim bar, page-first. */
  .browser-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    background: var(--card);
    border-bottom: 1px solid var(--border);
  }

  .browser-url {
    min-width: 0;
    flex: 1 1 auto;
    height: 1.9rem;
    border: none;
    border-radius: var(--radius-md);
    background: var(--muted);
    color: var(--foreground);
    padding: 0 0.65rem;
    font-size: 0.78rem;
    outline: none;
  }

  .browser-url:focus {
    background: color-mix(in srgb, var(--muted) 60%, var(--background));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foreground) 18%, transparent);
  }

  .browser-icon-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--muted-foreground);
  }

  .browser-icon-btn:hover:not(:disabled) {
    background: var(--muted);
    color: var(--foreground);
  }

  .browser-resize {
    position: absolute;
    inset-block: 0;
    left: -3px;
    width: 6px;
    cursor: col-resize;
    z-index: 1;
  }

  .browser-resize:hover {
    background: color-mix(in srgb, var(--sidebar-primary) 35%, transparent);
  }

  .browser-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem 0.3rem 0.75rem;
    font-size: 11.5px;
    color: var(--foreground);
    background: var(--card);
    border-bottom: 1px solid var(--border);
  }

  .browser-banner.is-agent {
    background: color-mix(in srgb, var(--sidebar-primary) 10%, var(--card));
  }

  .banner-btn {
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: var(--background);
    color: var(--foreground);
    padding: 0.1rem 0.6rem;
    font-size: 11px;
    font-weight: 500;
  }

  .banner-btn:hover {
    border-color: color-mix(in srgb, var(--foreground) 35%, transparent);
  }

  .browser-viewport-box {
    flex: 1 1 auto;
    min-height: 0;
    background: #fff;
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-driving.on .browser-driving-dot {
      animation: none;
    }
  }
</style>
