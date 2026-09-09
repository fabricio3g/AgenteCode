import { normalizeSpace, type SpaceId } from '$lib/spaces';
import type { ChatSession } from '$lib/types/chat';

/**
 * Session space guards.
 *
 * Boundary module: only place allowed to branch on
 * home vs code besides AppShell/Sidebar space switch.
 * All other modules use these guards instead of
 * inline `contextMode === 'code'` checks.
 */
export function getSpaceForSession(chat: Pick<ChatSession, 'contextMode' | 'workspace'> | null | undefined): SpaceId {
  if (!chat) return 'home';
  if (chat.workspace) return 'code';
  return normalizeSpace(chat.contextMode);
}

export function isCodeSession(chat: Pick<ChatSession, 'contextMode' | 'workspace'> | null | undefined): boolean {
  return getSpaceForSession(chat) === 'code';
}

export function isHomeSession(chat: Pick<ChatSession, 'contextMode' | 'workspace'> | null | undefined): boolean {
  return !isCodeSession(chat);
}
