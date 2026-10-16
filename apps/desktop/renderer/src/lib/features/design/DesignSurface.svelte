<svelte:options runes={true} />

<!--
  The Design space: the conversation docked on the left, a live canvas beside
  it, and an inspector on the right. Both side panes drag to size (double-click
  an edge to reset). When the canvas would drop below its minimum a pane lays
  over the canvas's edge as a sheet instead, and the toolbar folds its secondary
  controls into More. The agent writes plain HTML and CSS into the design's
  workspace; the canvas reloads when it does. Keys are Ctrl/⌘+Alt+ so they never
  fight the composer: 1–3 add or remove a size on the board, 4 fits it, R reload, V variants, T versions, C chat,
  I inspector, L layers, M timeline. Plain V / S / C / D pick a canvas tool, and a plain M
  opens the timeline, when no text field has focus.
-->

<script lang="ts">
  import { writeToClipboard } from '$lib/utils/clipboard';
  import UiToolbar from '$lib/components/ui/Toolbar.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount, untrack } from 'svelte';
  import { Copy, Download, ExternalLink, Film, FolderOpen, LayoutGrid, GalleryHorizontal, History, Layers, Maximize2, Monitor, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, RotateCw, Smartphone, Tablet } from 'lucide-svelte';
  import Thread from '$lib/features/chat/thread/Thread.svelte';
  import Composer from '$lib/features/chat/Composer.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import ResizeHandle from '$lib/components/ui/ResizeHandle.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { invoke } from '$lib/services/bridge';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import DesignCanvas from './DesignCanvas.svelte';
  import DesignHandoffDialog from './DesignHandoffDialog.svelte';
  import DesignHandoffItems from './DesignHandoffItems.svelte';
  import DesignInspector from './DesignInspector.svelte';
  import DesignLayers from './DesignLayers.svelte';
  import DesignSelectionChips from './DesignSelectionChips.svelte';
  import DesignStarters from './DesignStarters.svelte';
  import DesignSystemChip from './DesignSystemChip.svelte';
  import DesignSystemItems from './DesignSystemItems.svelte';
  import DesignSystemPicker from './DesignSystemPicker.svelte';
  import DesignSystemsDialog from './DesignSystemsDialog.svelte';
  import DesignToolButton from './DesignToolButton.svelte';
  import DesignToolPill, { toolForKey } from './DesignToolPill.svelte';
  import DesignTimeline from './DesignTimeline.svelte';
  import DesignTray from './DesignTray.svelte';
  import { designSystems } from './design-systems.svelte';
  import { designStore, type DesignScheme, type PaneId } from './design.svelte';
  import { clampWidth, DOCK_WIDTH, FRAME_SIZES, INSPECTOR_WIDTH, paneLayout, pageLabel, shortcutFor, toolbarPlan, type FrameSizeId, type ToolbarItem } from './design-view';
  import type { DesignManageRequest } from '$shared/design';

  const SCHEMES: DesignScheme[] = ['auto', 'light', 'dark'];
  const SIZE_ICONS = { mobile: Smartphone, tablet: Tablet, desktop: Monitor } as const;
  const SIZE_KEYS: Record<FrameSizeId, string> = { mobile: '1', tablet: '2', desktop: '3' };
  /** The size switch reads small to large, like the device it names; the board lays rows out widest first. */
  const SIZE_ORDER = [...FRAME_SIZES].reverse();

  const chat = $derived(appStore.currentChat?.contextMode === 'design' ? appStore.currentChat : null);
  const threadIsEmpty = $derived(!(appStore.currentChat?.messages?.length));

  // The canvas follows the open design; the system library follows it too (the toolbar and the intro both read it).
  $effect(() => { const id = chat?.id ?? null; untrack(() => { void designStore.open(id); }); });
  $effect(() => { const id = designStore.chatId; untrack(() => { void designSystems.refresh(id); }); });
  onMount(() => designStore.watch());

  const pageOptions = $derived([
    ...designStore.data.pages.map((path) => ({ value: path, label: path })),
    ...designStore.data.variants.map((variant) => ({ value: variant.entry, label: `${variant.name} · ${copy.design.variants.title.toLowerCase()}` }))
  ]);


  // Where the panes sit. The surface's width is measured; the canvas column's width picks the toolbar's plan.
  let surfaceWidth = $state(0);
  let canvasWidth = $state(0);
  const layout = $derived(paneLayout(surfaceWidth || window.innerWidth, {
    dockOpen: designStore.chatOpen,
    dockWidth: designStore.dockWidth,
    inspectorOpen: designStore.inspectorOpen,
    inspectorWidth: designStore.inspectorWidth
  }));
  const plan = $derived(toolbarPlan(canvasWidth || (surfaceWidth - layout.canvasLeft - layout.canvasRight)));
  /** The dock is shown unless the user closed it or the inspector has taken its place on a narrow window. */
  const dockShown = $derived(designStore.chatOpen && !layout.dock.hidden);
  /** On a narrow window the chat's toggle brings the chat back by putting the inspector away, which is what hid it. */
  function toggleDock() {
    if (layout.dock.hidden) designStore.toggleInspector();
    else designStore.toggleChat();
  }
  const inline = (item: ToolbarItem) => plan.inline.includes(item);
  const inMore = (item: ToolbarItem) => plan.more.includes(item);
  /** How far an overlaid pane covers the canvas's visible width, so the tool pill can centre on what shows. */
  const coverLeft = $derived(layout.dock.overlay && dockShown ? layout.dock.width : 0);
  const coverRight = $derived(layout.inspector.overlay && designStore.inspectorOpen ? layout.inspector.width : 0);
  const visibleWidth = $derived(canvasWidth - coverLeft - coverRight);
  /**
   * The tool pill centres on the part of the canvas that shows: it stays inside that part when it fits there, and
   * otherwise inside the canvas column, so it never leaves the column.
   */
  let pillWidth = $state(0);
  const pillLeft = $derived.by(() => {
    const visibleLeft = coverLeft;
    const visibleRight = canvasWidth - coverRight;
    const centred = (visibleLeft + visibleRight) / 2 - pillWidth / 2;
    const withinVisible = Math.max(visibleLeft, Math.min(Math.max(visibleLeft, visibleRight - pillWidth), centred));
    return Math.round(Math.max(0, Math.min(canvasWidth - pillWidth, withinVisible)));
  });

  /** A drag starts from the width on screen; pointer travel (or an arrow key) moves the edge from there. */
  let dragStart = 0;
  function beginPane(pane: PaneId) {
    dragStart = pane === 'dock' ? layout.dock.width : layout.inspector.width;
    designStore.beginResize();
  }
  /** The dock's edge is on its right, the inspector's on its left, so the inspector grows as the edge moves left. */
  function resizePane(pane: PaneId, delta: number) {
    if (pane === 'dock') designStore.setPaneWidth('dock', clampWidth(dragStart + delta, DOCK_WIDTH.min, layout.dock.limit));
    else designStore.setPaneWidth('inspector', clampWidth(dragStart - delta, INSPECTOR_WIDTH.min, layout.inspector.limit));
  }
  function cancelPane(pane: PaneId) {
    designStore.setPaneWidth(pane, dragStart);
    designStore.endResize();
  }

  let exportMenu = $state(false);
  let moreMenu = $state(false);
  let handoffOpen = $state(false);
  let systemsOpen = $state(false);
  let exportNote = $state('');
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  function note(message: string) {
    exportNote = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { exportNote = ''; }, 2000);
  }

  function openSystems() {
    systemsOpen = true;
  }

  function isEditing(target: EventTarget | null): boolean {
    return !!(target as HTMLElement | null)?.closest?.('textarea, input, select, [contenteditable="true"]');
  }

  function onKeydown(event: KeyboardEvent) {
    // Ctrl/⌘+Alt+I toggles the inspector; the shared map in design-view covers the rest.
    if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.code === 'KeyI') {
      event.preventDefault();
      designStore.toggleInspector();
      return;
    }
    const action = shortcutFor(event);
    if (action) {
      event.preventDefault();
      if (action.kind === 'size') designStore.toggleSize(action.size);
      else if (action.kind === 'fit') designStore.setZoom(null);
      else if (action.kind === 'reload') designStore.reload();
      else if (action.kind === 'chat') toggleDock();
      else if (action.kind === 'layers') designStore.toggleLayers();
      else designStore.toggleTray(action.kind);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && (event.code === 'Equal' || event.code === 'Minus')) {
      event.preventDefault();
      designStore.zoomBy(event.code === 'Equal' ? 0.1 : -0.1);
      return;
    }
    const tool = toolForKey(event);
    if (tool) {
      event.preventDefault();
      designStore.setTool(tool);
      return;
    }
    // A plain M opens the timeline, like Ctrl/⌘+Alt+M, but never while a text field has focus.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'm' && !isEditing(event.target)) {
      event.preventDefault();
      designStore.toggleTray('timeline');
      return;
    }
    // Backspace takes back the last mark while drawing.
    if (designStore.tool === 'draw' && (event.key === 'Backspace' || event.key === 'Delete') && !isEditing(event.target)) {
      event.preventDefault();
      designStore.removeLastStroke();
      return;
    }
    // Esc takes back the last mark, then returns to Browse, then closes the tray; none applies inside a text field (the composer interrupts on Esc).
    if (event.key === 'Escape' && !isEditing(event.target) && !designStore.escape() && designStore.tray) designStore.tray = null;
  }

  /** The inlined single-file document of the page on screen. */
  function currentHtml(): string | null {
    const page = designStore.selected;
    const { files } = designStore.data;
    const source = files[page];
    if (source === undefined) return null;
    try { return buildPreviewHtml(source, files, page, true).html; } catch { return null; }
  }

  async function exportPage(action: 'copy' | 'download' | 'open') {
    const html = currentHtml();
    const chatId = designStore.chatId;
    if (!html || !chatId) return;
    try {
      if (action === 'copy') {
        if (!await writeToClipboard(html)) throw new Error('Clipboard unavailable');
        note(copy.design.export.copied);
        return;
      }
      const request: DesignManageRequest = { chatId, action: action === 'download' ? 'export' : 'open_external', page: designStore.selected, html };
      const result = await invoke<{ saved: boolean }>('design_manage', request);
      if (result?.saved === false) return;
    } catch {
      note(copy.design.export.failed);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet schemeItems()}
  {#each SCHEMES as scheme (scheme)}
    <MenuItem label={copy.design.toolbar.scheme[scheme]} active={designStore.scheme === scheme} onselect={() => designStore.setScheme(scheme)} />
  {/each}
{/snippet}

{#snippet pageItems()}
  {#each pageOptions as page (page.value)}
    <MenuItem label={page.label} active={designStore.selected === page.value} onselect={() => designStore.select(page.value)} />
  {/each}
{/snippet}

{#snippet exportItems()}
  <MenuItem icon={Copy} label={copy.design.export.copyHtml} onselect={() => void exportPage('copy')} />
  <MenuItem icon={Download} label={copy.design.export.download} onselect={() => void exportPage('download')} />
  <MenuItem icon={ExternalLink} label={copy.design.export.openBrowser} onselect={() => void exportPage('open')} />
  <DesignHandoffItems onhandoff={() => (handoffOpen = true)} note={note} />
{/snippet}

<div class="design-surface" bind:clientWidth={surfaceWidth}>
  <!-- Hidden, not unmounted: closing the dock must not drop a draft or a streaming reply. -->
  <aside
    class="pane dock"
    class:overlay={layout.dock.overlay}
    class:closed={!dockShown}
    style:width="{layout.dock.width}px"
    aria-hidden={!dockShown}
    inert={!dockShown}
  >
    <div class="dock-body">
      <!-- The dock is narrow and the dial's ticks read as stray rules beside it, so it stays off here. -->
      <Thread timeline={false} />
      {#if threadIsEmpty}
        <div class="dock-intro">
          <h2>{copy.design.dock.title}</h2>
          <p>{copy.design.dock.hint}</p>
          <DesignSystemPicker />
          <DesignStarters />
        </div>
      {/if}
      <Composer placeholder={copy.design.dock.placeholder} suggestions={false}>
        {#snippet above()}
          <DesignSelectionChips />
        {/snippet}
      </Composer>
    </div>
  </aside>
  {#if dockShown}
    <div class="edge" class:overlay={layout.dock.overlay} style:left="{layout.dock.width - 7}px">
      <ResizeHandle
        fill
        visible={!layout.dock.overlay}
        axis="x"
        label={copy.design.resize.dock}
        onstart={() => beginPane('dock')}
        onresize={(delta) => resizePane('dock', delta)}
        onend={() => designStore.endResize()}
        oncancel={() => cancelPane('dock')}
        onreset={() => designStore.resetPaneWidth('dock')}
      />
    </div>
  {/if}

  <section class="canvas-column" aria-label={copy.spaces.design} bind:clientWidth={canvasWidth} style:left="{layout.canvasLeft}px" style:right="{layout.canvasRight}px">
    <!-- One quiet line: where you are on the left, the viewport in the middle, the panels and Export on the right.
         Zoom and the pointer tools live in the dock at the bottom of the canvas. -->
    <UiToolbar wrap={false} class={uiClass("toolbar", "ui-local-46947eff", {"tight": plan.tight})} >
      <DesignToolButton
        icon={dockShown ? PanelLeftClose : PanelLeftOpen}
        label={dockShown ? copy.design.canvas.hideChat : copy.design.canvas.showChat}
        shortcut="mod+alt+c"
        pressed={dockShown}
        onclick={toggleDock}
      />
      {#if inline('page')}
        {#if pageOptions.length > 1}
          <Select size="sm" class="page-select w-auto max-w-[12rem]" aria-label={copy.design.canvas.page} options={pageOptions} value={designStore.selected} onchange={(value) => designStore.select(value)} />
        {:else if designStore.selected}
          <span class="page-name">{pageLabel(designStore.selected)}</span>
        {/if}
      {/if}

      <span class="spacer"></span>

      <!-- Which sizes every page is drawn at on the board: toggles, any mix, never none. Fit frames the whole board. -->
      <div class="viewports" role="group" aria-label={copy.design.canvas.viewport}>
        {#each SIZE_ORDER as item (item.id)}
          <DesignToolButton
            icon={SIZE_ICONS[item.id]}
            label={copy.design.toolbar.viewport[item.id]}
            shortcut={`mod+alt+${SIZE_KEYS[item.id]}`}
            class="viewport"
            pressed={designStore.sizes.includes(item.id)}
            onclick={() => designStore.toggleSize(item.id)}
          />
        {/each}
        <DesignToolButton
          icon={Maximize2}
          label={copy.design.toolbar.viewport.fit}
          shortcut="mod+alt+4"
          class="viewport"
          pressed={designStore.zoom === null}
          onclick={() => designStore.setZoom(null)}
        />
      </div>

      <span class="spacer"></span>

      {#if inline('system')}
        <DesignSystemChip showName={plan.systemName} onmanage={openSystems} />
      {/if}
      <DesignToolButton
        icon={GalleryHorizontal}
        label={copy.design.variants.title}
        shortcut="mod+alt+v"
        pressed={designStore.tray === 'variants'}
        onclick={() => designStore.toggleTray('variants')}
      />
      <DesignToolButton
        icon={History}
        label={copy.design.versions.title}
        shortcut="mod+alt+t"
        pressed={designStore.tray === 'versions'}
        onclick={() => designStore.toggleTray('versions')}
      />
      <DesignToolButton
        icon={Layers}
        label={designStore.layersOpen ? copy.design.layers.hide : copy.design.layers.show}
        shortcut="mod+alt+l"
        pressed={designStore.layersOpen}
        onclick={() => designStore.toggleLayers()}
      />
      <DesignToolButton
        icon={PanelRight}
        label={designStore.inspectorOpen ? copy.design.toolbar.hideInspector : copy.design.toolbar.showInspector}
        shortcut="mod+alt+i"
        pressed={designStore.inspectorOpen}
        onclick={() => designStore.toggleInspector()}
      />

      <Menu bind:open={moreMenu} placement="bottom-end" minWidth="14rem" label={copy.design.toolbar.more}>
        {#snippet trigger(props)}
          <IconButton label={copy.design.toolbar.more} class="design-tool" {...props}><MoreHorizontal aria-hidden="true" /></IconButton>
        {/snippet}
        {#if inMore('page') && pageOptions.length > 1}
          <div class="ui-menu-label">{copy.design.canvas.page}</div>
          {@render pageItems()}
        {/if}
        <MenuItem icon={Film} label={copy.design.timeline.title} active={designStore.tray === 'timeline'} onselect={() => designStore.toggleTray('timeline')} />
        {#if Object.keys(designStore.positions).length}
          <MenuItem icon={LayoutGrid} label={copy.design.frame.tidy} onselect={() => designStore.tidyBoard()} />
        {/if}
        {#if inMore('reload')}
          <MenuItem icon={RotateCw} label={copy.design.canvas.reload} onselect={() => designStore.reload()} />
        {/if}
        {#if inMore('folder')}
          <MenuItem icon={FolderOpen} label={copy.design.canvas.openFolder} onselect={() => designStore.reveal()} />
        {/if}
        {#if inMore('scheme')}
          <div class="ui-menu-label">{copy.design.toolbar.scheme.label}</div>
          {@render schemeItems()}
        {/if}
        {#if inMore('system')}
          <div class="ui-menu-label">{copy.design.systems.label}</div>
          <DesignSystemItems onmanage={openSystems} />
        {/if}
        {#if inMore('export')}
          <div class="ui-menu-label">{copy.design.export.button}</div>
          {@render exportItems()}
        {/if}
      </Menu>
      {#if inline('export')}
        <Menu bind:open={exportMenu} placement="bottom-end" minWidth="11rem" label={copy.design.export.button}>
          {#snippet trigger(props)}
            <Button variant="default" size="sm" class="export h-[1.625rem] rounded-full px-3 text-xs" {...props}>{copy.design.export.button}</Button>
          {/snippet}
          {@render exportItems()}
        </Menu>
      {/if}
    </UiToolbar>

    <div class="stage-wrap">
      <DesignCanvas />
      {#if designStore.layersOpen}<div class="layers-slot"><DesignLayers /></div>{/if}
      {#if exportNote}<p class="note" role="status">{exportNote}</p>{/if}
      <div class="pill-slot" bind:clientWidth={pillWidth} style:left="{pillLeft}px"><DesignToolPill compact={visibleWidth < 260} /></div>
    </div>
    <DesignTray />
    {#if designStore.tray === 'timeline'}<DesignTimeline />{/if}
  </section>

  {#if designStore.inspectorOpen}
    <div class="edge" class:overlay={layout.inspector.overlay} style:right="{layout.inspector.width - 7}px">
      <ResizeHandle
        fill
        visible={!layout.inspector.overlay}
        axis="x"
        label={copy.design.resize.inspector}
        onstart={() => beginPane('inspector')}
        onresize={(delta) => resizePane('inspector', delta)}
        onend={() => designStore.endResize()}
        oncancel={() => cancelPane('inspector')}
        onreset={() => designStore.resetPaneWidth('inspector')}
      />
    </div>
    <div class="pane side" class:overlay={layout.inspector.overlay} style:width="{layout.inspector.width}px">
      <DesignInspector />
    </div>
  {/if}

  {#if systemsOpen}<DesignSystemsDialog onclose={() => (systemsOpen = false)} />{/if}
  {#if handoffOpen}<DesignHandoffDialog onclose={() => (handoffOpen = false)} />{/if}
</div>

<style>
  .design-surface {
    --chrome: 2.25rem;
    position: relative;
    display: block;
    min-height: 0;
    min-width: 0;
    flex: 1;
    overflow: hidden;
    background: var(--background);
    border-radius: var(--radius-2xl) 0 0 0;
  }

  /* Side panes sit on the surface's full height. An overlaid one starts under the toolbar and floats. */
  .pane {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    min-width: 0;
    flex-direction: column;
    background: var(--background);
  }

  .pane.dock { left: 0; }
  .pane.side { right: 0; }
  .pane.dock.closed { display: none; }

  .pane.overlay {
    top: var(--chrome);
    z-index: 20;
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
  }

  .pane.dock.overlay { border-radius: 0 var(--float-radius) var(--float-radius) 0; }
  .pane.side.overlay { border-radius: var(--float-radius) 0 0 var(--float-radius); }

  /* The hit strip on a pane edge, centred on the boundary. A persistent rule is drawn by the handle itself. */
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 12;
    width: 14px;
  }

  .edge.overlay {
    top: var(--chrome);
    z-index: 21;
  }

  /* The rule meets the topbar with nothing to join, so it fades in across the chrome row instead of ending hard. */
  .edge :global(.resize-handle::after) {
    mask-image: linear-gradient(to bottom, transparent, #000 var(--chrome));
  }

  .canvas-column {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }

  /* One row of controls on the chrome height. Groups are told apart by spacing, never by rules. */
  :global(.toolbar.ui-local-46947eff) {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    height: var(--chrome);
    padding: 0 0.5rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  /* A cramped canvas packs the row so the controls that stay on it still fit. */
  :global(.toolbar.tight.ui-local-46947eff) { gap: 0.25rem; padding: 0 0.375rem; }
  :global(.toolbar.ui-local-46947eff) > :global(*) { flex-shrink: 0; }
  .spacer { flex: 1 1 0; min-width: 0; }

  /* The viewport switch: the app's segmented track, the current size a raised pill. */
  .viewports {
    display: inline-flex;
    align-items: center;
    gap: 0.0625rem;
    padding: 0.125rem;
    border-radius: var(--radius-full);
    background: var(--muted);
  }
  .viewports :global(.viewport) { border-radius: var(--radius-full); }
  .viewports :global(.viewport.is-on),
  .viewports :global(.viewport.is-on:hover) {
    background: var(--segment-active-bg);
    box-shadow: var(--segment-active-shadow);
  }

  /* The page path reads as a quiet address pill, ellipsized when the toolbar is tight. */
  .page-name {
    min-width: 0;
    max-width: 12rem;
    overflow: hidden;
    padding: 0.1875rem 0.625rem;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--foreground) 5%, transparent);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
  }

  .stage-wrap {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    flex-direction: column;
  }

  /* Floats over the bottom of the canvas; its left edge is set from the measured pill (see pillLeft). */
  .pill-slot {
    position: absolute;
    bottom: 0.875rem;
    z-index: 3;
  }

  /* Over the canvas's left edge, under the toolbar, clear of the tool dock. */
  .layers-slot {
    position: absolute;
    top: 0.5rem;
    bottom: 4rem;
    left: 0.5rem;
    z-index: 3;
    display: flex;
    flex-direction: column;
    pointer-events: none;
  }
  .layers-slot > :global(*) { pointer-events: auto; }

  .note {
    position: absolute;
    top: 0.75rem;
    left: 50%;
    z-index: 2;
    margin: 0;
    padding: 0.3125rem 0.75rem;
    border-radius: var(--radius-full);
    background: var(--card);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.1);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    transform: translateX(-50%);
  }

  .dock-body {
    position: relative;
    z-index: 10;
    display: flex;
    min-height: 0;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }

  /* Empty thread: the intro takes the room above the composer, which stays anchored at the bottom. */
  .dock-intro {
    display: flex;
    width: 100%;
    max-width: 22rem;
    min-height: 0;
    margin: auto;
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
    padding: 1.25rem 1rem 0.5rem;
    overflow-y: auto;
  }

  /* One left edge for the whole intro: the heading and hint start where the starter tiles do, so nothing floats centred over a left-aligned list. */
  .dock-intro h2,
  .dock-intro p {
    padding-inline: 0.625rem;
  }

  .dock-intro h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--foreground);
  }

  .dock-intro p {
    margin: -0.375rem 0 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--muted-foreground);
    text-wrap: pretty;
  }
</style>
