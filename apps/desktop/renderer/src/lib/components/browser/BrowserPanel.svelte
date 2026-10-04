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
  import { X, Plus, ArrowLeft, ArrowRight, RotateCw, LoaderCircle, Monitor, Laptop, Tablet, Smartphone, PanelRight, Hand, MoreHorizontal, Pencil, Globe } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { syncBrowserPresentation, type BrowserViewportPreset } from '$lib/services/browser';
  import { BROWSER_VIEWPORTS } from '$shared/browser-viewports';
  import { overlapsViewport } from './browser-occlusion';
  import { accessibilityStore } from '$lib/stores/accessibility.svelte';
  import { sameBrowserPresentation, type BrowserPresentation } from '$shared/browser-presentation';
  import { affectsBrowserPresentation, BROWSER_OVERLAYS } from './browser-presentation-updates';
  import CanvasPanel from '$lib/features/canvas/CanvasPanel.svelte';
  import { canvasBoard } from '$lib/features/canvas/canvas-board.svelte';
  import { bitmapSize } from '$lib/features/canvas/canvas-images';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';

  let { embedded = false, exposed = true, presentationKey = '', chatId }: { embedded?: boolean; exposed?: boolean; presentationKey?: string; chatId?: string } = $props();
  let annotating = $state(false);
  let capturing = $state(false);
  const hasPage = $derived(!!browserPanelStore.activeTab?.url && browserPanelStore.activeTab.url !== 'about:blank');

  async function annotate() {
    if (capturing || !hasPage || !chatId) return;
    const owner = chatId, scope = browserPanelStore.scope, tabId = browserPanelStore.activeTabId;
    const sourceUrl = browserPanelStore.activeTab!.url;
    capturing = true;
    try {
      const href = await invoke<string>('browser_screenshot', { scope, tabId });
      const size = await bitmapSize(href);
      const name = `${new URL(sourceUrl).hostname || 'website'}.png`;
      const { attachment } = await invoke<{ attachment: { path: string } }>('agente_media_import', { name, data: href.split(',')[1] });
      if (chatId !== owner || browserPanelStore.scope !== scope || browserPanelStore.activeTabId !== tabId) return;
      canvasBoard.useChat(owner);
      canvasBoard.addImage({ path: attachment.path, name, sourceUrl, ...size }, href);
      canvasBoard.tool = 'arrow';
      annotating = true;
    } catch (error) { toastStore.error(String(error)); }
    finally { capturing = false; }
  }

  const VIEWPORT_ICON: Record<BrowserViewportPreset, typeof Monitor> = {
    fit: PanelRight,
    desktop: Monitor,
    laptop: Laptop,
    tablet: Tablet,
    mobile: Smartphone
  };

  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  let viewportEl = $state<HTMLDivElement | undefined>(undefined);
  /** A still of the page, shown while an overlay covers the live view. */
  let still = $state<string | null>(null);
  let mounted = false;
  let pending = 0;
  let presentationVersion = 0;
  let lastPresentation: { key: string; value: BrowserPresentation } | null = null;

  /** Anything floating: menus, dialogs, popovers, listboxes, tooltips. */
  const OVERLAYS = BROWSER_OVERLAYS;

  /** Native content cannot be ordered with DOM z-index. Only higher windows cover it. */
  function covered(): boolean {
    if (!viewportEl || !exposed) return false;
    if (document.querySelector('[data-workspace-interacting="true"]')) return true;
    const box = viewportEl.getBoundingClientRect();
    const own = panelEl?.closest<HTMLElement>('[data-workspace-panel]');
    const z = Number(own?.dataset.workspaceZ ?? 0);
    return Array.from(document.querySelectorAll<HTMLElement>(`${OVERLAYS}, .workspace-panel.floating:not([hidden])`)).some((node) => {
      if (node === own || node.contains(viewportEl!)) return false;
      if (node.matches('.workspace-panel') && Number(node.dataset.workspaceZ ?? 0) <= z) return false;
      return overlapsViewport(box, node.getBoundingClientRect());
    });
  }

  async function present() {
    if (!mounted) return;
    const scope = browserPanelStore.scope;
    const nativeExposed = exposed && hasPage && !annotating;
    const rect = nativeExposed ? viewportEl?.getBoundingClientRect() : null;
    const occluded = covered();
    const value: BrowserPresentation = { bounds: rect && rect.width > 0 && rect.height > 0 ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null, exposed: nativeExposed, occluded: nativeExposed && occluded };
    const key = JSON.stringify([scope, browserPanelStore.activeTabId, browserPanelStore.viewport, accessibilityStore.prefs.uiScale]);
    if (lastPresentation?.key === key && sameBrowserPresentation(lastPresentation.value, value)) return;
    lastPresentation = { key, value };
    const version = ++presentationVersion;
    // Capturing a still can take time. Never serialize visibility behind it.
    try {
      const image = await syncBrowserPresentation(scope, value);
      if (!mounted || version !== presentationVersion || scope !== browserPanelStore.scope) return;
      if (occluded && image) still = image;
      else if (!occluded) still = null;
    } catch {
      if (version === presentationVersion) lastPresentation = null;
    }
  }
  function schedulePresentation() {
    if (!mounted || pending) return;
    pending = requestAnimationFrame(() => { pending = 0; void present(); });
  }
  async function syncBounds() { schedulePresentation(); }

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

  function observeElement(observer: ResizeObserver | null, element: HTMLElement | undefined) {
    if (observer && element) observer.observe(element);
  }

  function observeBounds(onResize: () => void): () => void {
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    observeElement(observer, viewportEl);
    observeElement(observer, panelEl);
    return () => observer?.disconnect();
  }

  onMount(() => {
    mounted = true;
    browserPanelStore.init();
    void tick().then(schedulePresentation);
    window.addEventListener('resize', schedulePresentation);
    const stopBounds = observeBounds(schedulePresentation);
    const overlays = new MutationObserver((records) => { if (affectsBrowserPresentation(records, viewportEl)) schedulePresentation(); });
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'role', 'data-workspace-interacting', 'data-workspace-z'] });
    return () => {
      mounted = false;
      window.removeEventListener('resize', schedulePresentation);
      stopBounds(); overlays.disconnect(); cancelAnimationFrame(pending);
      void syncBrowserPresentation(browserPanelStore.scope, { bounds: null, exposed: false, occluded: false }).catch(() => null);
    };
  });

  $effect(() => {
    void browserPanelStore.scope;
    still = null;
    lastPresentation = null;
    annotating = false;
  });
  $effect(() => {
    void browserPanelStore.scope;
    void browserPanelStore.activeTabId;
    void browserPanelStore.tabs.length;
    void browserPanelStore.viewport;
    void exposed; void presentationKey; void accessibilityStore.prefs.uiScale; void hasPage; void annotating;
    void tick().then(schedulePresentation);
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
    <label class="ui-pill-field browser-url" class:driving={browserPanelStore.agentDriving}>
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
      <button type="button" class="ui-chip control-chip" onclick={() => void browserPanelStore.setTakeover(false)} title={$t('browser.youHaveControl')} aria-label={$t('browser.handBack')}>
        <Hand class="size-3" /> <span class="control-label">{$t('browser.handBack')}</span>
      </button>
    {:else if browserPanelStore.agentDriving}
      <button type="button" class="ui-chip control-chip" onclick={() => void browserPanelStore.setTakeover(true)} title={$t('browser.agentUsing')} aria-label={$t('browser.takeControl')}>
        <Hand class="size-3" /> <span class="control-label">{$t('browser.takeControl')}</span>
      </button>
    {/if}
    <button type="button" class="ui-icon-button" onclick={() => void browserPanelStore.history('reload')} aria-label={$t('browser.reload')} title={$t('browser.reload')}>
      <RotateCw />
    </button>
    <button type="button" class="ui-icon-button" aria-label={$t(annotating ? 'browser.browse' : 'browser.annotate')} title={$t(annotating ? 'browser.browse' : 'browser.annotate')} aria-pressed={annotating} disabled={!hasPage || !chatId || capturing} onclick={() => { if (annotating) annotating = false; else void annotate(); }}>
      {#if capturing}<LoaderCircle class="size-3 animate-spin" />{:else if annotating}<Globe />{:else}<Pencil />{/if}
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
    {#if !embedded}    <button type="button" class="ui-icon-button" onclick={() => void browserPanelStore.hide()} aria-label={$t('browser.closePanel')} title={$t('browser.closePanel')}>
      <X />
    </button>{/if}
  </div>

  <!-- Tabs only once there is more than one. -->
  {#if browserPanelStore.tabs.length > 1}
    <div class="browser-tabs" role="tablist" aria-label={$t('browser.tabs')}>
      {#each browserPanelStore.tabs as tab (tab.id)}
        <div class="browser-tab" class:active={tab.id === browserPanelStore.activeTabId} role="tab" aria-selected={tab.id === browserPanelStore.activeTabId}>
          <button
            type="button"
            class="browser-tab-label"
            onclick={() => { annotating = false; void browserPanelStore.selectTab(tab.id).then(() => syncBounds()); }}
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

  <div bind:this={viewportEl} class="browser-viewport-box" class:annotating aria-label={$t('browser.page')}>
    {#if annotating && chatId}
      <CanvasPanel {chatId} />
    {:else if !hasPage}
      <div class="browser-empty"><Globe class="size-5" /><p>{$t('browser.emptyTitle')}</p><span>{$t('browser.emptyHint')}</span></div>
    {:else if still}<img class="viewport-still" src={still} alt="" onerror={() => (still = null)} />{/if}
  </div>
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
    flex: 1 1 auto;
    margin: 0 0.125rem;
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
    font-size: var(--text-xs);
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
  .viewport-still {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
    pointer-events: none;
  }

  .browser-viewport-box {
    position: relative;
    overflow: hidden;
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 12px 14px;
    border-radius: 8px;
    background: var(--muted);
  }

  .browser-viewport-box.annotating { display: flex; margin: 0; border-radius: 0; }
  .browser-empty { display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; padding: 1.5rem; text-align: center; color: var(--muted-foreground); }
  .browser-empty p { margin: 0; font-size: var(--text-sm); color: var(--foreground); }
  .browser-empty span { max-width: 24rem; font-size: var(--text-xs); }

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
