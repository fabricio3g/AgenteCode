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
  import { X, Plus, ArrowLeft, ArrowRight, RotateCw, LoaderCircle, Monitor, Laptop, Tablet, Smartphone, PanelRight, Hand, MoreHorizontal } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { syncBrowserPanelBounds, type BrowserViewportPreset } from '$lib/services/browser';
  import { BROWSER_VIEWPORTS } from '$shared/browser-viewports';

  const VIEWPORT_ICON: Record<BrowserViewportPreset, typeof Monitor> = {
    fit: PanelRight,
    desktop: Monitor,
    laptop: Laptop,
    tablet: Tablet,
    mobile: Smartphone
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

  function shortLabel(tab: { title: string; url: string }) {
    if (tab.title) return tab.title.slice(0, 24);
    try {
      return new URL(tab.url).hostname || $t('browser.newTab');
    } catch {
      return $t('browser.newTab');
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
>
  <!-- One slim row: back, the address, reload, everything else in "…". -->
  <div class="browser-bar">
    <button type="button" class="ui-icon-button" onclick={() => void browserPanelStore.history('back')} aria-label={$t('browser.back')} title={$t('browser.back')}>
      <ArrowLeft />
    </button>
    <label class="browser-url" class:driving={browserPanelStore.agentDriving}>
      {#if browserPanelStore.agentDriving}
        <span class="driving-dot" title={$t('browser.agentUsing')} aria-label={$t('browser.agentUsing')}></span>
      {/if}
      <input
        id="browser-address-input"
        placeholder={$t('browser.address')}
        aria-label={$t('browser.address')}
        bind:value={browserPanelStore.addressInput}
        onkeydown={onAddressKeydown}
        spellcheck={false}
        autocomplete="off"
      />
      {#if browserPanelStore.loading}<LoaderCircle class="size-3 shrink-0 animate-spin text-muted-foreground" />{/if}
    </label>
    {#if browserPanelStore.userTakeover}
      <button type="button" class="control-chip" onclick={() => void browserPanelStore.setTakeover(false)} title={$t('browser.youHaveControl')} aria-label={$t('browser.handBack')}>
        <Hand class="size-3" /> <span class="control-label">{$t('browser.handBack')}</span>
      </button>
    {:else if browserPanelStore.agentDriving}
      <button type="button" class="control-chip" onclick={() => void browserPanelStore.setTakeover(true)} title={$t('browser.agentUsing')} aria-label={$t('browser.takeControl')}>
        <Hand class="size-3" /> <span class="control-label">{$t('browser.takeControl')}</span>
      </button>
    {/if}
    <button type="button" class="ui-icon-button" onclick={() => void browserPanelStore.history('reload')} aria-label={$t('browser.reload')} title={$t('browser.reload')}>
      <RotateCw />
    </button>
    <Menu placement="bottom-end" label={$t('browser.more')} minWidth="12rem">
      {#snippet trigger(props)}
        <button type="button" class="ui-icon-button" aria-label={$t('browser.more')} title={$t('browser.more')} {...props}>
          <MoreHorizontal />
        </button>
      {/snippet}
      <MenuItem icon={ArrowRight} label={$t('browser.forward')} onselect={() => void browserPanelStore.history('forward')} />
      <MenuItem icon={Plus} label={$t('browser.newTab')} onselect={() => void browserPanelStore.newTab().then(() => syncBounds())} />
      <div class="ui-menu-separator" role="separator"></div>
      <MenuItem
        icon={PanelRight}
        label={$t('browser.fit')}
        active={browserPanelStore.viewport === 'fit'}
        onselect={() => void browserPanelStore.setViewport('fit')}
      />
      {#each Object.entries(BROWSER_VIEWPORTS) as [id, preset] (id)}
        {@const ItemIcon = VIEWPORT_ICON[id as BrowserViewportPreset] ?? Monitor}
        <MenuItem
          icon={ItemIcon}
          label="{preset.label} · {preset.width}×{preset.height}"
          active={browserPanelStore.viewport === id}
          onselect={() => void browserPanelStore.setViewport(id as BrowserViewportPreset)}
        />
      {/each}
    </Menu>
    <button type="button" class="ui-icon-button" onclick={() => void browserPanelStore.hide()} aria-label={$t('browser.closePanel')} title={$t('browser.closePanel')}>
      <X />
    </button>
  </div>

  <!-- Tabs only once there is more than one. -->
  {#if browserPanelStore.tabs.length > 1}
    <div class="browser-tabs" role="tablist" aria-label={$t('browser.tabs')}>
      {#each browserPanelStore.tabs as tab (tab.id)}
        <div class="browser-tab" class:active={tab.id === browserPanelStore.activeTabId} role="tab" aria-selected={tab.id === browserPanelStore.activeTabId}>
          <button
            type="button"
            class="browser-tab-label"
            onclick={() => void browserPanelStore.selectTab(tab.id).then(() => syncBounds())}
            title={tab.url || $t('browser.newTab')}
          >
            {shortLabel(tab)}
          </button>
          <button type="button" class="browser-tab-close" onclick={() => void browserPanelStore.closeTab(tab.id)} aria-label={$t('browser.closeTab')} tabindex="-1">
            <X class="size-2.5" />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div bind:this={viewportEl} class="browser-viewport-box" aria-label={$t('browser.page')}></div>
</div>

<style>
  .browser-panel {
    position: relative;
    display: flex;
    min-height: 0;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    background: var(--card);
    container-type: inline-size;
  }

  .browser-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.3rem;
  }

  .browser-url {
    display: flex;
    min-width: 0;
    height: 1.625rem;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0.125rem;
    padding: 0 0.6rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    cursor: text;
  }

  .browser-url input {
    min-width: 0;
    flex: 1;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 12px;
    outline: none;
  }

  .browser-url:focus-within {
    box-shadow: inset 0 0 0 1px var(--border-hover);
  }

  .driving-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--brand-accent);
    animation: browser-drive-pulse 1.6s ease-in-out infinite;
  }

  @keyframes browser-drive-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  .control-chip {
    display: inline-flex;
    height: 1.375rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--foreground);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }

  .control-chip:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
  }

  .browser-tabs {
    display: flex;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.375rem 0.25rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .browser-tab {
    display: flex;
    height: 1.25rem;
    max-width: 9rem;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.15rem 0 0.5rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 11.5px;
    white-space: nowrap;
  }

  .browser-tab:hover,
  .browser-tab.active {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .browser-tab-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .browser-tab-close {
    display: inline-flex;
    padding: 0.15rem;
    border-radius: 9999px;
    color: inherit;
    opacity: 0;
  }

  .browser-tab:hover .browser-tab-close,
  .browser-tab.active .browser-tab-close {
    opacity: 0.7;
  }

  .browser-tab-close:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--foreground) 10%, transparent);
  }

  /* The page is a native view laid over this box; main rounds it to 8px, so
     a slim inset keeps it inside the card's rounded border. */
  .browser-viewport-box {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 4px 4px;
    border-radius: 8px;
    background: var(--muted);
  }

  /* A narrow card keeps the address readable: the chip becomes its icon. */
  @container (max-width: 380px) {
    .control-label { display: none; }
    .control-chip { padding: 0 0.35rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .driving-dot {
      animation: none;
    }
  }
</style>
