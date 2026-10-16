<svelte:options runes={true} />

<!--
  The board: every page and variant of the design as labelled frames, a row
  each, one frame per size chosen in the top bar, on a desk you pan and zoom.
  Each frame is the page inlined by the same builder the agent's preview tool
  uses (what you see is what it sees), in a sandboxed frame with an opaque
  origin; the picker script rides in it (never in the agent's render) and
  reports picks, comments and text edits back over postMessage, which the board
  routes by the frame that sent them.

  The board is one transformed layer (designStore.view: fitted, or an explicit
  zoom and pan). Labels, pins, the selection prompt and the comment draft sit
  in a screen layer above it, so they keep their size at any zoom. Frames far
  off screen draw a blank sheet instead of running the page.

  Pan: drag the desk (Browse, or the middle button with any tool), or scroll
  over it; Ctrl/⌘+wheel and pinch zoom around the pointer, over the desk or
  inside a frame. Click a label to make that page the selected one, double-
  click it to zoom to the frame. In Select, a prompt opens under the last pick
  (DesignSelectionPrompt) and, for one picked element, the edit toolbar above it
  (DesignEditBar); each tool has its own pointer (design-cursors). Draw lays an
  SVG over the frames: a mark is kept in page coordinates, so it follows the
  frame's scroll, and the frame is asked what it crosses.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import DesignFrameMenu from './DesignFrameMenu.svelte';
  import { copy } from '$lib/copy';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { designStore } from './design.svelte';
  import { editBarPlacement, frameOnScreen, nextZoomPreset, pageLabel, PIN_GAP, PIN_SIZE, pinOrigin, screenBox, type BoardFrame } from './design-view';
  import { flowPath } from '$shared/design-flows';
  import { isMark, POINT_GAP, rankHits, samplePoints, screenPoints, type Pt } from './design-strokes';
  import { HOST_SOURCE, pickLabel, readFrameMessage, withPicker, type FrameMessage } from './design-picker';
  import { toolCursor } from './design-cursors';
  import DesignEmpty from './DesignEmpty.svelte';
  import DesignEditBar from './DesignEditBar.svelte';
  import DesignSelectionPrompt from './DesignSelectionPrompt.svelte';

  /** A comment being written: the frame it is on, where it was clicked (page px) and where its field sits (screen px). */
  interface Draft { key: string; x: number; y: number; selector: string; left: number; top: number }

  let stage = $state<HTMLDivElement>();
  let paneWidth = $state(0);
  let paneHeight = $state(0);
  /** Each frame's own scroll, reported by its picker. */
  let scrolls = $state<Record<string, { x: number; y: number }>>({});
  /** The live frames, by key. */
  const frameEls: Record<string, HTMLIFrameElement | undefined> = $state({});
  let draft = $state<Draft | null>(null);
  let draftNote = $state('');
  let panning = $state<{ id: number; x: number; y: number } | null>(null);
  /** A frame being moved by its label: where the pointer and the frame started. Past 3px it is a drag, not a click. */
  let moving = $state<{ key: string; id: number; px: number; py: number; x: number; y: number; dragged: boolean } | null>(null);
  /** Each frame label's menu, so a right-click on the label can open it at the pointer. */
  const menus: Record<string, DesignFrameMenu | undefined> = $state({});

  $effect(() => { designStore.pane = { width: paneWidth, height: paneHeight }; });

  const board = $derived(designStore.board);
  const view = $derived(designStore.view);
  const frames = $derived(board.frames);
  const cursor = $derived(toolCursor(designStore.tool));
  const activeKey = $derived(designStore.activeFrame?.key ?? '');

  /** One inlined document per page, shared by that page's frames at every size. */
  const docs = $derived.by(() => {
    const { files } = designStore.data;
    const out: Record<string, string> = {};
    for (const page of new Set(frames.map((frame) => frame.page))) {
      const source = files[page];
      if (source === undefined) continue;
      try { out[page] = withPicker(buildPreviewHtml(source, files, page, true).html); } catch { /* a page that cannot be built draws as a blank sheet */ }
    }
    return out;
  });

  /** Frames on screen (or near it) run their page; the rest are blank sheets until panned into view. */
  const live = $derived(new Set(frames.filter((frame) => frameOnScreen(frame, view, { width: paneWidth, height: paneHeight })).map((frame) => frame.key)));
  const selectorsByPage = $derived.by(() => {
    const out: Record<string, string[]> = {};
    for (const pick of designStore.selection) (out[pick.page] ??= []).push(pick.selector);
    // The Layers row under the pointer is outlined on the page it lists.
    const hover = designStore.layerHover;
    const page = designStore.activeFrame?.page;
    if (hover && page) (out[page] ??= []).push(hover);
    return out;
  });

  const scrollOf = (key: string) => scrolls[key] ?? { x: 0, y: 0 };
  const frameByKey = (key: string) => frames.find((frame) => frame.key === key);

  function post(key: string, message: Record<string, unknown>) {
    frameEls[key]?.contentWindow?.postMessage({ source: HOST_SOURCE, ...message }, '*');
  }

  /**
   * A freshly loaded frame starts at the top, in the current tool, with its page's selection outlined. After a
   * direct edit the page reloads under the user: it keeps its scroll and picks the edited element again, so the
   * toolbar follows the new size.
   */
  function syncFrame(frame: BoardFrame) {
    const again = designStore.repick;
    const fresh = !!again && again.page === frame.page && Date.now() - again.at < 4000;
    const keep = fresh ? scrollOf(frame.key) : { x: 0, y: 0 };
    scrolls = { ...scrolls, [frame.key]: keep };
    if (fresh && (keep.x || keep.y)) post(frame.key, { type: 'scrollTo', x: keep.x, y: keep.y });
    post(frame.key, { type: 'tool', tool: designStore.tool, cursor: toolCursor(designStore.tool) });
    post(frame.key, { type: 'highlight', selectors: selectorsByPage[frame.page] ?? [] });
    const only = designStore.selection.length === 1 ? designStore.selection[0] : null;
    if (fresh && again && only && only.selector === again.selector && (!only.width || only.width === frame.width)) post(frame.key, { type: 'pick', selector: again.selector });
    if (frame.key === activeKey && designStore.tray === 'timeline') designStore.sendAnim({ action: 'open' });
  }

  $effect(() => {
    const tool = designStore.tool;
    untrack(() => { if (tool !== 'comment') draft = null; });
    for (const frame of untrack(() => frames)) post(frame.key, { type: 'tool', tool, cursor: toolCursor(tool) });
  });
  $effect(() => {
    for (const frame of frames) post(frame.key, { type: 'highlight', selectors: selectorsByPage[frame.page] ?? [] });
  });
  // The timeline drives the active frame only: the selected page at its widest size.
  $effect(() => {
    const key = activeKey;
    designStore.bindFrame(key ? (command) => post(key, { type: 'anim', ...command }) : null);
    return () => designStore.bindFrame(null);
  });

  // The store reaches the active frame (a Layers pick) and every frame (a live token preview) through the canvas.
  $effect(() => {
    const key = activeKey;
    designStore.bindFrames({
      post: (message) => { if (key) post(key, message); },
      broadcast: (message) => { for (const frame of untrack(() => frames)) post(frame.key, message); }
    });
    return () => designStore.bindFrames(null);
  });

  /** The note field opens beside the pin it will become, vertically centred on it. */
  function openDraft(frame: BoardFrame, message: Extract<FrameMessage, { type: 'comment' }>) {
    const box = screenBox(frame, view);
    const at = pinOrigin(message, scrollOf(frame.key), view.scale, box);
    draft = { key: frame.key, x: message.x, y: message.y, selector: message.selector, left: box.left + at.left + PIN_SIZE + PIN_GAP, top: box.top + at.top + PIN_SIZE / 2 };
    draftNote = '';
  }

  function saveDraft() {
    if (!draft) return;
    const note = draftNote.trim();
    const frame = frameByKey(draft.key);
    if (note && frame) designStore.addComment({ page: frame.page, selector: draft.selector, x: draft.x, y: draft.y, note, width: frame.width });
    draft = null;
    draftNote = '';
  }

  function cancelDraft() {
    draft = null;
    draftNote = '';
  }

  /** The frame a message came from, by its window; messages from anything else are ignored. */
  function senderOf(event: MessageEvent): BoardFrame | undefined {
    for (const frame of frames) {
      if (frameEls[frame.key]?.contentWindow === event.source) return frame;
    }
    return undefined;
  }

  function onMessage(event: MessageEvent) {
    const frame = senderOf(event);
    if (!frame) return;
    const message = readFrameMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'select':
        designStore.select(frame.page, frame.key);
        designStore.addSelection(message.element, message.additive, frame.page, frame.width);
        break;
      case 'comment':
        designStore.select(frame.page, frame.key);
        openDraft(frame, message);
        break;
      case 'textEdit':
        void designStore.applyTextEdit({ page: frame.page, selector: message.selector, oldText: message.oldText, newText: message.newText, x: message.x, y: message.y, width: frame.width });
        break;
      case 'escape':
        designStore.setTool('browse');
        break;
      case 'probe':
        designStore.setStrokeHits(message.id, rankHits(message.hits));
        break;
      case 'scroll':
        scrolls = { ...scrolls, [frame.key]: { x: message.x, y: message.y } };
        break;
      case 'animations':
        if (frame.key === activeKey) designStore.setMotionItems(message.items, message.reduced);
        break;
      case 'animTick':
        if (frame.key === activeKey) designStore.setPlayhead(message.time, message.playing, message.count);
        break;
      case 'wheel': {
        // The pointer inside the frame, carried to the desk: zoom holds that spot of the page.
        const box = screenBox(frame, view);
        const point = message.x !== undefined && message.y !== undefined
          ? { x: box.left + message.x * view.scale, y: box.top + message.y * view.scale }
          : undefined;
        designStore.zoomByFactor(Math.exp(-message.deltaY * 0.002), point);
        break;
      }
      case 'hover':
        break;
    }
  }

  function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  }

  /** Ctrl/⌘ +, −, 0 zoom the board (0 fits it). Escape belongs to the surface (marks first, then the tool). */
  function onKeydown(event: KeyboardEvent) {
    if (isEditable(event.target)) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      designStore.setZoom(nextZoomPreset(view.scale, 1));
    } else if (event.key === '-') {
      event.preventDefault();
      designStore.setZoom(nextZoomPreset(view.scale, -1));
    } else if (event.key === '0') {
      event.preventDefault();
      designStore.setZoom(null);
    }
  }

  function localPoint(event: { clientX: number; clientY: number }) {
    const rect = stage?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  /** Over the desk: scrolling pans, Ctrl/⌘+wheel and pinch zoom around the pointer. */
  function onStageWheel(event: WheelEvent) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) designStore.zoomByFactor(Math.exp(-event.deltaY * 0.002), localPoint(event));
    else designStore.panBy(-event.deltaX, -event.deltaY);
  }

  // A non-passive listener, so the page does not scroll or pinch-zoom under the board.
  $effect(() => {
    const el = stage;
    if (!el) return;
    el.addEventListener('wheel', onStageWheel, { passive: false });
    return () => el.removeEventListener('wheel', onStageWheel);
  });

  /** The desk itself (not a frame, label or float) takes a drag as a pan: in Browse, or with the middle button. */
  function onDeskDown(event: PointerEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('[data-desk]') || target.closest('[data-board-frame], [data-board-float]')) return;
    if (!(event.button === 1 || (event.button === 0 && designStore.tool === 'browse'))) return;
    event.preventDefault();
    stage?.setPointerCapture(event.pointerId);
    panning = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onDeskMove(event: PointerEvent) {
    if (!panning || event.pointerId !== panning.id) return;
    designStore.panBy(event.clientX - panning.x, event.clientY - panning.y);
    panning = { ...panning, x: event.clientX, y: event.clientY };
  }

  function onDeskUp(event: PointerEvent) {
    if (!panning || event.pointerId !== panning.id) return;
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    panning = null;
  }

  function onLabelDown(event: PointerEvent, frame: BoardFrame) {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    moving = { key: frame.key, id: event.pointerId, px: event.clientX, py: event.clientY, x: frame.x, y: frame.y, dragged: false };
  }

  function onLabelMove(event: PointerEvent) {
    if (!moving || event.pointerId !== moving.id) return;
    const dx = event.clientX - moving.px;
    const dy = event.clientY - moving.py;
    if (!moving.dragged && Math.hypot(dx, dy) < 3) return;
    moving.dragged = true;
    designStore.moveFrame(moving.key, moving.x + dx / view.scale, moving.y + dy / view.scale);
  }

  /** A release after a drag keeps the new place; a release without one is a click, which selects the frame. */
  function onLabelUp(event: PointerEvent, frame: BoardFrame) {
    if (!moving || event.pointerId !== moving.id) return;
    const dragged = moving.dragged;
    moving = null;
    if (dragged) designStore.endMove();
    else designStore.select(frame.page, frame.key);
  }

  function openMenu(event: MouseEvent, frame: BoardFrame) {
    event.preventDefault();
    designStore.select(frame.page, frame.key);
    menus[frame.key]?.openAt({ x: event.clientX, y: event.clientY });
  }

  /** "index.html · 1440" on a row's first frame; the other sizes of the row show their width only. */
  function labelFor(frame: BoardFrame, index: number): string {
    const first = index === 0 || frames[index - 1].page !== frame.page;
    return first ? `${pageLabel(frame.page)} · ${frame.width}` : String(frame.width);
  }

  /** Page links as quiet arrows, one per size on the board (the same size of each page), in screen px. */
  const arrows = $derived(designStore.links.flatMap((link) =>
    designStore.sizes.flatMap((size) => {
      const from = designStore.frame(link.from, size);
      const to = designStore.frame(link.to, size);
      if (!from || !to) return [];
      const a = screenBox(from, view);
      const b = screenBox(to, view);
      if (a.width < 28 || b.width < 28) return [];
      return [{ id: `${link.from}>${link.to}:${size}`, ...flowPath(a, b) }];
    })
  ));

  const pins = $derived(designStore.comments.flatMap((comment, index) =>
    frames
      .filter((frame) => frame.page === comment.page && (!comment.width || comment.width === frame.width) && live.has(frame.key))
      .map((frame) => {
        const box = screenBox(frame, view);
        const at = pinOrigin(comment, scrollOf(frame.key), view.scale, box);
        return { id: `${comment.id}:${frame.key}`, note: comment.note, number: index + 1, left: box.left + at.left, top: box.top + at.top };
      })
  ));

  /** Width of the selection prompt (17rem), its gap from the element, its height, and the edit toolbar's height. */
  const PROMPT_WIDTH = 272;
  const PROMPT_GAP = 10;
  const PROMPT_HEIGHT = 80;
  const BAR_HEIGHT = 34;
  let barWidth = $state(340);

  /**
   * The last element picked, on the frame it was picked in, in screen px: the prompt and the edit toolbar both
   * hang off it. `flip` is set when the prompt has no room below and goes above.
   */
  const target = $derived.by(() => {
    if (designStore.tool !== 'select' || draft) return null;
    const last = designStore.selection.at(-1);
    if (!last) return null;
    // On the frame it was picked in: the active one when it shows that page, else the page's frame at the pick's width.
    const active = designStore.activeFrame;
    const frame = active?.page === last.page ? active : frames.find((item) => item.page === last.page && (!last.width || item.width === last.width));
    if (!frame) return null;
    const box = screenBox(frame, view);
    const scroll = scrollOf(frame.key);
    const s = view.scale;
    const el = { left: box.left + (last.box.x - scroll.x) * s, top: box.top + (last.box.y - scroll.y) * s, width: last.box.width * s, height: last.box.height * s };
    const below = el.top + el.height + PROMPT_GAP;
    return { last, box, el, below, flip: below + PROMPT_HEIGHT > Math.min(box.top + box.height, paneHeight) };
  });

  /** The edit toolbar: one element picked, just above it, or below it when the top is out of room. */
  const editBar = $derived.by(() => {
    const t = target;
    if (!t || designStore.selection.length !== 1) return null;
    // The frame's top edge is the bar's ceiling: its label sits just above, and the bar must not cover it.
    const place = editBarPlacement(t.el, { width: barWidth, height: BAR_HEIGHT }, { width: paneWidth, height: paneHeight }, 8, 4, t.box.top + 4);
    // A prompt that flipped above the element takes that room; the toolbar goes above the prompt, never above the frame.
    const top = t.flip && !place.below ? Math.max(4, t.box.top + 4, place.top - PROMPT_HEIGHT - 6) : place.top;
    return { left: place.left, top, below: place.below, pick: t.last };
  });

  /**
   * Where the selection prompt opens: under the last element picked, left edges aligned, kept inside the frame;
   * above the element when there is no room below it, and under the edit toolbar when that sits below.
   */
  const prompt = $derived.by(() => {
    const t = target;
    if (!t) return null;
    const left = Math.max(t.box.left, Math.min(t.box.left + t.box.width - PROMPT_WIDTH, t.el.left));
    const top = t.flip ? t.el.top - PROMPT_GAP : t.below + (editBar?.below ? BAR_HEIGHT + PROMPT_GAP : 0);
    const more = designStore.selection.filter((pick) => pick.page === t.last.page).length - 1;
    return { left, top, flip: t.flip, label: pickLabel(t.last), more };
  });

  // Marks: drawn in page coordinates on the frame under the pointer's first point.
  let drawing = $state<{ id: number; key: string; points: Pt[]; last: Pt } | null>(null);

  /** The live frame under a point of the stage, the topmost one. */
  function frameAt(point: Pt): BoardFrame | undefined {
    return frames.filter((frame) => live.has(frame.key)).reverse().find((frame) => {
      const box = screenBox(frame, view);
      return point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height;
    });
  }

  /** A screen point as a point of the frame's page (clamped to the frame). */
  function pagePoint(frame: BoardFrame, point: Pt): Pt {
    const box = screenBox(frame, view);
    const scroll = scrollOf(frame.key);
    const x = Math.min(box.left + box.width, Math.max(box.left, point.x));
    const y = Math.min(box.top + box.height, Math.max(box.top, point.y));
    return { x: Math.round(((x - box.left) / view.scale + scroll.x) * 10) / 10, y: Math.round(((y - box.top) / view.scale + scroll.y) * 10) / 10 };
  }

  function onDrawDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const at = localPoint(event);
    const frame = frameAt(at);
    if (!frame) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    designStore.select(frame.page, frame.key);
    const first = pagePoint(frame, at);
    drawing = { id: event.pointerId, key: frame.key, points: [first], last: at };
  }

  function onDrawMove(event: PointerEvent) {
    if (!drawing || event.pointerId !== drawing.id) return;
    const frame = frameByKey(drawing.key);
    if (!frame) return;
    const at = localPoint(event);
    if (Math.hypot(at.x - drawing.last.x, at.y - drawing.last.y) < POINT_GAP) return;
    drawing = { ...drawing, points: [...drawing.points, pagePoint(frame, at)], last: at };
  }

  /** A finished mark is kept when it is more than a click, and the frame is asked which elements it crosses. */
  function onDrawUp(event: PointerEvent) {
    if (!drawing || event.pointerId !== drawing.id) return;
    const { key, points } = drawing;
    drawing = null;
    const frame = frameByKey(key);
    if (!frame || !isMark(points)) return;
    const id = designStore.addStroke({ page: frame.page, width: frame.width, points });
    const scroll = scrollOf(key);
    post(key, { type: 'probe', id, points: samplePoints(points).map((p) => ({ x: Math.round(p.x - scroll.x), y: Math.round(p.y - scroll.y) })) });
  }

  /** Each live frame's marks, as SVG point lists relative to the frame's top-left; the mark being drawn is one of them. */
  const marks = $derived.by(() => {
    const out: { id: string; frameKey: string; left: number; top: number; width: number; height: number; points: string }[] = [];
    const strokes = [...designStore.strokes.map((item) => ({ id: item.id, page: item.page, width: item.width, points: item.points }))];
    if (drawing) {
      const frame = frameByKey(drawing.key);
      if (frame) strokes.push({ id: 'drawing', page: frame.page, width: frame.width, points: drawing.points });
    }
    for (const frame of frames) {
      if (!live.has(frame.key)) continue;
      const box = screenBox(frame, view);
      const scroll = scrollOf(frame.key);
      for (const stroke of strokes) {
        if (stroke.page !== frame.page || (stroke.width && stroke.width !== frame.width)) continue;
        if (stroke.id === 'drawing' && drawing?.key !== frame.key) continue;
        out.push({ id: `${stroke.id}:${frame.key}`, frameKey: frame.key, left: box.left, top: box.top, width: box.width, height: box.height, points: screenPoints(stroke.points, scroll, view.scale) });
      }
    }
    return out;
  });
