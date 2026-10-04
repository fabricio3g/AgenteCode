<svelte:options runes={true} />

<!--
  The board itself: one image and the marks on it, as SVG.

  SVG rather than a bitmap canvas because every mark here has to stay crisp
  under zoom, be hit-tested by the DOM, and survive being re-rendered at an
  arbitrary crop when the panel hands it to the agent. The `viewBox` carries
  the zoom and the pan and nothing else — the marks underneath are never
  touched, so what the model reads is what the user drew.
-->

<script lang="ts">
  import { canvasBoard } from './canvas-board.svelte';
  import { boundsOf, normalizeBox, resizeMark, lineEndpoints, type CanvasMark, type Point } from './canvas-doc';

  let { imageId, src }: { imageId: string; src?: string } = $props();

  let svg = $state<SVGSVGElement>();
  /** A stroke in progress, or a marked box being dragged. Never written until release. */
  let drag = $state<{ from: Point; last: Point; box: { x: number; y: number; w: number; h: number }; points: Array<[number, number]>; moving?: string } | null>(null);
  let panning = $state<{ x: number; y: number; panX: number; panY: number } | null>(null);
  /** Space pans while held. Scoped to the surface so it never eats a button press. */
  let space = $state(false);

  const image = $derived(canvasBoard.doc.images.find((item) => item.id === imageId) ?? null);
  const marks = $derived(canvasBoard.doc.marks.filter((mark) => mark.imageId === imageId));
  const labelled = $derived(new Set(canvasBoard.doc.labelled));
  const selected = $derived(canvasBoard.selectedId);
  const tool = $derived(canvasBoard.tool);
  const view = $derived(canvasBoard.doc.view);
  /** Points that carry an instruction, in board order: the numbering the agent reads. */
  const points = $derived(marks.filter((mark) => labelled.has(mark.id)));
  const box = $derived(`${-view.panX} ${-view.panY} ${(image?.w ?? 1) / view.zoom} ${(image?.h ?? 1) / view.zoom}`);
  /** What the drag has drawn so far, if anything worth drawing. */
  const draft = $derived(drag && !drag.moving ? buildDraft(drag) : null);
  const markNumber = (id: string) => points.findIndex((mark) => mark.id === id) + 1;

  /** A pointer position in image pixels: the one coordinate space marks live in. */
  function pointer(event: { clientX: number; clientY: number }): Point | null {
    const matrix = svg?.getScreenCTM();
    if (!matrix || !image) return null;
    const next = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.max(0, Math.min(image.w, next.x)), y: Math.max(0, Math.min(image.h, next.y)) };
  }

  function buildDraft(current: NonNullable<typeof drag>): CanvasMark | null {
    if (tool === 'arrow' || tool === 'line') {
      return Math.hypot(current.last.x-current.from.x, current.last.y-current.from.y) >= 2
        ? canvasBoard.draft(tool, current.box, [[current.from.x, current.from.y], [current.last.x, current.last.y]]) : null;
    }
    if (current.box.w < 2 || current.box.h < 2) return null;
    if (tool === 'freehand') {
      return current.points.length >= 2 ? canvasBoard.draft('freehand', boundsOf(current.points), current.points) : null;
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'highlight' || tool === 'blur') {
      return canvasBoard.draft(tool, current.box);
    }
    return null;
  }

  function onPointerDown(event: PointerEvent) {
    const point = pointer(event);
    if (!point || !image) return;
    if (tool === 'pan' || space || event.button === 1) {
      event.preventDefault();
      panning = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
      svg?.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'text') {
      canvasBoard.commit(canvasBoard.draft('text', { x: point.x, y: point.y, w: 0, h: 0 }));
      return;
    }
    if (tool === 'select') {
      canvasBoard.select('');
      return;
    }
    event.preventDefault();
    drag = { from: point, last: point, box: { x: point.x, y: point.y, w: 0, h: 0 }, points: [[point.x, point.y]] };
    svg?.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    const point = pointer(event);
    if (!point) return;
    if (panning) {
      // Screen pixels to image pixels: the fit scale of the whole viewBox.
      const scale = svg && image ? image.w / view.zoom / (svg.clientWidth || 1) : 1;
      canvasBoard.doc.view.panX = panning.panX - (event.clientX - panning.x) * scale;
      canvasBoard.doc.view.panY = panning.panY - (event.clientY - panning.y) * scale;
      return;
    }
    if (!drag) return;
    if (drag.moving) {
      // Apply the delta to where the mark is now, not to where it started:
      // the preview is already following the pointer, so a fixed origin here
      // would accumulate one frame of error per move.
      const mark = canvasBoard.preview ?? canvasBoard.doc.marks.find((item) => item.id === drag!.moving);
      if (mark) canvasBoard.previewMark(resizeMark(mark, { x: mark.x + (point.x - drag.last.x), y: mark.y + (point.y - drag.last.y), w: mark.w, h: mark.h }, image!));
      drag.last = point;
      return;
    }
    drag.box = normalizeBox(drag.from, point);
    drag.last = point;
    if (tool === 'freehand') {
      const last = drag.points.at(-1);
      // Skip sub-pixel jitter: a stroke is a polyline, not every mouse event.
      if (!last || Math.hypot(point.x - last[0], point.y - last[1]) > 1.5) drag.points = [...drag.points, [point.x, point.y]];
    }
  }

  function onPointerUp() {
    panning = null;
    const current = drag;
    drag = null;
    if (!current) return;
    if (current.moving) {
      const preview = canvasBoard.live(current.moving);
      canvasBoard.previewMark(null);
      const before = canvasBoard.doc.marks.find((mark) => mark.id === current.moving);
      // One history entry per drag: a move is written on release, never per frame.
      if (before && preview && (Math.abs(before.x - preview.x) > 0.5 || Math.abs(before.y - preview.y) > 0.5)) {
        canvasBoard.update(preview, { x: preview.x, y: preview.y, w: preview.w, h: preview.h });
      }
      return;
    }
    const drawn = buildDraft(current);
    if (drawn) canvasBoard.commit(drawn);
  }

  /** Wheel zooms about the cursor, so the pixel under it stays put. */
  function onWheel(event: WheelEvent) {
    if (!image) return;
    event.preventDefault();
    const point = pointer(event);
    const next = Math.max(0.2, Math.min(12, view.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const shift = 1 - view.zoom / next;
    canvasBoard.doc.view.panX = (point ? point.x * shift : 0) + view.panX;
    canvasBoard.doc.view.panY = (point ? point.y * shift : 0) + view.panY;
    canvasBoard.doc.view.zoom = next;
  }

  function onMarkDown(event: PointerEvent, mark: CanvasMark) {
    if (tool !== 'select') return;
    const point = pointer(event);
    if (!point) return;
    event.stopPropagation();
    canvasBoard.select(mark.id);
    canvasBoard.previewMark(mark);
    drag = { from: point, last: point, box: { x: mark.x, y: mark.y, w: mark.w, h: mark.h }, points: [], moving: mark.id };
    svg?.setPointerCapture(event.pointerId);
  }

  function pathOf(mark: CanvasMark): string {
    if (mark.points?.length) return mark.points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
    return `M${mark.x} ${mark.y} L${mark.x + mark.w} ${mark.y + mark.h}`;
  }

  /** The stored mark, or the one being dragged right now. */
  const shown = (mark: CanvasMark): CanvasMark => canvasBoard.live(mark.id) ?? mark;
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<svg
  bind:this={svg}
  class="canvas-surface"
  class:is-panning={!!panning || space}
  role="application"
  tabindex="0"
  aria-label={image?.name ?? 'Canvas'}
  viewBox={box}
  preserveAspectRatio="xMidYMid meet"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onwheel={onWheel}
  ondblclick={() => { canvasBoard.doc.view.zoom = 1; canvasBoard.doc.view.panX = 0; canvasBoard.doc.view.panY = 0; }}
  onkeydown={(event) => { if (event.code === 'Space') { space = true; event.preventDefault(); } }}
  onkeyup={(event) => { if (event.code === 'Space') { space = false; event.preventDefault(); } }}
  onblur={() => (space = false)}
  oncontextmenu={(event) => event.preventDefault()}
>
  <!-- A blank board has no bitmap: the paper itself is the base layer, the
       same white the export paints under the marks. -->
  {#if src}
    <image href={src} x="0" y="0" width={image?.w ?? 0} height={image?.h ?? 0} />
  {:else}
    <rect x="0" y="0" width={image?.w ?? 0} height={image?.h ?? 0} fill="#ffffff" />
  {/if}
  {#each marks as mark (mark.id)}
    {@const live = shown(mark)}
    {@const pointed = labelled.has(live.id)}
    {#if live.kind === 'highlight'}
      <rect x={live.x} y={live.y} width={live.w} height={live.h} rx="2" fill={live.color} fill-opacity="0.28" />
    {:else if live.kind === 'blur'}
      <rect x={live.x} y={live.y} width={live.w} height={live.h} rx="2" fill="var(--muted-foreground)" fill-opacity="0.5" />
    {:else if live.kind === 'text'}
      <text x={live.x} y={live.y} fill={live.color} font-size={Math.max(14, live.width * 4)} dominant-baseline="middle">{live.text || '…'}</text>
    {:else if live.kind === 'ellipse'}
      <ellipse cx={live.x + live.w / 2} cy={live.y + live.h / 2} rx={live.w / 2} ry={live.h / 2} fill="none" stroke={live.color} stroke-width={live.width} />
    {:else if live.kind === 'freehand'}
      <path d={pathOf(live)} fill="none" stroke={live.color} stroke-width={live.width} stroke-linecap="round" stroke-linejoin="round" />
    {:else if live.kind === 'line' || live.kind === 'arrow'}
      {@const endpoints = lineEndpoints(live)}
      {@const end = endpoints.end}
      {@const angle = Math.atan2(end.y - endpoints.start.y, end.x - endpoints.start.x)}
      {@const head = Math.max(10, live.width * 3)}
      <path d={pathOf(live)} fill="none" stroke={live.color} stroke-width={live.width} stroke-linecap="round" />
      {#if live.kind === 'arrow'}
        <path d={`M${end.x} ${end.y} L${end.x - head * Math.cos(angle - 0.42)} ${end.y - head * Math.sin(angle - 0.42)}`} fill="none" stroke={live.color} stroke-width={live.width} stroke-linecap="round" />
        <path d={`M${end.x} ${end.y} L${end.x - head * Math.cos(angle + 0.42)} ${end.y - head * Math.sin(angle + 0.42)}`} fill="none" stroke={live.color} stroke-width={live.width} stroke-linecap="round" />
      {/if}
    {:else}
      <rect x={live.x} y={live.y} width={live.w} height={live.h} rx="2" fill="none" stroke={live.color} stroke-width={live.width} />
      {#if selected === live.id}
        {#each [[live.x, live.y], [live.x + live.w, live.y], [live.x, live.y + live.h], [live.x + live.w, live.y + live.h]] as [hx, hy] (hx + ':' + hy)}
          <rect x={hx - 4} y={hy - 4} width="8" height="8" rx="1" fill="var(--card)" stroke={live.color} stroke-width="2" />
        {/each}
      {/if}
    {/if}
    {#if tool === 'select' || selected === live.id || pointed}
      <!-- A fat invisible stroke makes a 2px outline grabbable without a new handle. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <rect
        x={live.x - 3}
        y={live.y - 3}
        width={Math.max(live.w, 2) + 6}
        height={Math.max(live.h, 2) + 6}
        rx="3"
        fill="transparent"
        stroke="transparent"
        stroke-width={Math.max(12, live.width * 3)}
        style="pointer-events: stroke; cursor: move"
        onpointerdown={(event) => onMarkDown(event, live)}
      />
      {#if pointed}
        <circle cx={live.x + live.w / 2} cy={live.y - 10} r="5" fill="var(--card)" stroke={live.color} stroke-width="2" />
        <text x={live.x + live.w / 2} y={live.y - 10} text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="700" fill="var(--foreground)">{markNumber(live.id)}</text>
      {/if}
    {/if}
  {/each}
  {#if draft}
    {#if draft.kind === 'ellipse'}
      <ellipse cx={draft.x + draft.w / 2} cy={draft.y + draft.h / 2} rx={draft.w / 2} ry={draft.h / 2} fill="none" stroke={draft.color} stroke-width={draft.width} stroke-dasharray="6 4" />
    {:else if draft.kind === 'highlight' || draft.kind === 'blur' || draft.kind === 'rect'}
      <rect x={draft.x} y={draft.y} width={draft.w} height={draft.h} rx="2" fill={draft.kind === 'rect' ? 'none' : draft.color} fill-opacity="0.28" stroke={draft.color} stroke-width={draft.width} stroke-dasharray="6 4" />
    {:else}
      <path d={pathOf(draft)} fill="none" stroke={draft.color} stroke-width={draft.width} stroke-linecap="round" stroke-linejoin="round" stroke-dasharray={draft.kind === 'freehand' ? undefined : '6 4'} />
    {/if}
  {/if}
</svg>

<style>
  .canvas-surface { display: block; width: 100%; height: 100%; background: var(--muted); touch-action: none; user-select: none; }
  .canvas-surface:focus-visible { outline: 1px solid var(--ring); outline-offset: -1px; }
  .canvas-surface.is-panning { cursor: grab; }
</style>
