<svelte:options runes={true} />

<!--
  The live preview: the selected page inlined by the same builder the agent's
  preview tool uses (what you see is what it sees), in a sandboxed frame with
  an opaque origin. The page can run its own scripts but cannot reach the
  app, the network or the workspace folder. The picker script rides in the
  frame (never in the agent's render) and reports picks, comments and text
  edits back over postMessage.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { copy } from '$lib/copy';
  import { reducedMotion } from '$lib/utils/motion.svelte';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { designStore } from './design.svelte';
  import { frameGeometry, nextZoomPreset, PIN_GAP, PIN_SIZE, pinOrigin } from './design-view';
  import { HOST_SOURCE, readFrameMessage, withPicker, type FrameMessage } from './design-picker';
  import DesignEmpty from './DesignEmpty.svelte';

  /** A comment being written: where it was clicked, in page and stage coordinates. */
  interface Draft { x: number; y: number; selector: string; left: number; top: number }

  let stage = $state<HTMLDivElement>();
  let frameBox = $state<HTMLDivElement>();
  let frame = $state<HTMLIFrameElement>();
  let paneWidth = $state(0);
  let paneHeight = $state(0);
  let scroll = $state({ x: 0, y: 0 });
  let draft = $state<Draft | null>(null);
  let draftNote = $state('');

  const geometry = $derived(frameGeometry(designStore.viewport, { width: paneWidth, height: paneHeight }, designStore.zoom));
  const html = $derived.by(() => {
    const { files } = designStore.data;
    const source = files[designStore.selected];
    if (source === undefined) return '';
    try { return buildPreviewHtml(source, files, designStore.selected, true).html; } catch { return ''; }
  });
  const srcdoc = $derived(html ? withPicker(html) : '');
  /** The frame's size on screen, the box pins are kept inside. */
  const frameSize = $derived({ width: geometry.width * geometry.scale, height: geometry.height * geometry.scale });
  const highlights = $derived(designStore.selection.filter((pick) => pick.page === designStore.selected).map((pick) => pick.selector));
  const pins = $derived(designStore.comments.filter((comment) => comment.page === designStore.selected));

  function post(message: Record<string, unknown>) {
    frame?.contentWindow?.postMessage({ source: HOST_SOURCE, ...message }, '*');
  }

  /** A freshly loaded frame starts at the top, browsing, with the current selection outlined; the timeline re-reads it. */
  function syncFrame() {
    scroll = { x: 0, y: 0 };
    post({ type: 'tool', tool: designStore.tool });
    post({ type: 'highlight', selectors: highlights });
    if (designStore.tray === 'timeline') designStore.sendAnim({ action: 'open' });
  }

  $effect(() => {
    const tool = designStore.tool;
    untrack(() => { if (tool !== 'comment') draft = null; });
    post({ type: 'tool', tool });
  });
  $effect(() => { post({ type: 'highlight', selectors: highlights }); });
  // The timeline's commands reach the page through this frame; they stop when the canvas unmounts.
  $effect(() => {
    designStore.bindFrame((command) => post({ type: 'anim', ...command }));
    return () => designStore.bindFrame(null);
  });

  /** The note field opens beside the pin it will become, vertically centred on it. */
  function openDraft(message: Extract<FrameMessage, { type: 'comment' }>) {
    if (!frameBox) return;
    const at = pinOrigin(message, scroll, geometry.scale, frameSize);
    draft = {
      x: message.x,
      y: message.y,
      selector: message.selector,
      left: frameBox.offsetLeft + at.left + PIN_SIZE + PIN_GAP,
      top: frameBox.offsetTop + at.top + PIN_SIZE / 2
    };
    draftNote = '';
  }

  function saveDraft() {
    if (!draft) return;
    const note = draftNote.trim();
    if (note) designStore.addComment({ page: designStore.selected, selector: draft.selector, x: draft.x, y: draft.y, note });
    draft = null;
    draftNote = '';
  }

  function cancelDraft() {
    draft = null;
    draftNote = '';
  }

  function onMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;
    const message = readFrameMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'select':
        designStore.addSelection(message.element, message.additive);
        break;
      case 'comment':
        openDraft(message);
        break;
      case 'textEdit':
        void designStore.applyTextEdit({ page: designStore.selected, selector: message.selector, oldText: message.oldText, newText: message.newText, x: message.x, y: message.y });
        break;
      case 'escape':
        designStore.setTool('browse');
        break;
      case 'scroll':
        scroll = { x: message.x, y: message.y };
        break;
      case 'animations':
        designStore.setMotionItems(message.items, message.reduced);
        break;
      case 'animTick':
        designStore.setPlayhead(message.time, message.playing, message.count);
        break;
      case 'wheel':
        designStore.zoomBy(-message.deltaY * 0.001, geometry.scale);
        break;
      case 'hover':
        break;
    }
  }

  function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  }

  /** Ctrl/⌘ +, −, 0 zoom the page; Escape leaves a pick or comment mode. */
  function onKeydown(event: KeyboardEvent) {
    if (isEditable(event.target)) return;
    if (event.key === 'Escape' && designStore.tool !== 'browse') {
      designStore.setTool('browse');
      draft = null;
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const current = designStore.zoom ?? geometry.scale;
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      designStore.setZoom(nextZoomPreset(current, 1));
    } else if (event.key === '-') {
      event.preventDefault();
      designStore.setZoom(nextZoomPreset(current, -1));
    } else if (event.key === '0') {
      event.preventDefault();
      designStore.setZoom(null);
    }
  }

  /** Trackpad pinch and Ctrl+wheel over the desk (the frame forwards its own). */
  function onStageWheel(event: WheelEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    designStore.zoomBy(-event.deltaY * 0.001, geometry.scale);
  }

  // A non-passive listener, so the page does not scroll or pinch-zoom under a canvas zoom.
  $effect(() => {
    const el = stage;
    if (!el) return;
    el.addEventListener('wheel', onStageWheel, { passive: false });
    return () => el.removeEventListener('wheel', onStageWheel);
  });

