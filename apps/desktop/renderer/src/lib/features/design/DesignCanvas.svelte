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
  (DesignSelectionPrompt), and each tool has its own pointer (design-cursors).
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import DesignFrameMenu from './DesignFrameMenu.svelte';
  import { copy } from '$lib/copy';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { designStore } from './design.svelte';
  import { frameOnScreen, nextZoomPreset, pageLabel, PIN_GAP, PIN_SIZE, pinOrigin, screenBox, type BoardFrame } from './design-view';
  import { HOST_SOURCE, pickLabel, readFrameMessage, withPicker, type FrameMessage } from './design-picker';
  import { toolCursor } from './design-cursors';
  import DesignEmpty from './DesignEmpty.svelte';
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
    return out;
  });

  const scrollOf = (key: string) => scrolls[key] ?? { x: 0, y: 0 };
  const frameByKey = (key: string) => frames.find((frame) => frame.key === key);

  function post(key: string, message: Record<string, unknown>) {
    frameEls[key]?.contentWindow?.postMessage({ source: HOST_SOURCE, ...message }, '*');
  }

  /** A freshly loaded frame starts at the top, in the current tool, with its page's selection outlined. */
  function syncFrame(frame: BoardFrame) {
    scrolls = { ...scrolls, [frame.key]: { x: 0, y: 0 } };
    post(frame.key, { type: 'tool', tool: designStore.tool, cursor: toolCursor(designStore.tool) });
    post(frame.key, { type: 'highlight', selectors: selectorsByPage[frame.page] ?? [] });
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

  /** Ctrl/⌘ +, −, 0 zoom the board (0 fits it); Escape leaves a pick or comment mode. */
  function onKeydown(event: KeyboardEvent) {
    if (isEditable(event.target)) return;
    if (event.key === 'Escape' && designStore.tool !== 'browse') {
      designStore.setTool('browse');
      draft = null;
      return;
    }
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

  const pins = $derived(designStore.comments.flatMap((comment, index) =>
    frames
      .filter((frame) => frame.page === comment.page && (!comment.width || comment.width === frame.width) && live.has(frame.key))
      .map((frame) => {
        const box = screenBox(frame, view);
        const at = pinOrigin(comment, scrollOf(frame.key), view.scale, box);
        return { id: `${comment.id}:${frame.key}`, note: comment.note, number: index + 1, left: box.left + at.left, top: box.top + at.top };
      })
  ));

  /** Width of the selection prompt (17rem) and its gap from the element, for placing it inside the frame. */
  const PROMPT_WIDTH = 272;
  const PROMPT_GAP = 10;
  /**
   * Where the selection prompt opens: under the last element picked, on the frame it was picked in, left edges
   * aligned, kept inside the frame; above the element when there is no room below it.
   */
  const prompt = $derived.by(() => {
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
    const left = Math.max(box.left, Math.min(box.left + box.width - PROMPT_WIDTH, box.left + (last.box.x - scroll.x) * s));
    const below = box.top + (last.box.y + last.box.height - scroll.y) * s + PROMPT_GAP;
    const flip = below + 80 > Math.min(box.top + box.height, paneHeight);
    const top = flip ? box.top + (last.box.y - scroll.y) * s - PROMPT_GAP : below;
    const more = designStore.selection.filter((pick) => pick.page === last.page).length - 1;
    return { left, top, flip, label: pickLabel(last), more };
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
            <button
              type="button"
              class="label"
              class:active={frame.page === designStore.selected}
              class:current={frame.key === activeKey}
              class:moving={moving?.key === frame.key && moving.dragged}
              title={`${pageLabel(frame.page)} · ${frame.width}px — ${copy.design.frame.drag}`}
              onpointerdown={(event) => onLabelDown(event, frame)}
              onpointermove={onLabelMove}
              onpointerup={(event) => onLabelUp(event, frame)}
              onpointercancel={(event) => onLabelUp(event, frame)}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); designStore.select(frame.page, frame.key); } }}
              ondblclick={() => designStore.focusFrame(frame.key)}
              oncontextmenu={(event) => openMenu(event, frame)}
            >{labelFor(frame, index)}</button>
            <DesignFrameMenu {frame} bind:this={menus[frame.key]} />
          </div>
        {/if}
      {/each}
      {#if designStore.activeFrame}
        {@const ring = screenBox(designStore.activeFrame, view)}
        <span class="ring" style:left="{ring.left}px" style:top="{ring.top}px" style:width="{ring.width}px" style:height="{ring.height}px"></span>
      {/if}
      {#each pins as pin (pin.id)}
        <span class="pin" title={pin.note} style:left="{pin.left}px" style:top="{pin.top}px">{pin.number}</span>
      {/each}
    </div>
  {:else if !designStore.loading}
    <DesignEmpty />
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

  .label {
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
  .label.moving { cursor: grabbing; }
  .label:hover { color: var(--foreground); }
  .label.active { color: var(--foreground); }
  .label.current { color: var(--brand-accent); }
  .label:focus-visible { outline: 2px solid var(--brand-accent); outline-offset: 1px; border-radius: 4px; }

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
