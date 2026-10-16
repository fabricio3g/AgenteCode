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
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { ArrowRight, Check, EyeOff, Highlighter, ChevronLeft, ChevronRight, Circle, ImagePlus, Minus, MousePointer2, Move, Pencil, Plus, RotateCcw, RotateCw, Square, SquareDashed, Trash2, Type, Upload, X } from 'lucide-svelte';
  import { Button, IconButton, Menu, PaneHeader, Tooltip } from '$lib/components/ui';
  import CanvasSurface from './CanvasSurface.svelte';
  import { getCanvasBoard } from './canvas-context';
  const canvasBoard = getCanvasBoard();
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
  let showPoints = $state(false);
  let styleOpen = $state(false);
  const boardWidth = 1600;
  const boardHeight = 1000;

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

  const activeColor = $derived(selected?.color ?? canvasBoard.color);
  const activeWidth = $derived(selected?.width ?? canvasBoard.strokeWidth);

  const TOOL_ICONS: Array<{ id: ToolId; icon: typeof Square; key: string }> = [
    { id: 'select', icon: MousePointer2, key: 'v' },
    { id: 'rect', icon: Square, key: 'r' },
    { id: 'ellipse', icon: Circle, key: 'e' },
    { id: 'arrow', icon: ArrowRight, key: 'a' },
    { id: 'line', icon: Minus, key: 'l' },
    { id: 'freehand', icon: Pencil, key: 'p' },
    { id: 'text', icon: Type, key: 't' },
    { id: 'highlight', icon: Highlighter, key: 'h' },
    { id: 'blur', icon: EyeOff, key: 'b' },
    { id: 'pan', icon: Move, key: '␣' }
  ];
  const byId = (...ids: ToolId[]) => ids.map((id) => TOOL_ICONS.find((tool) => tool.id === id)!);
  const TOOL_GROUPS = [
    byId('select', 'pan'),
    byId('rect', 'ellipse', 'highlight', 'blur'),
    byId('arrow', 'line', 'freehand'),
    byId('text')
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
      await sendCanvasToAgent($t('canvas.prompt'), $t('canvas.promptBoard'), $t('canvas.empty'), $t('canvas.sent'), canvasBoard);
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
  class="canvas-panel"
  class:is-drop={dragOver}
  aria-label={$t('canvas.title')}
  tabindex="-1"
  onkeydown={onKeyDown}
  onpaste={onPaste}
  ondragover={(event) => { event.preventDefault(); dragOver = true; }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
>
  <UiFileInput bind:ref={picker}  accept={IMAGE_ACCEPT} class={uiClass("hidden", "ui-local-ad62cefe")} multiple onchange={onPick} />

  <div class="canvas-stage">
    {#if !image}
      <div class="canvas-empty">
        <div class="canvas-drop" class:is-over={dragOver}>
          <ImagePlus class="canvas-drop-icon" />
          <span class="canvas-drop-text">{$t('canvas.emptyDrop')}</span>
          <div class="canvas-drop-actions">
            <Button variant="outline" size="sm" onclick={newBoard}><Pencil />{$t('canvas.newBoard')}</Button>
            <Button variant="outline" size="sm" onclick={() => picker?.click()}><Upload />{$t('canvas.uploadImage')}</Button>
          </div>
        </div>
      </div>
    {:else if !ready}
      <div class="canvas-empty canvas-loading">{$t('canvas.loading')}</div>
    {:else}
      <CanvasSurface imageId={image.id} {src} />
    {/if}
  </div>

  {#if image}
    <div class="canvas-float canvas-top-left">
      {#if boards.length > 1}
        <div class="canvas-boards" role="tablist" aria-label={$t('canvas.boards')}>
          {#each boards as board (board.id)}
            <Button variant="plain"
              type="button"
              role="tab"
              aria-selected={image.id === board.id}
              class={uiClass("canvas-board-chip", "ui-local-ad62cefe", {"is-on": image.id === board.id})}

              title={board.name}
              onclick={() => canvasBoard.selectImage(board.id)}
            >{board.name}</Button>
          {/each}
        </div>
        <span class="canvas-sep" aria-hidden="true"></span>
      {/if}
      <Tooltip label={$t('canvas.newBoard')} position="bottom"><IconButton label={$t('canvas.newBoard')} size="sm" onclick={newBoard}><Plus /></IconButton></Tooltip>
      <Tooltip label={$t('canvas.attach')} position="bottom"><IconButton label={$t('canvas.attach')} size="sm" onclick={() => picker?.click()}><Upload /></IconButton></Tooltip>
      {#if boards.length > 1}
        <Tooltip label={$t('canvas.removeBoard')} position="bottom"><IconButton label={$t('canvas.removeBoard')} size="sm" onclick={() => canvasBoard.removeImage(image.id)}><X /></IconButton></Tooltip>
      {/if}
    </div>

    <div class="canvas-float canvas-top-right">
      <Tooltip label={$t('canvas.undo')} shortcut="mod+z" position="bottom">
        <IconButton label={$t('canvas.undo')} size="sm" disabled={!canvasBoard.canUndo} onclick={() => canvasBoard.undo()}><RotateCcw /></IconButton>
      </Tooltip>
      <Tooltip label={$t('canvas.redo')} shortcut="mod+shift+z" position="bottom">
        <IconButton label={$t('canvas.redo')} size="sm" disabled={!canvasBoard.canRedo} onclick={() => canvasBoard.redo()}><RotateCw /></IconButton>
      </Tooltip>
      <Tooltip label={$t('canvas.clear')} position="bottom">
        <IconButton label={$t('canvas.clear')} size="sm" onclick={() => canvasBoard.clear()}><Trash2 /></IconButton>
      </Tooltip>
      <span class="canvas-sep" aria-hidden="true"></span>
      <Tooltip label={busy ? (sending ? $t('canvas.sending') : $t('canvas.sendDisabled')) : $t('canvas.sendHint')} position="bottom">
        <Button size="sm" disabled={busy || !ready} onclick={send} aria-label={$t('canvas.send')}><ArrowRight /><span class="canvas-send-label">{$t('canvas.send')}</span></Button>
      </Tooltip>
    </div>

    <div class="canvas-float canvas-dock" role="toolbar" aria-label={$t('canvas.title')}>
      {#each TOOL_GROUPS as group, index (index)}
        {#if index > 0}<span class="canvas-sep" aria-hidden="true"></span>{/if}
        {#each group as tool (tool.id)}
          {@const Icon = tool.icon}
          <Tooltip label={$t(`canvas.tools.${tool.id}`)} shortcut={tool.key === '␣' ? 'space' : tool.key} position="top">
            <IconButton label={$t(`canvas.tools.${tool.id}`)} size="xs" variant="ghost"
              type="button"
              class={uiClass("canvas-tool", "ui-local-ad62cefe", {"is-on": canvasBoard.tool === tool.id})}


              aria-pressed={canvasBoard.tool === tool.id}
              onclick={() => (canvasBoard.tool = tool.id)}
            ><Icon /></IconButton>
          </Tooltip>
        {/each}
      {/each}
      <span class="canvas-sep" aria-hidden="true"></span>
      <Menu bind:open={styleOpen} placement="top-end" minWidth="11rem" label={$t('canvas.style')}>
        {#snippet trigger(props)}
          <Tooltip label={$t('canvas.style')} position="top">
            <Button variant="plain" type="button" class={uiClass("canvas-tool canvas-style", "ui-local-ad62cefe")} {...props} aria-label={$t('canvas.style')}>
              <span class="canvas-dot" style="background: {activeColor}"></span>
              <span class="canvas-line" style="height: {Math.max(1, activeWidth / 2)}px"></span>
            </Button>
          </Tooltip>
        {/snippet}
        <div class="canvas-style-pop">
          <div class="canvas-swatches" role="radiogroup" aria-label={$t('canvas.color')}>
            {#each canvasBoard.colors as tone (tone)}
              <Button variant="plain"
                type="button"
                role="radio"
                aria-checked={activeColor === tone}
                aria-label={tone}
                class={uiClass("canvas-swatch", "ui-local-ad62cefe")}
                style="background: {tone}"
                onclick={() => setStyle(tone, activeWidth)}
              >{#if activeColor === tone}<Check />{/if}</Button>
            {/each}
          </div>
          <div class="canvas-widths" role="radiogroup" aria-label={$t('canvas.stroke')}>
            {#each WIDTHS as width (width)}
              <Button variant="plain"
                type="button"
                role="radio"
                aria-checked={activeWidth === width}
                aria-label={$t('canvas.strokeWidth', { values: { n: String(width) } })}
                class={uiClass("canvas-stroke", "ui-local-ad62cefe", {"is-on": activeWidth === width})}

                onclick={() => setStyle(activeColor, width)}
              ><span style="height: {Math.max(1, width / 2)}px"></span></Button>
            {/each}
          </div>
        </div>
      </Menu>
    </div>

    {#if showPoints}
      <aside class="canvas-float canvas-sheet" aria-label={$t('canvas.pointsList')}>
        <PaneHeader title={$t('canvas.points', { values: { n: String(points.length) } })}>
          {#snippet actions()}<IconButton label={$t('canvas.hidePoints')} size="sm" onclick={() => (showPoints = false)}><ChevronRight /></IconButton>{/snippet}
        </PaneHeader>
        {#if selected}
          <label class="canvas-field">{$t(selected.kind === 'text' ? 'canvas.textContent' : 'canvas.markInstruction')}
            <UiInput class={uiClass("", "ui-local-ad62cefe")} value={selected.text ?? ''} placeholder={$t('canvas.markInstructionHint')} oninput={(event) => canvasBoard.previewMark({ ...selected, text: event.currentTarget.value })} onchange={(event) => { canvasBoard.label(selected.id, event.currentTarget.value); canvasBoard.previewMark(null); }} />
          </label>
        {/if}
        <ul class="canvas-points" aria-label={$t('canvas.pointsList')}>
          {#each points as mark, index (mark.id)}
            {@const owner = canvasBoard.doc.images.find((item) => item.id === mark.imageId) as CanvasImage}
            <li class="canvas-point" class:is-on={canvasBoard.selectedId === mark.id}>
              <Button variant="plain" type="button" class={uiClass("canvas-point-hit", "ui-local-ad62cefe")} aria-label={$t('canvas.selectPoint', { values: { n: String(index + 1) } })} onclick={() => canvasBoard.select(mark.id)}>{numberOf(mark)}</Button>
              <UiInput
                class={uiClass("canvas-point-label", "ui-local-ad62cefe")}
                value={mark.text || ''}
                placeholder={pointName(index)}
                aria-label={pointName(index)}
                onfocus={() => canvasBoard.select(mark.id)}
                onchange={(event) => canvasBoard.label(mark.id, (event.currentTarget as HTMLInputElement).value)}
              />
              <span class="canvas-point-where">{where(mark, owner)}</span>
              <IconButton label={$t('canvas.removePoint')} size="sm" onclick={() => canvasBoard.remove(mark.id)}><X /></IconButton>
            </li>
          {/each}
        </ul>
        <UiTextarea class={uiClass("canvas-instructions ", "ui-local-ad62cefe")} rows={2} aria-label={$t('canvas.instructions')} placeholder={$t('canvas.instructionsHint')} value={canvasBoard.doc.instructions ?? ''} oninput={(event) => canvasBoard.setInstructions(event.currentTarget.value)} onblur={() => canvasBoard.save()}></UiTextarea>
      </aside>
    {:else}
      <Button variant="plain" type="button" class={uiClass("canvas-float canvas-chip", "ui-local-ad62cefe")} aria-expanded="false" onclick={() => (showPoints = true)}>
        <ChevronLeft />{$t('canvas.points', { values: { n: String(points.length) } })}
      </Button>
    {/if}
  {/if}
</section>

<style>
  .canvas-panel { container-type: size; position: relative; display: flex; min-height: 0; min-width: 0; flex: 1; background: var(--card); outline: none; }
  .canvas-panel.is-drop { box-shadow: inset 0 0 0 2px var(--ring); }
  .canvas-stage { position: absolute; inset: 0; min-height: 0; }
  .canvas-empty { display: flex; height: 100%; align-items: center; justify-content: center; padding: 1.5rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .canvas-drop { display: flex; max-width: 28rem; flex-direction: column; align-items: center; gap: 0.75rem; padding: 2rem 1.5rem; text-align: center; border: 1px dashed var(--border-hover); border-radius: var(--float-radius); transition: background var(--motion-fast) var(--motion-ease-out), border-color var(--motion-fast) var(--motion-ease-out); }
  .canvas-drop.is-over { background: var(--float-row-hover); border-color: var(--ring); }
  .canvas-drop :global(.canvas-drop-icon) { width: 1.75rem; height: 1.75rem; color: var(--muted-foreground); }
  .canvas-drop-text { font-size: var(--text-sm); color: var(--foreground); }
  .canvas-drop-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; }

  :is(.canvas-float, :global(.canvas-float.ui-local-ad62cefe)) { position: absolute; z-index: 2; display: flex; align-items: center; gap: 0.125rem; padding: var(--float-pad); background: var(--float-bg); border: 1px solid var(--float-border); border-radius: var(--float-radius); box-shadow: var(--float-shadow); }
  .canvas-top-left { top: 0.625rem; left: 0.625rem; max-width: calc(100% - 17rem); }
  .canvas-top-right { top: 0.625rem; right: 0.625rem; }
  /* One row always; a narrow panel scrolls the dock sideways rather than stacking it. */
  .canvas-dock { bottom: 0.75rem; left: 50%; transform: translateX(-50%); max-width: calc(100% - 1.25rem); flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .canvas-dock::-webkit-scrollbar { display: none; }
  /* Narrow panels: "Send" keeps its icon, the top groups shrink, and the points
     chip rises above the dock instead of sitting under it. */
  @container (max-width: 34rem) {
    .canvas-send-label { display: none; }
    .canvas-top-left { max-width: calc(100% - 12rem); }
    :global(.canvas-chip.ui-local-ad62cefe) { bottom: 3.75rem; }
  }
  .canvas-sep { width: 1px; height: 1.125rem; margin: 0 0.25rem; flex-shrink: 0; background: var(--float-border); }

  :global(.canvas-tool.ui-local-ad62cefe) { display: inline-flex; width: 1.75rem; height: 1.75rem; flex-shrink: 0; align-items: center; justify-content: center; gap: 0.125rem; border-radius: var(--float-row-radius); color: var(--muted-foreground); transition: background var(--motion-fast) var(--motion-ease-out), color var(--motion-fast) var(--motion-ease-out); }
  :global(.canvas-tool.ui-local-ad62cefe) :global(svg) { width: 1rem; height: 1rem; }
  :global(.canvas-tool:hover.ui-local-ad62cefe) { background: var(--float-row-hover); color: var(--foreground); }
  :global(.canvas-tool.is-on.ui-local-ad62cefe) { background: var(--nav-current-bg); box-shadow: var(--nav-current-ring); color: var(--foreground); }
  :global(.canvas-style.ui-local-ad62cefe) { width: auto; padding: 0 0.375rem; }
  .canvas-dot { width: 0.875rem; height: 0.875rem; border-radius: var(--radius-full); box-shadow: inset 0 0 0 1px var(--float-border); }
  .canvas-line { display: block; width: 0.5rem; border-radius: var(--radius-full); background: var(--foreground); }

  .canvas-style-pop { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.25rem; }
  .canvas-swatches { display: grid; grid-template-columns: repeat(4, 1.5rem); gap: 0.375rem; }
  :global(.canvas-swatch.ui-local-ad62cefe) { display: inline-flex; width: 1.5rem; height: 1.5rem; align-items: center; justify-content: center; border-radius: var(--radius-full); box-shadow: inset 0 0 0 1px var(--float-border); color: white; transition: transform var(--motion-fast) var(--motion-ease-out); }
  :global(.canvas-swatch.ui-local-ad62cefe) :global(svg) { width: 0.875rem; height: 0.875rem; filter: drop-shadow(0 0 1px rgb(0 0 0 / 0.6)); }
  :global(.canvas-swatch:hover.ui-local-ad62cefe) { transform: scale(1.1); }
  .canvas-widths { display: flex; gap: 0.25rem; }
  :global(.canvas-stroke.ui-local-ad62cefe) { display: inline-flex; flex: 1; height: 1.75rem; align-items: center; justify-content: center; border-radius: var(--float-row-radius); }
  :global(.canvas-stroke.ui-local-ad62cefe) span { display: block; width: 1.25rem; border-radius: var(--radius-full); background: var(--muted-foreground); }
  :global(.canvas-stroke:hover.ui-local-ad62cefe) { background: var(--float-row-hover); }
  :global(.canvas-stroke.is-on.ui-local-ad62cefe) { background: var(--nav-current-bg); box-shadow: var(--nav-current-ring); }
  :global(.canvas-stroke.is-on.ui-local-ad62cefe) span { background: var(--foreground); }

  .canvas-boards { display: flex; min-width: 0; gap: 0.25rem; overflow-x: auto; }
  :global(.canvas-board-chip.ui-local-ad62cefe) { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.125rem 0.5rem; border-radius: var(--float-row-radius); font-size: var(--text-xs); color: var(--muted-foreground); }
  :global(.canvas-board-chip:hover.ui-local-ad62cefe) { background: var(--float-row-hover); color: var(--foreground); }
  :global(.canvas-board-chip.is-on.ui-local-ad62cefe) { background: var(--nav-current-bg); box-shadow: var(--nav-current-ring); color: var(--foreground); }

  :global(.canvas-chip.ui-local-ad62cefe) { right: 0.625rem; bottom: 0.75rem; gap: 0.25rem; padding: 0.25rem 0.625rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  :global(.canvas-chip:hover.ui-local-ad62cefe) { background: var(--float-row-hover); color: var(--foreground); }
  :global(.canvas-chip.ui-local-ad62cefe) :global(svg) { width: 0.875rem; height: 0.875rem; }
  .canvas-sheet { top: 3.75rem; right: 0.625rem; bottom: 0.75rem; width: min(17rem, 40%); flex-direction: column; align-items: stretch; gap: 0.5rem; overflow-y: auto; padding: 0.5rem; }
  @media (max-height: 30rem) { .canvas-sheet { top: 3.75rem; bottom: 3.5rem; } }
  .canvas-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .canvas-points { display: flex; min-height: 0; flex-direction: column; gap: 0.0625rem; }
  .canvas-point { display: flex; align-items: center; gap: 0.375rem; padding: 0.125rem 0.25rem; border-radius: var(--float-row-radius); }
  .canvas-point:hover { background: var(--float-row-hover); }
  :is(.canvas-point.is-on, :global(.canvas-point.is-on.ui-local-ad62cefe)) { background: var(--float-row-selected); }
  :global(.canvas-point-hit.ui-local-ad62cefe) { display: inline-flex; width: 1.25rem; height: 1.25rem; flex-shrink: 0; align-items: center; justify-content: center; border-radius: var(--radius-full); background: var(--muted); font-size: var(--text-xs); font-weight: 700; }
  :global(.canvas-point-label.ui-local-ad62cefe) { min-width: 0; flex: 1; background: transparent; font-size: var(--text-xs); outline: none; }
  .canvas-point-where { flex-shrink: 0; font-size: var(--text-xs); color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  :global(.canvas-instructions.ui-local-ad62cefe) { flex-shrink: 0; resize: vertical; max-height: 8rem; font-size: var(--text-xs); }

  @media (prefers-reduced-motion: reduce) {
    :global(.canvas-tool.ui-local-ad62cefe), :global(.canvas-swatch.ui-local-ad62cefe), .canvas-drop { transition: none; }
    :global(.canvas-swatch:hover.ui-local-ad62cefe) { transform: none; }
  }
</style>
