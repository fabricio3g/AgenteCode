<svelte:options runes={true} />

<!--
  Docked agent browser sidebar.
  App DOM owns all chrome (tabs, URL bar, viewport select).
  The page renders in a main-process WebContentsView positioned
  over the empty viewport box below; guest content never
  touches this DOM.
-->

<script lang="ts">
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, Tooltip } from '$lib/components/ui';
  import { onMount, tick } from 'svelte';
  import { X, Plus, ArrowLeft, ArrowRight, RotateCw, LoaderCircle, Monitor, Laptop, Tablet, Smartphone, PanelRight, Hand, MoreHorizontal, Pencil, Globe, SquareDashedMousePointer } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { browserPanelStore as defaultBrowser, type BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { syncBrowserPresentation, type BrowserViewportPreset } from '$lib/services/browser';
  import { BROWSER_VIEWPORTS } from '$shared/browser-viewports';
  import { overlapsViewport } from './browser-occlusion';
  import { accessibilityStore } from '$lib/stores/accessibility.svelte';
  import { sameBrowserPresentation, type BrowserPresentation } from '$shared/browser-presentation';
  import { affectsBrowserPresentation, BROWSER_OVERLAYS } from './browser-presentation-updates';
  import CanvasPanel from '$lib/features/canvas/CanvasPanel.svelte';
  import { getCanvasBoard } from '$lib/features/canvas/canvas-context';
  const canvasBoard = getCanvasBoard();
  import { bitmapSize } from '$lib/features/canvas/canvas-images';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { pickBrowserElements, cancelBrowserPick, sendPicksToComposer } from '$lib/services/browser-pick';

  let { store: browserPanelStore = defaultBrowser, embedded = false, exposed = true, presentationKey = '', chatId }: { store?: BrowserPanelStore; embedded?: boolean; exposed?: boolean; presentationKey?: string; chatId?: string } = $props();
  let annotating = $state(false);
  let capturing = $state(false);
  const hasPage = $derived(!!browserPanelStore.activeTab?.url && browserPanelStore.activeTab.url !== 'about:blank');

  let picking = $state(false);
  async function togglePick() {
    const scope = browserPanelStore.scope, tabId = browserPanelStore.activeTabId;
    if (picking) { await cancelBrowserPick(scope, tabId).catch(() => {}); return; }
    if (!hasPage || !chatId || annotating) return;
    const owner = chatId;
    picking = true;
    try {
      const picks = await pickBrowserElements(scope, tabId, true);
      if (picks.length) {
        if (await sendPicksToComposer(picks, owner)) toastStore.success($t('browser.pickAdded', { values: { n: picks.length } }));
      }
    } catch (error) { toastStore.error(String(error)); }
    finally { picking = false; }
  }

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
    if (!mounted) return;
    // Hiding must also work when Electron pauses animation frames in the background.
    if (!exposed) { cancelAnimationFrame(pending); pending = 0; void present(); return; }
    if (pending) return;
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
    <Tooltip label={$t('browser.back')} position="bottom"><UiIconButton label={$t('browser.back')} size="sm" type="button" class={uiClass("", "ui-local-b510f76f")} onclick={() => void browserPanelStore.history('back')} >
      <ArrowLeft />
    </UiIconButton></Tooltip>
    <label class="ui-pill-field browser-url" class:driving={browserPanelStore.agentDriving}>
      {#if browserPanelStore.agentDriving}
        <span class="driving-dot" title={$t('browser.agentUsing')} aria-label={$t('browser.agentUsing')}></span>
      {/if}
      <UiInput class={uiClass('', "ui-local-b510f76f")}
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
    <Tooltip label={$t('browser.reload')} position="bottom"><UiIconButton label={$t('browser.reload')} size="sm" type="button" class={uiClass("", "ui-local-b510f76f")} onclick={() => void browserPanelStore.history('reload')} >
      <RotateCw />
    </UiIconButton></Tooltip>
    <Tooltip label={$t('browser.pick')} position="bottom"><UiIconButton label={$t('browser.pick')} size="sm" type="button" class={uiClass("", "ui-local-b510f76f")}  aria-pressed={picking} disabled={!hasPage || !chatId || annotating} onclick={() => void togglePick()}>
      <SquareDashedMousePointer />
    </UiIconButton></Tooltip>
    <Tooltip label={$t(annotating ? 'browser.browse' : 'browser.annotate')} position="bottom"><UiIconButton label={$t(annotating ? 'browser.browse' : 'browser.annotate')} size="sm" type="button" class={uiClass("", "ui-local-b510f76f")}  aria-pressed={annotating} disabled={!hasPage || !chatId || capturing} onclick={() => { if (annotating) annotating = false; else void annotate(); }}>
      {#if capturing}<LoaderCircle class="size-3 animate-spin" />{:else if annotating}<Globe />{:else}<Pencil />{/if}
    </UiIconButton></Tooltip>
    <Menu placement="bottom-end" label={$t('browser.more')} minWidth="12rem">
      {#snippet trigger(props)}
        <UiIconButton label={$t('browser.more')} size="sm" type="button" class={uiClass("", "ui-local-b510f76f")}  title={$t('browser.more')} {...props}>
          <MoreHorizontal />
        </UiIconButton>
      {/snippet}
      <MenuItem icon={ArrowRight} label={$t('browser.forward')} onselect={() => void browserPanelStore.history('forward')} />
      <MenuItem icon={Plus} label={$t('browser.newTab')} onselect={() => void browserPanelStore.newTab().then(() => syncBounds())} />
    </Menu>
    {#if !embedded}    <Tooltip label={$t('browser.closePanel')} position="bottom"><UiIconButton label={$t('browser.closePanel')} size="sm" type="button" class={uiClass("", "ui-local-b510f76f")} onclick={() => void browserPanelStore.hide()} >
      <X />
    </UiIconButton></Tooltip>{/if}
  </div>

  <div class="browser-status-bar">
    <Menu placement="bottom-start" label={$t('browser.resolution')} minWidth="12rem">
      {#snippet trigger(props)}<Button variant="outline" size="sm" type="button" class="text-[length:var(--text-xs)] tabular-nums" {...props} aria-label={$t('browser.resolution')}><Monitor class="size-3" /><span>{browserPanelStore.viewport==='fit'?$t('browser.fit'):`${BROWSER_VIEWPORTS[browserPanelStore.viewport].width}×${BROWSER_VIEWPORTS[browserPanelStore.viewport].height}`}</span></Button>{/snippet}
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
    <span class="browser-driver-note" title={$t('browser.pointerHint')}>{browserPanelStore.userTakeover?$t('browser.youHaveControl'):browserPanelStore.agentDriving?$t('browser.agentUsing'):''}</span>
    {#if browserPanelStore.userTakeover}
      <Button variant="outline" size="sm" class="ml-auto" type="button" onclick={() => void browserPanelStore.setTakeover(false)} title={$t('browser.youHaveControl')} aria-label={$t('browser.handBack')}>
        <Hand class="size-3" /> <span class="control-label">{$t('browser.handBack')}</span>
      </Button>
    {:else}
      <Button variant="outline" size="sm" class="ml-auto" type="button" onclick={() => void browserPanelStore.setTakeover(true)} title={$t('browser.agentUsing')} aria-label={$t('browser.takeControl')}>
        <Hand class="size-3" /> <span class="control-label">{$t('browser.takeControl')}</span>
      </Button>
    {/if}
  </div>

  <!-- Tabs only once there is more than one. -->
  {#if browserPanelStore.tabs.length > 1}
    <div class="browser-tabs" role="tablist" aria-label={$t('browser.tabs')}>
      {#each browserPanelStore.tabs as tab (tab.id)}
        <div class="browser-tab" class:active={tab.id === browserPanelStore.activeTabId} role="tab" aria-selected={tab.id === browserPanelStore.activeTabId}>
          <Button variant="plain"
            type="button"
            class={uiClass("browser-tab-label", "ui-local-b510f76f")}
            onclick={() => { annotating = false; void browserPanelStore.selectTab(tab.id).then(() => syncBounds()); }}
            title={tab.url || $t('browser.newTab')}
          >
            {shortLabel(tab)}
          </Button>
          <UiIconButton label={$t('browser.closeTab')} size="xs" variant="ghost" type="button" class={uiClass("browser-tab-close", "ui-local-b510f76f")} onclick={() => void browserPanelStore.closeTab(tab.id)}  tabindex={-1}>
            <X class="size-2.5" />
          </UiIconButton>
        </div>
      {/each}
    </div>
  {/if}

  {#if picking}<div class="browser-pick-hint" role="status">{$t('browser.pickHint')}</div>{/if}

  <div bind:this={viewportEl} class="browser-viewport-box" class:annotating aria-label={$t('browser.page')}>
    {#if annotating && chatId}
      <CanvasPanel {chatId} />
    {:else if !hasPage}
      <EmptyState size="compact" icon={Globe} title={$t('browser.emptyTitle')} description={$t('browser.emptyHint')} class="h-full" />
    {:else if still}<img class="viewport-still" src={still} alt="" onerror={() => (still = null)} />{/if}
  </div>
</div>

<style>
  .browser-pick-hint {flex-shrink:0;padding:0.25rem 0.75rem;font-size:var(--text-xs);color:var(--muted-foreground);text-align:center;}
  .browser-status-bar {display:flex;align-items:center;flex-wrap:wrap;gap:0.375rem;padding:0 0.5rem 0.375rem;min-width:0;}
  .browser-driver-note {flex:1;min-width:4rem;font-size:var(--text-xs);color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

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
    min-width:0;
    flex: 1 1 auto;
    margin: 0 0.125rem;
  }

  .driving-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
    animation: browser-drive-pulse 1.6s ease-in-out infinite;
  }

  @keyframes browser-drive-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  .browser-tabs {
    display: flex;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.1875rem;
    padding: 0 0.5rem 0.25rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .browser-tab {
    display: flex;
    height: 1.5rem;
    max-width: 9.5rem;
    align-items: center;
    gap: 0.2rem;
    padding: 0 0.25rem 0 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
    transition: background-color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }

  .browser-tab:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .browser-tab.active {
    border-color: var(--float-border);
    background: var(--composer-control-bg);
    box-shadow: var(--control-shadow);
    color: var(--foreground);
  }

  :global(.browser-tab-label.ui-local-b510f76f) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.browser-tab-close.ui-local-b510f76f) {
    display: inline-flex;
    padding: 0.15rem;
    border-radius: var(--radius-full);
    color: inherit;
    opacity: 0;
  }

  .browser-tab:hover :global(.browser-tab-close.ui-local-b510f76f),
  .browser-tab.active :global(.browser-tab-close.ui-local-b510f76f) {
    opacity: 0.7;
  }

  :global(.browser-tab-close:hover.ui-local-b510f76f) {
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
    border: 1px solid var(--float-border);
    border-radius: var(--radius-md);
    background: var(--muted);
  }

  .browser-viewport-box.annotating { display: flex; margin: 0; border-radius: 0; }

  /* A narrow card keeps the address readable: the chip becomes its icon. */
  @container (max-width: 380px) {
    .control-label { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .driving-dot {
      animation: none;
    }
  }
</style>
