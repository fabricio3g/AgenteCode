<svelte:options runes={true} />
<script lang="ts">
  import { Tooltip } from '$lib/components/ui';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Maximize2, Minimize2, MoreHorizontal, PanelBottom, PanelRight, PanelsTopLeft, RotateCcw, X } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import ResizeHandle from '$lib/components/ui/ResizeHandle.svelte';
  import WindowResizeHandle from '$lib/components/ui/WindowResizeHandle.svelte';
  import { workspaceLayout as defaultLayout, type WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import { clampRect, dropEdge, EDGE, measureWorkspace, panelIds, previewRect, projectedSplitRatio, resizeCorners, resizeRect, type Divider, type DockEdge, type Placement, type Rect, type ResizeCorner, type WorkspaceLayout } from './workspace-layout';
  import type { WorkspacePanel } from './workspace-panel';
  import { startPointerGesture } from '$lib/utils/pointer-gesture';

  let { panels, children, layout: workspaceLayout = defaultLayout }: { layout?: WorkspaceLayoutStore; panels: WorkspacePanel[]; children: Snippet } = $props();
  let host = $state<HTMLDivElement>();
  let size = $state({ width: 0, height: 0 });
  let preview = $state<Rect | null>(null);
  let ghost = $state<Rect | null>(null);
  let dragTitle = $state('');
  let resizeHover = $state('');
  let resizeActive = $state('');
  let resizeStart: WorkspaceLayout | null = null;
  let resizeValue = 0;
  let resizeDividerStart: Divider | null = null;
  let stopGesture: (() => void) | null = null;
  let suppressClick = false;
  let previousScope = '';
  let previousOpen = new Map<string, boolean>();
  const bounds = $derived({ x: 0, y: 0, ...size });
  const visible = $derived(new Set(panels.filter((panel) => panel.available && panel.open).map((panel) => panel.id)));
  const measured = $derived(measureWorkspace(workspaceLayout.layout, bounds, visible, workspaceLayout.focused));
  const corners = $derived(resizeCorners(measured.dividers, bounds));
  const byId = $derived(new Map(panels.map((panel) => [panel.id, panel])));
  const placementsById = $derived(new Map(measured.placements.flatMap((placement) => placement.group.panels.map((id) => [id, placement] as const))));
  // Whole pixels: a fractional edge blurs the text and hairlines inside the panel.
  const position = (rect: Rect) => `left:${Math.round(rect.x)}px;top:${Math.round(rect.y)}px;width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;`;
  const location = (id: string) => placementsById.get(id);

  $effect(() => {
    if (previousScope !== workspaceLayout.scope) { previousOpen.clear(); previousScope = workspaceLayout.scope; }
    const opened = panels.filter((panel) => panel.open && previousOpen.get(panel.id) === false);
    previousOpen = new Map(panels.map((panel) => [panel.id, panel.open]));
    for (const panel of panels) if (panel.available || !panel.id.startsWith('terminal:')) workspaceLayout.ensure(panel.id, panel.region);
    for (const panel of opened) workspaceLayout.activate(panel.id);
  });
  onMount(() => {
    const measure = () => {
      if (host && (host.clientWidth !== size.width || host.clientHeight !== size.height)) size = { width: host.clientWidth, height: host.clientHeight };
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(host!);
    const frame = requestAnimationFrame(measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); stopGesture?.(); };
  });

  function local(event: PointerEvent): { x: number; y: number } {
    const rect = host!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * size.width / rect.width, y: (event.clientY - rect.top) * size.height / rect.height };
  }
  function gesture(event: PointerEvent, move: (dx: number, dy: number, point: { x: number; y: number }) => void, finish: () => void, cancel: () => void) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopGesture?.();
    const start = local(event);
    stopGesture = startPointerGesture(event, (next) => {
      const point = local(next); move(point.x - start.x, point.y - start.y, point);
    }, (cancelled) => {
      stopGesture = null;
      if (cancelled) cancel(); else finish();
      preview = ghost = null;
      workspaceLayout.interacting = false;
      resizeActive = '';
    });
  }

  function activate(id: string) { if (suppressClick) { suppressClick = false; return; } workspaceLayout.activate(id); }
  function movePanel(event: PointerEvent, id: string, wholeWindow = false) {
    const source = location(id);
    if (!source || source.maximized || event.button !== 0) return;
    const floating = workspaceLayout.layout.floating.find((item) => item.group.id === source.floatingId);
    const whole = wholeWindow && !!floating;
    const snapshot = workspaceLayout.snapshot(), start = whole ? clampRect(floating!.rect, bounds) : source.rect;
    let dragged = false, destination: { placement: Placement; edge: DockEdge } | null = null;
    let edgeRegion: 'right' | 'bottom' | null = null;
    let next = start;
    gesture(event, (dx, dy, point) => {
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      dragged = true; workspaceLayout.interacting = true;
      dragTitle = byId.get(id)?.title ?? id;
      next = clampRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds);
      ghost = next;
      const target = [...measured.placements].sort((a, b) => b.z - a.z).find((item) => !(whole && item.floatingId === source.floatingId) && !(item.group.panels.length === 1 && item.group.panels[0] === id) && point.x >= item.rect.x && point.x <= item.rect.x + item.rect.width && point.y >= item.rect.y && point.y <= item.rect.y + item.rect.height);
      destination = target ? { placement: target, edge: dropEdge(target.rect, point.x, point.y) } : null;
      edgeRegion = !target && point.x >= bounds.width - 28 ? 'right' : !target && point.y >= bounds.height - 28 ? 'bottom' : null;
      preview = destination ? previewRect(destination.placement.rect, destination.edge) : edgeRegion === 'right' ? { x: Math.max(0, bounds.width - workspaceLayout.layout.rightWidth), y: 0, width: Math.min(bounds.width, workspaceLayout.layout.rightWidth), height: bounds.height } : edgeRegion === 'bottom' ? { x: 0, y: Math.max(0, bounds.height - workspaceLayout.layout.bottomHeight), width: measured.main.width, height: Math.min(bounds.height, workspaceLayout.layout.bottomHeight) } : null;
    }, () => {
      if (!dragged) return;
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      if (whole && source.floatingId) {
        if (destination) workspaceLayout.dockGroup(source.floatingId, destination.placement.region, destination.placement.group.id, destination.edge);
        else if (edgeRegion) workspaceLayout.dockGroup(source.floatingId, edgeRegion);
        else workspaceLayout.setFloatingRect(id, next);
        workspaceLayout.activate(id);
      } else if (destination) {
        if (destination.placement.region) workspaceLayout.dock(id, destination.placement.region, destination.placement.group.id, destination.edge);
        else workspaceLayout.dockFloating(id, destination.placement.group.id, destination.edge);
      } else if (edgeRegion) workspaceLayout.dock(id, edgeRegion);
      else if (floating && panelIds(floating.group).length === 1) { workspaceLayout.setFloatingRect(id, next); workspaceLayout.activate(id); }
      else workspaceLayout.float(id, next, bounds);
      workspaceLayout.save();
    }, () => { suppressClick = dragged; setTimeout(() => { suppressClick = false; }, 0); workspaceLayout.restore(snapshot); });
  }
  function float(id: string) {
    const current = location(id)?.rect ?? { x: 24, y: 24, width: 560, height: 360 };
    workspaceLayout.float(id, { ...current, x: current.x + 24, y: current.y + 24 }, bounds);
  }
  function dividerValue(divider: Divider): number {
    if (!divider.outer) return divider.ratio ?? 0.5;
    const rects = measured.placements.filter((item) => item.region === divider.region).map((item) => item.rect);
    if (divider.outer === 'rightTop') return Math.min(...rects.map((rect) => rect.y));
    return divider.axis === 'x' ? Math.max(...rects.map((rect) => rect.x + rect.width)) - Math.min(...rects.map((rect) => rect.x)) : Math.max(...rects.map((rect) => rect.y + rect.height)) - Math.min(...rects.map((rect) => rect.y));
  }
  function startDivider(divider: Divider) {
    resizeStart = workspaceLayout.snapshot(); workspaceLayout.interacting = true;
    resizeDividerStart = { ...divider, rect: { ...divider.rect } };
    resizeValue = dividerValue(divider);
  }
  function resizeDivider(divider: Divider, delta: number, start = resizeValue, snapshot = resizeStart) {
    if (divider.outer) {
      if (divider.outer === 'rightTop') {
        /*
         * `start` is the panel's top on screen; `rightTop` is measured from the
         * frame's inset, so the first drag of this edge would otherwise jump by
         * EDGE before the pointer had moved.
         */
        const base = start - EDGE;
        const top = Math.round(Math.max(0, Math.min(base + divider.length - 140, base + delta)));
        workspaceLayout.layout = { ...workspaceLayout.layout, rightTop: top, rightHeight: divider.length + base - top };
        return;
      }
      const reverse = divider.outer === 'rightWidth' || divider.outer === 'bottomHeight';
      const maximum = divider.outer === 'rightWidth' ? Math.max(240, bounds.width - 324) : divider.outer === 'bottomHeight' ? Math.max(140, bounds.height - 224) : divider.length;
      const minimum = divider.axis === 'x' ? 240 : 140;
      workspaceLayout.layout = { ...workspaceLayout.layout, [divider.outer]: Math.round(Math.min(maximum, Math.max(Math.min(minimum, maximum), start + (reverse ? -delta : delta)))) };
    } else {
      const root = divider.region ? snapshot?.[divider.region] : snapshot?.floating.find((item) => item.group.id === divider.floatingId)?.group ?? null;
      workspaceLayout.resizeSplit(divider.region, divider.id, projectedSplitRatio(root ?? null, divider.id, visible, start + delta / divider.length), divider.floatingId);
    }
  }
  function resizeCorner(event: PointerEvent, corner: ResizeCorner) {
    const snapshot = workspaceLayout.snapshot(), x = dividerValue(corner.x), y = dividerValue(corner.y);
    gesture(event, (dx, dy) => {
      resizeDivider(corner.x, dx, x, snapshot); resizeDivider(corner.y, dy, y, snapshot);
    }, () => workspaceLayout.save(), () => workspaceLayout.restore(snapshot));
    workspaceLayout.interacting = true; resizeActive = corner.id;
  }
  function keyCorner(event: KeyboardEvent, corner: ResizeCorner) {
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault(); const snapshot = workspaceLayout.snapshot();
    resizeDivider(corner.x, delta[0], dividerValue(corner.x), snapshot); resizeDivider(corner.y, delta[1], dividerValue(corner.y), snapshot); workspaceLayout.save();
  }
  function edgeRect(rect: Rect, edge: string): Rect {
    if (edge.length === 2) return { x: Math.max(0, Math.min(bounds.width - 24, (edge.includes('w') ? rect.x : rect.x + rect.width) - 12)), y: Math.max(0, Math.min(bounds.height - 24, (edge.includes('n') ? rect.y : rect.y + rect.height) - 12)), width: 24, height: 24 };
    if (edge === 'n' || edge === 's') return { x: rect.x + 12, y: Math.max(0, Math.min(bounds.height - 14, (edge === 'n' ? rect.y : rect.y + rect.height) - 7)), width: Math.max(0, rect.width - 24), height: 14 };
    return { x: Math.max(0, Math.min(bounds.width - 14, (edge === 'w' ? rect.x : rect.x + rect.width) - 7)), y: rect.y + 12, width: 14, height: Math.max(0, rect.height - 24) };
  }
  function resizeFloating(event: PointerEvent, id: string, edge: string, rect: Rect) {
    const snapshot = workspaceLayout.snapshot(); workspaceLayout.activate(id);
    gesture(event, (dx, dy) => workspaceLayout.setFloatingRect(id, resizeRect(rect, edge, dx, dy, bounds)), () => workspaceLayout.save(), () => workspaceLayout.restore(snapshot));
    workspaceLayout.interacting = true; resizeActive = id;
  }
  function keyResize(event: KeyboardEvent, id: string, edge: string, rect: Rect) {
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault(); workspaceLayout.setFloatingRect(id, resizeRect(rect, edge, delta[0], delta[1], bounds)); workspaceLayout.save();
  }
  function hide(panel: WorkspacePanel) { panel.onhide(); }