</script>

<svelte:window onmessage={onMessage} onkeydown={onKeydown} />

<div class="stage" bind:this={stage} bind:clientWidth={paneWidth} bind:clientHeight={paneHeight}>
  {#if html}
    <div
      class="frame"
      class:animated={!reducedMotion.value && !designStore.resizing}
      class:pick={designStore.tool !== 'browse'}
      bind:this={frameBox}
      style:width="{geometry.width * geometry.scale}px"
      style:height="{geometry.height * geometry.scale}px"
    >
      {#key designStore.reloadKey}
        <iframe
          bind:this={frame}
          {srcdoc}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          title={copy.design.canvas.previewLabel}
          onload={syncFrame}
          style:width="{geometry.width}px"
          style:height="{geometry.height}px"
          style:transform="scale({geometry.scale})"
          style:color-scheme={designStore.scheme === 'auto' ? undefined : designStore.scheme}
        ></iframe>
      {/key}
      {#each pins as pin, index (pin.id)}
        {@const at = pinOrigin(pin, scroll, geometry.scale, frameSize)}
        <span class="pin" title={pin.note} style:left="{at.left}px" style:top="{at.top}px">{index + 1}</span>
      {/each}
    </div>
  {:else if !designStore.loading}
    <DesignEmpty />
  {/if}

  {#if draft}
    <div class="draft ui-float" style:left="{draft.left}px" style:top="{draft.top}px">
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
    /* Scrolls when a zoomed page is larger than the pane; auto margins keep a smaller page centred. */
    overflow: auto;
    padding: 1.5rem;
    /* A tinted desk under the page, so the frame reads as an object without a border. */
    background-color: color-mix(in srgb, var(--foreground) 4%, var(--background));
    background-image: radial-gradient(color-mix(in srgb, var(--foreground) 10%, transparent) 1px, transparent 1px);
    background-size: 16px 16px;
  }

  .frame {
    position: relative;
    flex-shrink: 0;
    margin: auto;
    overflow: hidden;
    border-radius: 0.625rem;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 28px rgb(0 0 0 / 0.1);
  }

  .frame.pick {
    cursor: crosshair;
  }

  .frame.animated {
    transition: width 220ms var(--motion-ease-out), height 220ms var(--motion-ease-out);
  }

  iframe {
    position: absolute;
    inset: 0 auto auto 0;
    border: 0;
    background: #fff;
    transform-origin: top left;
  }

  .pin {
    position: absolute;
    z-index: 1;
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
    pointer-events: none;
  }

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
