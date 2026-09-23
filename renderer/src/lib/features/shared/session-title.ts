import { copy } from '$lib/copy';
import { isDefaultChatTitle, normalizeContextMode } from '$lib/stores/app-store-helpers';
import type { ChatSession } from '$lib/types/chat';

/**
 * The title to show for a conversation. Placeholder titles are stored as
 * English sentinels ("New chat", "New session") because the store detects
 * them to auto-title from the first message; they are shown in the UI
 * language instead.
 */
export function displayChatTitle(chat: Pick<ChatSession, 'title' | 'contextMode'>): string {
  if (chat.title && !isDefaultChatTitle(chat.title)) return chat.title;
  return copy.untitled[normalizeContextMode(chat.contextMode)];
}
