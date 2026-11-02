import type { ChatMessage } from '$lib/types/chat';

export interface ConversationDialEntry {
  index: number;
  distance: number;
  position: number;
}

/** Keep at least 18px between 12px tick targets, even in a short dock. */
export function conversationDialRadius(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 4;
  const intervals = Math.floor(height * 0.76 / 18);
  return Math.max(0, Math.min(4, Math.floor(intervals / 2)));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function conversationDialWindow(
  totalMessages: number,
  selectedIndex: number,
  radius = 4
): ConversationDialEntry[] {
  if (totalMessages <= 0) return [];
  const selected = clamp(Math.round(selectedIndex), 0, totalMessages - 1);
  const start = Math.max(0, selected - radius);
  const end = Math.min(totalMessages - 1, selected + radius);
  const count = end - start + 1;
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const position = count === 1 ? 50 : 12 + (offset / (count - 1)) * 76;
    return { index, distance: index - selected, position };
  });
}

export function conversationTimelinePreview(message: ChatMessage, maximumLength = 180): string {
  const activeVersionIndex =
    typeof message.activeVersion === 'number'
      ? clamp(message.activeVersion, 0, Math.max(0, (message.versions?.length || 1) - 1))
      : 0;
  const source = message.versions?.[activeVersionIndex]?.content || message.content || message.reasoning || '';
  const plainText = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```(?:\w+)?/g, ' ')
    .replace(/[`#>*_~|]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Empty means "nothing to quote"; the dial shows its own translated label.
  if (!plainText) return message.attachments?.[0]?.name || '';
  if (plainText.length <= maximumLength) return plainText;
  return `${plainText.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}
