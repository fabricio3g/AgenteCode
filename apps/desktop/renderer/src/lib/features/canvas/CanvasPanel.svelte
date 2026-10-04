<svelte:options runes={true} />

<!--
  The canvas panel: an image, what you drew on it, and one button that turns
  both into something the agent can act on.

  It docks like any other panel (the workspace host owns the chrome) and keeps
  its board per conversation, so two chats never share a canvas. Points are
  labelled in the list under the surface rather than in floating inputs over
  it: a field that has to dodge zoom and pan is a field the user cannot find.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ArrowRight, Circle, Minus, MousePointer2, Move, Pencil, Plus, RotateCcw, RotateCw, Square, SquareDashed, Trash2, Type, Upload, X } from 'lucide-svelte';
  import { Button, IconButton, Tooltip } from '$lib/components/ui';
  import CanvasSurface from './CanvasSurface.svelte';
  import { canvasBoard } from './canvas-board.svelte';
  import { asFractions, formatFraction, isBlankBoard, isPoint, marksFor, type CanvasImage, type CanvasMark, type ToolId } from './canvas-doc';
  import { PREVIEW_MAX_EDGE, sendCanvasToAgent } from './canvas-handoff';
  import { invoke } from '$lib/services/bridge';
  import { mediaData } from '$lib/features/code/code-media';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { bitmapSize } from './canvas-images';

  let { chatId }: { chatId: string } = $props();

  /** The board annotates bitmaps; the composer's broader media list is not for us. */
  const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';

  let picker = $state<HTMLInputElement>();
  let dragOver = $state(false);
  let sending = $state(false);
  let showPoints = $state(true);
  let boardWidth = $state(1600);
  let boardHeight = $state(1000);

  $effect(() => { canvasBoard.useChat(chatId); });

  const image = $derived(canvasBoard.image);
  const boards = $derived(canvasBoard.doc.images);
  const marks = $derived(image ? marksFor(canvasBoard.doc, image.id) : []);
  const points = $derived(marks.filter((mark) => isPoint(mark)));
  const src = $derived(image ? canvasBoard.src(image.id) : undefined);
  /** A board painted from scratch: the paper is drawn, nothing has to load. */
  const blank = $derived(image ? isBlankBoard(image) : false);
  const ready = $derived(!!image && (blank || !!src));
  const busy = $derived(sending || !image);
  const selected = $derived(marks.find(mark => mark.id === canvasBoard.selectedId));

  function setStyle(color: string, width: number) {
    canvasBoard.color = color;
    canvasBoard.strokeWidth = Math.max(1, Math.min(24, width));
    if (selected) canvasBoard.styleMark(selected.id, { color, width: canvasBoard.strokeWidth });
  }

  const TOOL_ICONS: Array<{ id: ToolId; icon: typeof Square; key: string }> = [
    { id: 'select', icon: MousePointer2, key: 'v' },
    { id: 'rect', icon: Square, key: 'r' },
    { id: 'ellipse', icon: Circle, key: 'e' },
    { id: 'arrow', icon: ArrowRight, key: 'a' },
    { id: 'line', icon: Minus, key: 'l' },
    { id: 'freehand', icon: Pencil, key: 'p' },
    { id: 'text', icon: Type, key: 't' },
    { id: 'highlight', icon: SquareDashed, key: 'h' },
    { id: 'blur', icon: SquareDashed, key: 'b' },
    { id: 'pan', icon: Move, key: '␣' }
  ];
  const WIDTHS = [2, 4, 8];

  const readPreview = (path: string) => invoke<string | null>('agente_media_preview', { path, maxSize: PREVIEW_MAX_EDGE });

  /** Import through the daemon, then read the stored copy back to draw on. */
  async function attach(files: File[]) {
    const owner = chatId;
    for (const file of files) {
      try {
        const { attachment } = await invoke<{ attachment: { path: string; name?: string } }>('agente_media_import', await mediaData(file));
        if (!attachment?.path) continue;
        const href = await readPreview(attachment.path);
        if (!href) {
          toastStore.error($t('canvas.readFailed', { values: { name: file.name } }));
          continue;
        }
        // The natural size is the unit every mark is measured in.
        const size = await bitmapSize(href);
        if (chatId !== owner || canvasBoard.activeChatId !== owner) return;
        canvasBoard.addImage({ path: attachment.path, name: attachment.name || file.name, ...size }, href);
      } catch (error) {
        toastStore.error(String(error));
      }
    }
  }

  async function onPick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files || [])];
    input.value = '';
    if (files.length) await attach(files);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) void attach(files);
  }

  function onPaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    void attach(files);
  }

  /** Start a board from scratch: no upload, just paper and the pen. */
  function newBoard() {
    // The exported file name is built from this one and the daemon reads the
    // media kind from its extension, so the `.png` is not decoration.
    const clamp = (value: number) => Math.max(320, Math.min(4096, Number(value) || 1600));
    canvasBoard.addBoard(`${$t('canvas.boardName')}.png`, clamp(boardWidth), clamp(boardHeight));
  }

  /** Restore a board whose marks survived a restart: only the bitmaps reload. */
  $effect(() => {
    const current = image;
    if (!current || isBlankBoard(current) || src || canvasBoard.loading.has(current.id)) return;
    canvasBoard.loading.add(current.id);
    void canvasBoard.loadSrc(current, readPreview).catch((error) => {
      canvasBoard.loading.delete(current.id);
      toastStore.error(String(error));
    });
  });

  /** Panel-local shortcuts: never while a field has the caret. */
  function onKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    const ctrl = event.metaKey || event.ctrlKey;
    if (ctrl && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) canvasBoard.redo(); else canvasBoard.undo();
      return;
    }
    if (ctrl && event.key === 'Enter') {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === 'Escape') {
      canvasBoard.select('');
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && canvasBoard.selectedId) {
      event.preventDefault();
      canvasBoard.remove(canvasBoard.selectedId);
      return;
    }
    if (ctrl || event.altKey || event.metaKey) return;
    const tool = TOOL_ICONS.find((item) => item.key === event.key.toLowerCase());
    if (tool) {
      event.preventDefault();
      canvasBoard.tool = tool.id;
    }
  }

  async function send() {
    if (busy) return;
    sending = true;
    try {
      await sendCanvasToAgent($t('canvas.prompt'), $t('canvas.promptBoard'), $t('canvas.empty'), $t('canvas.sent'));
    } finally {
      sending = false;
    }
  }

  /** The badge the surface draws too: the point's number in the send order. */
  const numberOf = (mark: CanvasMark): number => points.findIndex((item) => item.id === mark.id) + 1;
  const pointName = (index: number) => $t('canvas.pointLabel', { values: { n: String(index + 1) } });
  /** Where the mark sits, as fractions — the same numbers the prompt carries. */
  function where(mark: CanvasMark, owner: CanvasImage): string {
    const box = asFractions(mark, owner);
    return `${formatFraction(box.x)},${formatFraction(box.y)}`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="canvas-panel flex min-h-0 min-w-0 flex-1 flex-col"
  class:is-drop={dragOver}
  aria-label={$t('canvas.title')}
  tabindex="-1"
  onkeydown={onKeyDown}
  onpaste={onPaste}
  ondragover={(event) => { event.preventDefault(); dragOver = true; }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
>
  <div class="canvas-bar flex flex-wrap items-center gap-0.5 border-b px-2 py-1">
    <input bind:this={picker} type="file" accept={IMAGE_ACCEPT} class="hidden" multiple onchange={onPick} />
    <Tooltip label={$t('canvas.attach')} position="bottom">
      <IconButton label={$t('canvas.attach')} size="xs" onclick={() => picker?.click()}><Upload /></IconButton>
    </Tooltip>
    <Tooltip label={$t('canvas.newBoard')} position="bottom"><IconButton label={$t('canvas.newBoard')} size="xs" onclick={newBoard}><Plus /></IconButton></Tooltip>
    <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
    {#each TOOL_ICONS as tool (tool.id)}
      {@const Icon = tool.icon}
      <Tooltip label={`${$t(`canvas.tools.${tool.id}`)} · ${tool.key}`} position="bottom">
        <IconButton
          label={$t(`canvas.tools.${tool.id}`)}
          size="xs"
          class={canvasBoard.tool === tool.id ? 'is-on' : ''}
          aria-pressed={canvasBoard.tool === tool.id}
          onclick={() => (canvasBoard.tool = tool.id)}
        ><Icon /></IconButton>
      </Tooltip>
    {/each}
    <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
    <div class="flex items-center gap-1" role="radiogroup" aria-label={$t('canvas.color')}>
      {#each canvasBoard.colors as tone (tone)}
        <button
          type="button"
          role="radio"
          aria-checked={canvasBoard.color === tone}
          aria-label={tone}
          class="canvas-swatch"
          class:is-on={canvasBoard.color === tone}
          style="background: {tone}"
          onclick={() => setStyle(tone, selected?.width ?? canvasBoard.strokeWidth)}
        ></button>
      {/each}
    </div>
    <div class="flex items-center gap-0.5" role="radiogroup" aria-label={$t('canvas.stroke')}>
      {#each WIDTHS as width (width)}
        <button
          type="button"
          role="radio"
          aria-checked={canvasBoard.strokeWidth === width}
          aria-label={$t('canvas.strokeWidth', { values: { n: String(width) } })}
          class="canvas-stroke"
          class:is-on={canvasBoard.strokeWidth === width}
          onclick={() => setStyle(selected?.color ?? canvasBoard.color, width)}
        ><span style="height: {Math.max(1, width / 2)}px"></span></button>
      {/each}
    </div>
    <span class="flex-1"></span>
    <Tooltip label={`${$t('canvas.undo')} · ⌘Z`} position="bottom">
      <IconButton label={$t('canvas.undo')} size="xs" disabled={!canvasBoard.canUndo} onclick={() => canvasBoard.undo()}><RotateCcw /></IconButton>
    </Tooltip>
    <Tooltip label={`${$t('canvas.redo')} · ⌘⇧Z`} position="bottom">
      <IconButton label={$t('canvas.redo')} size="xs" disabled={!canvasBoard.canRedo} onclick={() => canvasBoard.redo()}><RotateCw /></IconButton>
    </Tooltip>
    {#if image}
      <Tooltip label={$t('canvas.clear')} position="bottom">
        <IconButton label={$t('canvas.clear')} size="xs" onclick={() => canvasBoard.clear()}><Trash2 /></IconButton>
      </Tooltip>
    {/if}
    {#if boards.length > 1}
      <Tooltip label={$t('canvas.removeBoard')} position="bottom">
        <IconButton label={$t('canvas.removeBoard')} size="xs" onclick={() => image && canvasBoard.removeImage(image.id)}><X /></IconButton>
      </Tooltip>
    {/if}
  </div>

  <details class="canvas-settings">
    <summary>{$t('canvas.drawingSettings')}</summary>
    <div class="canvas-settings-fields">
      <label>{$t('canvas.color')}<input type="color" value={selected?.color ?? canvasBoard.color} onchange={(event) => setStyle(event.currentTarget.value, selected?.width ?? canvasBoard.strokeWidth)} /></label>
      <label>{$t('canvas.stroke')}<input type="number" min="1" max="24" value={selected?.width ?? canvasBoard.strokeWidth} onchange={(event) => setStyle(selected?.color ?? canvasBoard.color, event.currentTarget.valueAsNumber || 1)} /></label>
      <label>{$t('canvas.boardWidth')}<input type="number" min="320" max="4096" bind:value={boardWidth} /></label>
      <label>{$t('canvas.boardHeight')}<input type="number" min="320" max="4096" bind:value={boardHeight} /></label>
    </div>
  </details>

  {#if boards.length > 1}
    <div class="canvas-boards flex items-center gap-1 overflow-x-auto border-b px-2 py-1" role="tablist" aria-label={$t('canvas.boards')}>
      {#each boards as board (board.id)}
        <button
          type="button"
          role="tab"
          aria-selected={image?.id === board.id}
          class="canvas-board-chip"
          class:is-on={image?.id === board.id}
          title={board.name}
          onclick={() => canvasBoard.selectImage(board.id)}
        >{board.name}</button>
      {/each}
    </div>
  {/if}

  {#if !image}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span class="text-xs text-muted-foreground">{$t('canvas.empty')}</span>
      <div class="flex items-center gap-2">
        <Button size="sm" onclick={newBoard}><Pencil />{$t('canvas.newBoard')}</Button>
        <Button size="sm" onclick={() => picker?.click()}><Upload />{$t('canvas.uploadImage')}</Button>
      </div>
    </div>
  {:else if !ready}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">{$t('canvas.loading')}</div>
  {:else}
    <div class="min-h-0 flex-1"><CanvasSurface imageId={image.id} {src} /></div>
  {/if}

  {#if selected}
    <label class="canvas-mark-note">{$t(selected.kind === 'text' ? 'canvas.textContent' : 'canvas.markInstruction')}
      <input class="ui-input" value={selected.text ?? ''} placeholder={$t('canvas.markInstructionHint')} oninput={(event) => canvasBoard.previewMark({ ...selected, text: event.currentTarget.value })} onchange={(event) => { canvasBoard.label(selected.id, event.currentTarget.value); canvasBoard.previewMark(null); }} />
    </label>
  {/if}

  {#if image}
    <textarea class="canvas-instructions ui-input" rows="2" aria-label={$t('canvas.instructions')} placeholder={$t('canvas.instructionsHint')} value={canvasBoard.doc.instructions ?? ''} oninput={(event) => canvasBoard.setInstructions(event.currentTarget.value)} onblur={() => canvasBoard.save()}></textarea>
    <div class="flex items-center gap-2 border-t px-2 py-1">
      <button type="button" class="canvas-points-toggle text-xs text-muted-foreground hover:text-foreground" aria-expanded={showPoints} onclick={() => (showPoints = !showPoints)}>
        {$t('canvas.points', { values: { n: String(points.length) } })}
      </button>
      <span class="flex-1"></span>
      <Button size="sm" disabled={busy} title={$t('canvas.sendHint')} onclick={send}><ArrowRight />{$t('canvas.send')}</Button>
    </div>
  {/if}

  {#if showPoints && points.length}
    <ul class="canvas-points min-h-0 shrink-0 overflow-y-auto border-t" aria-label={$t('canvas.pointsList')}>
      {#each points as mark, index (mark.id)}
        {@const owner = canvasBoard.doc.images.find((item) => item.id === mark.imageId) as CanvasImage}
        <li class="canvas-point" class:is-on={canvasBoard.selectedId === mark.id}>
          <button type="button" class="canvas-point-hit" aria-label={$t('canvas.selectPoint', { values: { n: String(index + 1) } })} onclick={() => canvasBoard.select(mark.id)}>{numberOf(mark)}</button>
          <input
            class="canvas-point-label min-w-0 flex-1 bg-transparent text-xs outline-none"
            value={mark.text || ''}
            placeholder={pointName(index)}
            aria-label={pointName(index)}
            onfocus={() => canvasBoard.select(mark.id)}
            onchange={(event) => canvasBoard.label(mark.id, (event.currentTarget as HTMLInputElement).value)}
          />
          <span class="canvas-point-where tabular-nums">{where(mark, owner)}</span>
          <IconButton label={$t('canvas.removePoint')} size="xs" onclick={() => canvasBoard.remove(mark.id)}><X /></IconButton>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .canvas-panel { background: var(--card); outline: none; }
  .canvas-panel :global(.is-on) { background: var(--surface-hover); color: var(--foreground); }
  .canvas-panel.is-drop { box-shadow: inset 0 0 0 2px var(--ring); }
  .canvas-board-chip { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 8px; border-radius: var(--radius-full); font-size: var(--text-xs); color: var(--muted-foreground); background: var(--muted); }
  .canvas-board-chip:hover { color: var(--foreground); }
  .canvas-board-chip.is-on { color: var(--foreground); background: var(--surface-hover); box-shadow: inset 0 0 0 1px var(--border); }
  .canvas-swatch { width: 14px; height: 14px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--border); transition: transform var(--motion-fast) var(--motion-ease-out); }
  .canvas-swatch:hover { transform: scale(1.12); }
  .canvas-swatch.is-on { box-shadow: inset 0 0 0 1px var(--card), 0 0 0 1.5px var(--foreground); }
  .canvas-stroke { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; border-radius: var(--radius-sm); }
  .canvas-stroke span { display: block; width: 12px; background: var(--muted-foreground); border-radius: 999px; }
  .canvas-stroke:hover, .canvas-stroke.is-on { background: var(--surface-hover); }
  .canvas-stroke.is-on span { background: var(--foreground); }
  .canvas-points { max-height: 40%; background: var(--card); }
  .canvas-point { display: flex; align-items: center; gap: 6px; padding: 3px 6px; }
  .canvas-point:hover, .canvas-point.is-on { background: var(--surface-hover); }
  .canvas-point-hit { display: inline-flex; width: 20px; height: 20px; flex-shrink: 0; align-items: center; justify-content: center; border-radius: 999px; background: var(--muted); font-size: var(--text-xs); font-weight: 700; }
  .canvas-point-where { flex-shrink: 0; font-size: var(--text-xs); color: var(--muted-foreground); }
  .canvas-settings { flex-shrink: 0; padding: .25rem .5rem; color: var(--muted-foreground); font-size: var(--text-xs); }
  .canvas-settings summary { cursor: pointer; }
  .canvas-settings-fields { display: flex; flex-wrap: wrap; gap: .5rem; padding-top: .5rem; }
  .canvas-settings-fields label { display: flex; align-items: center; gap: .35rem; }
  .canvas-settings-fields input { width: 4rem; padding: .2rem; border-radius: var(--radius-sm); background: var(--muted); color: var(--foreground); }
  .canvas-settings-fields input[type=color] { width: 2rem; height: 1.5rem; }
  .canvas-mark-note { display: flex; flex-shrink: 0; flex-direction: column; gap: .25rem; padding: .4rem .5rem; color: var(--muted-foreground); font-size: var(--text-xs); }
  .canvas-instructions { flex-shrink: 0; width: calc(100% - 1rem); margin: .25rem .5rem; resize: vertical; max-height: 25%; font-size: var(--text-xs); }
</style>