</script>

<div class="workspace" bind:this={host} data-workspace-interacting={workspaceLayout.interacting ? 'true' : undefined}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <main onpointerdown={() => { workspaceLayout.focused = ''; }} class="workspace-main" style="left:0;top:0;width:calc(100% - {Math.max(0,size.width-measured.main.width)}px);height:calc(100% - {Math.max(0,size.height-measured.main.height)}px);">{@render children()}</main>
  {#each panels as panel (panel.id)}
    {@const placement = location(panel.id)}
    {@const exposed = !!placement && placement.group.active === panel.id}
    {@const rect = placement?.rect ?? { x: 0, y: 0, width: 0, height: 0 }}
    <!-- All content has one stable owner. Changing groups only changes geometry/visibility. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section class="workspace-panel" class:floating={placement?.region === null} class:resize-ready={resizeHover === panel.id || resizeActive === panel.id} hidden={!exposed} style="{position(rect)}z-index:{placement?.z ?? 1}" data-workspace-panel={panel.id} data-workspace-z={placement?.z ?? 1} aria-label={panel.title} onpointerdown={() => { if (workspaceLayout.focused !== panel.id) workspaceLayout.activate(panel.id); }}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header class="workspace-header" onpointerdown={(event) => { if (!(event.target as HTMLElement).closest('button,input')) movePanel(event, panel.id, true); }}>
        <div class="workspace-tabs" role="tablist" aria-label={$t('workspace.panels')}>
          {#each placement?.group.panels ?? [panel.id] as id (id)}
            {@const item = byId.get(id)}
            {#if item}
              {@const TabIcon = item.icon}
              <button type="button" role="tab" class="workspace-tab" class:active={id === panel.id} aria-selected={id === panel.id} tabindex={id === panel.id ? 0 : -1} onclick={() => activate(id)} onpointerdown={(event) => movePanel(event, id)} onkeydown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !placement) return;
                event.preventDefault(); const ids = placement.group.panels, index = ids.indexOf(id);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
                workspaceLayout.activate(ids[next]); requestAnimationFrame(() => host?.querySelector<HTMLButtonElement>(`section:not([hidden]) [data-tab="${ids[next]}"]`)?.focus());
              }} data-tab={id} title={item.title}><TabIcon class="size-3" /><span>{item.title}</span></button>
            {/if}
          {/each}
        </div>
        {#if placement?.region === null}<Tooltip label={$t(placement.maximized ? 'workspace.restore' : 'workspace.maximize')} position="bottom"><button type="button" class="ui-icon-button is-xs" aria-label={$t(placement.maximized ? 'workspace.restore' : 'workspace.maximize')} onclick={() => workspaceLayout.maximize(panel.id)}>{#if placement.maximized}<Minimize2 />{:else}<Maximize2 />{/if}</button></Tooltip>{/if}
        <Menu placement="bottom-end" label={$t('workspace.actions')} minWidth="12rem">
          {#snippet trigger(props)}<button type="button" class="ui-icon-button is-xs" aria-label={$t('workspace.actions')} {...props}><MoreHorizontal /></button>{/snippet}
          <MenuItem icon={PanelsTopLeft} label={$t('workspace.float')} onselect={() => float(panel.id)} />
          <MenuItem icon={PanelRight} label={$t('workspace.dockRight')} onselect={() => workspaceLayout.dock(panel.id, 'right')} />
          <MenuItem icon={PanelBottom} label={$t('workspace.dockBottom')} onselect={() => workspaceLayout.dock(panel.id, 'bottom')} />
          {#each measured.placements.filter((item) => !item.group.panels.includes(panel.id)) as target (target.group.id)}
            <p class="ui-menu-group">{byId.get(target.group.active)?.title}</p>
            {#each ['center', 'left', 'right', 'top', 'bottom'] as edge (edge)}
              <MenuItem label={$t(`workspace.${edge}`)} onselect={() => { if (target.region) workspaceLayout.dock(panel.id, target.region, target.group.id, edge as DockEdge); else workspaceLayout.dockFloating(panel.id, target.group.id, edge as DockEdge); }} />
            {/each}
          {/each}
          {#each panel.actions ?? [] as action (action.label)}<MenuItem label={action.label} onselect={action.run} />{/each}
          <div class="ui-menu-separator" role="separator"></div>
          <MenuItem icon={RotateCcw} label={$t('workspace.reset')} onselect={() => workspaceLayout.reset()} />
        </Menu>
        <Tooltip label={$t('workspace.hide', { values: { name: panel.title } })} position="bottom"><button type="button" class="ui-icon-button is-xs" aria-label={$t('workspace.hide', { values: { name: panel.title } })} onclick={() => hide(panel)}><X /></button></Tooltip>
      </header>
      <div class="workspace-content">{@render panel.content({ id: panel.id, exposed, focused: exposed && workspaceLayout.focused === panel.id, rect })}</div>
    </section>
  {/each}
  {#each measured.dividers as divider (divider.id)}
    <div class="workspace-divider" style="{position(divider.rect)}z-index:{divider.floatingId ? (workspaceLayout.layout.floating.find((item) => item.group.id === divider.floatingId)?.z ?? 1) + 12 : 5}">
      <ResizeHandle fill axis={divider.axis} label={$t(divider.axis === 'x' ? 'workspace.resizeWidth' : 'workspace.resizeHeight')} onstart={() => startDivider(divider)} onresize={(delta) => resizeDivider(resizeDividerStart ?? divider, delta)} onend={() => { resizeDividerStart = null; workspaceLayout.interacting = false; workspaceLayout.save(); }} oncancel={() => { resizeDividerStart = null; if (resizeStart) workspaceLayout.restore(resizeStart); }} />
    </div>
  {/each}
  {#each corners as corner (corner.id)}
    <WindowResizeHandle edge={corner.edge} label={$t('workspace.resizeCorner')} style="{position(corner.rect)}z-index:6" active={resizeActive === corner.id} onpointerdown={(event) => resizeCorner(event, corner)} onkeydown={(event) => keyCorner(event, corner)} />
  {/each}
  {#each workspaceLayout.layout.floating as floating (floating.group.id)}
    {@const placement = measured.placements.find((item) => item.floatingId === floating.group.id)}
    {#if placement && !floating.maximized}
      {@const rect = clampRect(floating.rect, bounds)}
      {#each ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as edge (edge)}
        <WindowResizeHandle {edge} label={$t(`workspace.resizeEdges.${edge}`)} style="{position(edgeRect(rect, edge))}z-index:{floating.z + 13}" active={resizeActive === placement.group.active} onhover={(hovered) => { resizeHover = hovered ? placement.group.active : ''; }} onpointerdown={(event) => resizeFloating(event, placement.group.active, edge, rect)} onkeydown={(event) => keyResize(event, placement.group.active, edge, rect)} />
      {/each}
    {/if}
  {/each}
  {#if ghost}<div class="drag-ghost" style={position(ghost)}>{@render IconFallback()}{dragTitle}</div>{/if}
  {#if preview}<div class="drop-preview" style={position(preview)}></div>{/if}
</div>

{#snippet IconFallback()}<PanelsTopLeft class="size-3" />{/snippet}

<style>
  .workspace { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .workspace-main { position: absolute; z-index: 0; display: flex; max-width:100%;max-height:100%; min-width: 0; min-height: 0; overflow: hidden; }
  /* Quiet surfaces: one hairline and a soft shadow, no inner highlight. A docked
     panel is flat; a floating one lifts a little. */
  .workspace-panel { position: absolute; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border-radius: var(--float-radius); background: var(--card); }
  /* The edge is drawn on top of the content: an inset shadow sat under children
     with their own fill (the canvas board, the browser), so those panels lost it. */
  .workspace-panel::after { content: ''; position: absolute; inset: 0; z-index: 30; border: 1px solid var(--border-hover); border-radius: inherit; pointer-events: none; }
  .workspace-panel[hidden] { display: none; }
  .workspace-panel.floating { box-shadow: var(--float-shadow); }
  .workspace-panel.resize-ready::after { border-color: var(--split-line); }
  /* The strip owns the panel's top edge: no fill, just a hairline under it. */
  .workspace-header { display: flex; align-items: center; flex-shrink: 0; gap: 2px; height: 32px; padding: 0 6px 0 8px; cursor: grab; touch-action: none; box-shadow: inset 0 -1px 0 var(--border-subtle); }
  .workspace-header :global(.ui-icon-button) { border-color: transparent; background: transparent; box-shadow: none; }
  .workspace-header :global(.ui-icon-button:hover) { background: var(--surface-hover); border-color: transparent; }
  .workspace-tabs { display: flex; min-width: 0; flex: 1; gap: 2px; overflow-x: auto; scrollbar-width: none; }
  .workspace-tab { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 180px; height: 22px; padding: 0 8px; flex-shrink: 0; border-radius: var(--radius-full); font-size: var(--text-xs); color: var(--muted-foreground); cursor: grab; touch-action: none; transition: color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease); }
  .workspace-tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-tab:hover { color: var(--foreground); }
  .workspace-tab.active { color: var(--foreground); background: var(--surface-active); font-weight: 500; }
  .workspace-tab:focus-visible { outline: 1px solid var(--ring); outline-offset: -1px; }
  .workspace-content { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
  .workspace-divider { position: absolute; }
  .workspace-panel.resize-ready { box-shadow: inset 0 0 0 1px var(--muted-foreground), 0 8px 30px #0002; }
  .drag-ghost, .drop-preview { position: absolute; pointer-events: none; z-index: 100000; border-radius: 0.75rem; }
  .drag-ghost { display: flex; align-items: flex-start; gap: 6px; padding: 8px; opacity: .75; color: var(--muted-foreground); background: var(--card); box-shadow: var(--shadow-lg); font-size: var(--text-xs); }
  .drop-preview { background: color-mix(in srgb, var(--foreground) 8%, transparent); box-shadow: inset 0 0 0 1px var(--border-hover); }
</style>
