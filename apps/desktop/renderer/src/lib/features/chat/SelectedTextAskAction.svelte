<svelte:options runes={true} />

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onDestroy, onMount } from 'svelte';
  import { Quote } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import Portal from '$lib/components/ui/Portal.svelte';

  const MAX_SELECTION_CHARS = 6000;
  const BUTTON_HEIGHT = 30;
  const GAP = 8;
  /** Keep clear of the titlebar. */
  const TOP_MARGIN = 56;

  let visible = $state(false);
  let selectedText = $state('');
  let x = $state(0);
  let y = $state(0);
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerSelecting = false;
  let placement = $state<'above' | 'below'>('above');

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

    // Centered above the selection's first line, like a text toolbar, so it
    // never covers the text that follows; below the last line when the top
    // is too close to the window edge.
    const lines = range.getClientRects();
    const first = lines.length ? lines[0] : selRect;
    const last = lines.length ? lines[lines.length - 1] : selRect;
    const center = lines.length === 1 ? first.left + first.width / 2 : selRect.left + selRect.width / 2;
    selectedText = text.slice(0, MAX_SELECTION_CHARS);
    x = Math.min(Math.max(center, 80), window.innerWidth - 80);
    const above = first.top - BUTTON_HEIGHT - GAP;
    placement = above > TOP_MARGIN ? 'above' : 'below';
    y = placement === 'above' ? above : Math.min(last.bottom + GAP, window.innerHeight - BUTTON_HEIGHT - 8);
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
  <!-- Portaled: the thread wrapper's `contain: layout` would otherwise make
       fixed coordinates relative to it, offsetting the pill by the sidebar. -->
  <Portal>
  <UiButton variant="plain"
    type="button"
    class={uiClass("selected-text-ask-action", "ui-local-60c0608c", {"below": placement === 'below'})}

    style={`left:${x}px; top:${y}px;`}
    onclick={askSelectedText}
    aria-label={$t('chat.selection.addLabel')}
  >
    <Quote class="size-3.5" />
    <span>{$t('chat.selection.add')}</span>
  </UiButton>
  </Portal>
{/if}

<style>
  /* A small pill that floats over the text, centered on the selection. */
  :global(.selected-text-ask-action.ui-local-60c0608c) {
    position: fixed;
    z-index: 80;
    display: inline-flex;
    height: 30px;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.75rem 0 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--popover, var(--background));
    color: var(--foreground);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 6px 16px -4px rgb(0 0 0 / 0.14);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
    transform: translateX(-50%);
    animation: selectedAskIn 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  :global(.selected-text-ask-action.ui-local-60c0608c) :global(svg) {
    color: var(--muted-foreground);
  }

  :global(.selected-text-ask-action:hover.ui-local-60c0608c) {
    background: color-mix(in srgb, var(--foreground) 5%, var(--popover, var(--background)));
  }

  @keyframes selectedAskIn {
    from { opacity: 0; transform: translate(-50%, 3px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  :global(.selected-text-ask-action.below.ui-local-60c0608c) {
    animation-name: selectedAskInBelow;
  }

  @keyframes selectedAskInBelow {
    from { opacity: 0; transform: translate(-50%, -3px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.selected-text-ask-action.ui-local-60c0608c) { animation: none; }
  }
</style>
