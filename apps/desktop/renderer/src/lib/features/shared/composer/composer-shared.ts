import type { Snippet } from 'svelte';
import type { QueuedPrompt } from '$lib/types/chat';
import type { PendingApproval } from '$lib/stores/approvals.svelte';

/**
 * Shared composer keyboard & slot primitives used by both `CodeComposer.svelte`
 * and `Composer.svelte` so slash-command navigation, approval interception,
 * queue recall, and dictation corner-slot behaviour stay identical across spaces.
 */

export function handleApprovalKey(
  event: KeyboardEvent,
  options: {
    approval: PendingApproval | undefined;
    isEmpty: boolean;
    resolve: (id: string, allow: boolean) => void;
  }
): boolean {
  const { approval, isEmpty, resolve } = options;
  if (!approval || event.isComposing) return false;
  const isDeny = event.key === 'Escape';
  const isAllow = event.key === 'Enter' && !event.shiftKey && isEmpty;
  if (!isDeny && !isAllow) return false;
  event.preventDefault();
  event.stopPropagation();
  resolve(approval.id, isAllow);
  return true;
}

export function handlePickerKey(
  event: KeyboardEvent,
  options: {
    open: boolean;
    count: number;
    index: number;
    onIndex: (next: number) => void;
    onSelect: (index: number) => void;
    onComplete?: (index: number) => void;
    onDismiss: () => void;
  }
): boolean {
  if (!options.open || options.count <= 0) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    options.onIndex((options.index + delta + options.count) % options.count);
    return true;
  }
  if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    if (options.onComplete) options.onComplete(options.index);
    else options.onSelect(options.index);
    return true;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    options.onSelect(options.index);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    options.onDismiss();
    return true;
  }
  return false;
}

export function recallLastQueuedPrompt(
  event: KeyboardEvent,
  options: {
    isEmpty: boolean;
    prompts: readonly QueuedPrompt[] | undefined;
    onRecall: (item: QueuedPrompt) => void;
  }
): boolean {
  if (event.key !== 'ArrowUp' || !options.isEmpty || event.isComposing) return false;
  const list = options.prompts ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item && !item.sending) {
      event.preventDefault();
      options.onRecall(item);
      return true;
    }
  }
  return false;
}

export function dictationSlotFor(options: {
  running: boolean;
  fieldEmpty: boolean;
  supported: boolean;
  listening: boolean;
  hidden?: boolean;
  label: string;
  onToggle: () => void;
  glyph: Snippet;
}): { label: string; onclick: () => void; glyph?: Snippet } | undefined {
  if (options.running || !options.fieldEmpty || !options.supported || options.hidden) return undefined;
  return {
    label: options.label,
    onclick: options.onToggle,
    glyph: options.listening ? options.glyph : undefined
  };
}
