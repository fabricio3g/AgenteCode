<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Quote } from 'lucide-svelte';

  const MAX_SELECTION_CHARS = 6000;

  let visible = $state(false);
  let selectedText = $state('');
  let x = $state(0);
  let y = $state(0);
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerSelecting = false;
  /** Last pointerup inside message content: exact release point. */
  let lastPointer = $state<{ x: number; y: number; at: number } | null>(null);

  function isEditableElement(node: Node | null): boolean {
    const element = node instanceof Element ? node : node?.parentElement;
    return !!element?.closest('input, textarea, select, [contenteditable="true"]');
  }

  function hide() {
    visible = false;
    selectedText = '';
  }

  function scheduleUpdate(delay = 120) {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(updateFromSelection, delay);
  }

  function updateFromSelection() {
    updateTimer = null;
    if (pointerSelecting) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hide();
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (isEditableElement(anchorNode) || isEditableElement(focusNode)) {
      hide();
      return;
    }

    const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const anchorMessage = anchorElement?.closest('[data-chat-message-content]');
    const focusMessage = focusElement?.closest('[data-chat-message-content]');
    if (!anchorMessage || !focusMessage || anchorMessage !== focusMessage) {
      hide();
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      hide();
      return;
    }

    const range = selection.getRangeAt(0);
    // Streaming re-renders replace text nodes mid-selection. A detached
    // range reports garbage rects, so hide instead of floating mid-air.
    if (!range.commonAncestorContainer.isConnected) {
      hide();
      return;
    }
    const selRect = range.getBoundingClientRect();
    if (!selRect || (!selRect.width && !selRect.height)) {
      hide();
      return;
    }

    // Mouse users: the release point IS the selection end. Immune to
    // caret-rect quirks, which only serve keyboard selections below.
    const pointer = lastPointer;
    if (pointer && Date.now() - pointer.at < 500) {
      selectedText = text.slice(0, MAX_SELECTION_CHARS);
      x = Math.min(Math.max(pointer.x + 4, 8), window.innerWidth - 150);
      const belowY = pointer.y + 6;
      const aboveY = pointer.y - 38;
      y = Math.min(
        Math.max(belowY + 34 < window.innerHeight ? belowY : Math.max(aboveY, 8), 8),
        window.innerHeight - 40
      );
      visible = true;
      return;
    }

    // Anchor to the end of the selection (the focus character).
    // Order: exact caret rect at focus, directional line rect, bbox corner.
    // The final clamp keeps the button inside the selection's own box, so
    // a bad rect can never fling it across the window.
    const lineRects = range.getClientRects();
    let backward = false;
    try {
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (anchorNode && focusNode) {
        if (anchorNode === focusNode) {
          backward = selection.anchorOffset > selection.focusOffset;
        } else {
          backward = Boolean(
            anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING
          );
        }
      }
    } catch { /* assume forward */ }

    let caretX: number | null = null;
    let caretY: number | null = null;
    try {
      const caret = range.cloneRange();
      caret.collapse(!backward);
      const caretRects = caret.getClientRects();
      const caretRect = caretRects.length ? caretRects[0] : null;
      if (caretRect && (caretRect.width || caretRect.height)) {
        caretX = backward ? caretRect.left : caretRect.right;
        caretY = caretRect.bottom;
      }
    } catch { /* fall through to line rects */ }

    let endRect: DOMRect | null = null;
    if (lineRects.length) {
      endRect = backward ? lineRects[0] : lineRects[lineRects.length - 1];
    }
    const focusX = caretX ?? (endRect ? (backward ? endRect.left : endRect.right) : selRect.right);
    const focusY = caretY ?? (endRect ? endRect.bottom : selRect.bottom);

    selectedText = text.slice(0, MAX_SELECTION_CHARS);
    x = Math.min(Math.max(focusX + 4, 8), selRect.right + 4, window.innerWidth - 150);
    const belowY = focusY + 6;
    const aboveY = focusY - 38;
    y = Math.min(
      Math.max(belowY + 34 < window.innerHeight ? belowY : Math.max(aboveY, 8), 8),
      window.innerHeight - 40
    );
    visible = true;
  }

  function askSelectedText() {
    if (!selectedText.trim()) return;
    const selection = window.getSelection();
    const anchorElement = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const sourceMessageId = anchorElement?.closest('[data-chat-message-id]')?.getAttribute('data-chat-message-id') || '';
    window.dispatchEvent(new CustomEvent('ask-selected-text', { detail: { text: selectedText, sourceMessageId } }));
    window.getSelection()?.removeAllRanges();
    hide();
  }

  function handleSelectionChange() {
    scheduleUpdate();
  }

  function handleKeyUp() {
    scheduleUpdate();
  }

  function handlePointerDown(event: PointerEvent) {
    const target = event.target as Element | null;
    if (target?.closest('.selected-text-ask-action')) return;
    if (target?.closest('[data-chat-message-content]')) {
      pointerSelecting = true;
      hide();
      return;
    }
    hide();
  }

  function handlePointerUp(event?: MouseEvent) {
    if (!pointerSelecting) return;
    pointerSelecting = false;
    if (event && typeof event.clientX === 'number') {
      lastPointer = { x: event.clientX, y: event.clientY, at: Date.now() };
    }
    scheduleUpdate(160);
  }

  function handleScroll() {
    hide();
  }

  onMount(() => {
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handlePointerUp);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', handlePointerUp);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('scroll', handleScroll, true);
      if (updateTimer) clearTimeout(updateTimer);
    };
  });

  onDestroy(() => {
    if (updateTimer) clearTimeout(updateTimer);
  });
</script>

{#if visible}
  <button
    type="button"
    class="selected-text-ask-action"
    style={`left:${x}px; top:${y}px;`}
    onclick={askSelectedText}
    aria-label="Add selected text to chat"
  >
    <Quote class="size-3.5" />
    <span>Add to chat</span>
  </button>
{/if}

<style>
  .selected-text-ask-action {
    position: fixed;
    z-index: 80;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    gap: 0.35rem;
    border: 1px solid var(--border);
    background: var(--popover);
    opacity: 1;
    color: var(--foreground);
    box-shadow: var(--shadow-sm);
    padding: 0.4rem 0.7rem;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    animation: selectedAskIn 110ms ease-out;
  }

  .selected-text-ask-action:hover {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: color-mix(in srgb, var(--foreground) 8%, var(--background));
    opacity: 1;
    color: var(--foreground);
  }

  @keyframes selectedAskIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
