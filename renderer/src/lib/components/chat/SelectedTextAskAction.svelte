<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { MessageCircleQuestion } from 'lucide-svelte';
  import { APP_NAME } from '$lib/app-meta';

  const MAX_SELECTION_CHARS = 6000;

  let visible = $state(false);
  let selectedText = $state('');
  let x = $state(0);
  let y = $state(0);
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerSelecting = false;

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

  function rectFromRange(range: Range): DOMRect | null {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  }

  function getSelectionFocusRect(selection: Selection): DOMRect | null {
    const focusNode = selection.focusNode;
    if (!focusNode) return null;

    const collapsedRange = document.createRange();
    try {
      collapsedRange.setStart(focusNode, selection.focusOffset);
      collapsedRange.collapse(true);
      const collapsedRect = rectFromRange(collapsedRange);
      if (collapsedRect) return collapsedRect;
    } catch {
      // Fall back to nearby character/element ranges below.
    } finally {
      collapsedRange.detach();
    }

    if (focusNode.nodeType === Node.TEXT_NODE) {
      const textLength = focusNode.textContent?.length || 0;
      const offset = Math.max(0, Math.min(selection.focusOffset, textLength));
      const charRange = document.createRange();
      try {
        if (offset > 0) {
          charRange.setStart(focusNode, offset - 1);
          charRange.setEnd(focusNode, offset);
        } else if (textLength > 0) {
          charRange.setStart(focusNode, 0);
          charRange.setEnd(focusNode, 1);
        } else {
          return null;
        }
        return rectFromRange(charRange);
      } catch {
        return null;
      } finally {
        charRange.detach();
      }
    }

    const element = focusNode instanceof Element ? focusNode : focusNode.parentElement;
    return element?.getBoundingClientRect() || null;
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
    const focusRect = getSelectionFocusRect(selection);
    const fallbackRect = rectFromRange(range);
    const targetRect = focusRect || fallbackRect;
    if (!targetRect) {
      hide();
      return;
    }

    selectedText = text.slice(0, MAX_SELECTION_CHARS);
    x = Math.min(Math.max(targetRect.right, 72), window.innerWidth - 72);
    y = Math.max(targetRect.top - 42, 12);
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

  function handlePointerUp() {
    if (!pointerSelecting) return;
    pointerSelecting = false;
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
    aria-label={`Ask ${APP_NAME} about selected text`}
  >
    <MessageCircleQuestion class="h-4 w-4" />
    <span>Ask {APP_NAME}</span>
  </button>
{/if}

<style>
  .selected-text-ask-action {
    position: fixed;
    z-index: 80;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    gap: 0.45rem;
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    background: color-mix(in srgb, var(--surface) 94%, var(--chat-bg));
    color: var(--text);
    box-shadow: var(--shadow-md);
    padding: 0.58rem 0.95rem;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    backdrop-filter: blur(12px);
    animation: selectedAskIn 110ms ease-out;
  }

  .selected-text-ask-action:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
  }

  @keyframes selectedAskIn {
    from { opacity: 0; transform: translateX(-50%) translateY(3px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