</script>

<svelte:window onmessage={onMessage} onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="stage"
  class:panning={!!panning}
  class:can-pan={designStore.tool === 'browse'}
  data-desk
  bind:this={stage}
  bind:clientWidth={paneWidth}
  bind:clientHeight={paneHeight}
  onpointerdown={onDeskDown}
  onpointermove={onDeskMove}
  onpointerup={onDeskUp}
  onpointercancel={onDeskUp}
>
  {#if frames.length}
    <div class="board" style:transform="translate({view.x}px, {view.y}px) scale({view.scale})">
      {#key designStore.reloadKey}
        {#each frames as frame (frame.key)}
          <div
            class="frame"
            class:variant={frame.variant}
            data-board-frame={frame.key}
            style:left="{frame.x}px"
            style:top="{frame.y}px"
            style:width="{frame.width}px"
            style:height="{frame.height}px"
            style:cursor={cursor || undefined}
          >
            {#if live.has(frame.key) && docs[frame.page] !== undefined}
              <iframe
                bind:this={frameEls[frame.key]}
                srcdoc={docs[frame.page]}
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                title={`${copy.design.canvas.previewLabel}: ${pageLabel(frame.page)}, ${frame.width}px`}
                onload={() => syncFrame(frame)}
                style:color-scheme={designStore.scheme === 'auto' ? undefined : designStore.scheme}
              ></iframe>
            {/if}
          </div>
        {/each}
      {/key}
    </div>

    <!-- The screen layer: labels, the active frame's ring, pins and floats keep their size at any zoom. -->
    <div class="overlay">
      {#each frames as frame, index (frame.key)}
        {@const box = screenBox(frame, view)}
        {#if box.width >= 28}
          <div class="head" data-board-float style:left="{box.left}px" style:top="{box.top - 24}px" style:width="{Math.max(28, box.width)}px">
            <Button
              variant="plain"
              class={`label${frame.page === designStore.selected ? ' active' : ''}${frame.key === activeKey ? ' current' : ''}${moving?.key === frame.key && moving.dragged ? ' moving' : ''}`}
              title={`${pageLabel(frame.page)} · ${frame.width}px — ${copy.design.frame.drag}`}
              onpointerdown={(event) => onLabelDown(event, frame)}
              onpointermove={onLabelMove}
              onpointerup={(event) => onLabelUp(event, frame)}
              onpointercancel={(event) => onLabelUp(event, frame)}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); designStore.select(frame.page, frame.key); } }}
              ondblclick={() => designStore.focusFrame(frame.key)}
              oncontextmenu={(event) => openMenu(event, frame)}
            >{labelFor(frame, index)}</Button>
            <DesignFrameMenu {frame} bind:this={menus[frame.key]} />
          </div>
        {/if}
      {/each}
      {#if arrows.length}
        <svg class="flows" aria-hidden="true">
          {#each arrows as arrow (arrow.id)}
            <path d={arrow.d} />
            <path class="head-mark" d="M-7 -4L0 0L-7 4" transform="translate({arrow.x} {arrow.y}) rotate({arrow.angle})" />
          {/each}
        </svg>
      {/if}
      {#if designStore.activeFrame}
        {@const ring = screenBox(designStore.activeFrame, view)}
        <span class="ring" style:left="{ring.left}px" style:top="{ring.top}px" style:width="{ring.width}px" style:height="{ring.height}px"></span>
      {/if}
      {#each marks as mark (mark.id)}
        <svg class="marks" style:left="{mark.left}px" style:top="{mark.top}px" style:width="{mark.width}px" style:height="{mark.height}px" aria-hidden="true">
          <polyline points={mark.points} />
        </svg>
      {/each}
      {#each pins as pin (pin.id)}
        <span class="pin" title={pin.note} style:left="{pin.left}px" style:top="{pin.top}px">{pin.number}</span>
      {/each}
    </div>
  {:else if !designStore.loading}
    <DesignEmpty />
  {/if}

  {#if designStore.tool === 'draw' && frames.length}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="draw-layer"
      style:cursor={cursor || 'crosshair'}
      onpointerdown={onDrawDown}
      onpointermove={onDrawMove}
      onpointerup={onDrawUp}
      onpointercancel={onDrawUp}
    ></div>
  {/if}

  {#if editBar}
    <div class="edit-slot" data-board-float style:left="{editBar.left}px" style:top="{editBar.top}px" bind:clientWidth={barWidth}>
      <DesignEditBar pick={editBar.pick} />
    </div>
  {/if}

  {#if prompt}
    {#key prompt.label}
      <div class="prompt-slot" class:flip={prompt.flip} data-board-float style:left="{prompt.left}px" style:top="{prompt.top}px">
        <DesignSelectionPrompt label={prompt.label} more={prompt.more} />
      </div>
    {/key}
  {/if}

  {#if draft}
    <div class="draft ui-float" data-board-float style:left="{draft.left}px" style:top="{draft.top}px">
      <Input
        autofocus
        variant="surface"
        class="h-8 text-xs"
        bind:value={draftNote}
        placeholder={copy.design.comments.placeholder}
        aria-label={copy.design.comments.placeholder}
        onkeydown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); saveDraft(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelDraft(); }
        }}
      />
      <span class="draft-hint">{copy.design.comments.hint}</span>
    </div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    touch-action: none;
    /* A tinted desk under the frames, so each reads as an object without a border. */
    background-color: color-mix(in srgb, var(--foreground) 4%, var(--background));
    background-image: radial-gradient(color-mix(in srgb, var(--foreground) 10%, transparent) 1px, transparent 1px);
    background-size: 16px 16px;
  }
  .stage.can-pan { cursor: grab; }
  .stage.panning { cursor: grabbing; }

  .board {
    position: absolute;
    inset: 0 auto auto 0;
    transform-origin: 0 0;
    will-change: transform;
  }

  .frame {
    position: absolute;
    overflow: hidden;
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 28px rgb(0 0 0 / 0.1);
  }

  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  /* Above the board, below the floats; only labels take the pointer. */
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    overflow: hidden;
  }

  /* Page links: a thin muted line that never competes with the frames it joins. */
  .flows {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    fill: none;
    stroke: color-mix(in srgb, var(--foreground) 38%, transparent);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A frame's head: the label (drag it to move the frame) and, on hover, its menu. */
  .head {
    position: absolute;
    display: flex;
    height: 1.25rem;
    align-items: center;
    gap: 0.25rem;
    pointer-events: none;
  }
  .head :global(.frame-menu) {
    flex-shrink: 0;
    margin-left: auto;
    opacity: 0;
    pointer-events: auto;
  }
  .head:hover :global(.frame-menu),
  .head :global(.frame-menu[aria-expanded='true']),
  .head :global(.frame-menu:focus-visible) { opacity: 1; }

  .head :global(.label) {
    min-width: 0;
    overflow: hidden;
    padding: 0 0.125rem;
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.25rem;
    font-variant-numeric: tabular-nums;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
  }
  .head :global(.label.moving) { cursor: grabbing; }
  .head :global(.label:hover) { color: var(--foreground); }
  .head :global(.label.active) { color: var(--foreground); }
  .head :global(.label.current) { color: var(--brand-accent); }
  .head :global(.label:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: 1px; border-radius: 4px; }

  /* The frame the inspector, export and timeline act on. */
  .ring {
    position: absolute;
    border-radius: 11px;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand-accent) 70%, transparent);
  }

  .pin {
    position: absolute;
    display: inline-flex;
    min-width: 1.25rem;
    height: 1.25rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.3rem;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--brand-accent) 88%, var(--background));
    color: var(--background);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    /* A thin ring of the page's own background keeps the disc legible over any colour it lands on. */
    box-shadow: 0 0 0 2px var(--background);
  }

  /* Marks: ember, 2px, clipped to the frame they belong to. */
  .marks { position: absolute; overflow: hidden; pointer-events: none; }
  .marks polyline {
    fill: none;
    stroke: var(--brand-accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Catches the pointer while drawing, above the frames and the screen layer, below the floats. */
  .draw-layer { position: absolute; inset: 0; z-index: 1; touch-action: none; }

  .edit-slot { position: absolute; z-index: 2; }

  /* Under the element, or above it when flipped. */
  .prompt-slot {
    position: absolute;
    z-index: 2;
  }
  .prompt-slot.flip { transform: translateY(-100%); }

  /* A float like the app's other popovers: the note field and its hint, beside the pin. */
  .draft {
    position: absolute;
    z-index: 2;
    display: flex;
    width: 16rem;
    flex-direction: column;
    gap: 0.25rem;
    padding: var(--float-pad);
    transform: translateY(-50%);
  }

  .draft-hint {
    padding: 0 0.375rem 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
</style>
