// Browser-style Back / Forward for the window: every place you land — a space,
// a conversation, a library screen, Settings — is one entry; going somewhere new
// drops whatever was ahead of you, exactly like a browser tab's history. Pure, so
// the rules are tested without Svelte; `stores/nav-history.svelte.ts` holds the
// live copy and applies entries to the app.

import type { ChatContextMode } from '$lib/types/chat';

export type NavView = 'chat' | 'artifacts' | 'files' | 'calendar' | 'complements';

export interface NavLocation {
  space: ChatContextMode;
  chatId: string | null;
  view: NavView;
  /** The artifact open full-screen on the Artifacts view, if any. */
  artifactKey: string | null;
  settings: boolean;
}

export interface NavState {
  entries: NavLocation[];
  index: number;
}

/** Enough to cover a long session without growing forever. */
export const NAV_LIMIT = 100;

export const EMPTY_NAV: NavState = { entries: [], index: -1 };

export function sameLocation(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
  if (!a || !b) return false;
  return a.space === b.space && a.chatId === b.chatId && a.view === b.view && a.artifactKey === b.artifactKey && a.settings === b.settings;
}

/** Going somewhere new: forward history is dropped, the oldest entries fall off past the limit. */
export function visit(state: NavState, location: NavLocation, limit = NAV_LIMIT): NavState {
  if (sameLocation(state.entries[state.index], location)) return state;
  const entries = [...state.entries.slice(0, state.index + 1), location];
  const overflow = Math.max(0, entries.length - limit);
  return { entries: entries.slice(overflow), index: entries.length - 1 - overflow };
}

/**
 * Where a Back/Forward actually landed. Restoring can come out a little
 * different — the conversation was deleted, so the space opened another — and
 * then the entry is corrected in place instead of growing the history.
 */
export function settle(state: NavState, location: NavLocation): NavState {
  if (state.index < 0 || sameLocation(state.entries[state.index], location)) return state;
  const entries = [...state.entries];
  entries[state.index] = location;
  return { entries, index: state.index };
}

export function canStep(state: NavState, delta: -1 | 1): boolean {
  const next = state.index + delta;
  return next >= 0 && next < state.entries.length;
}

export function step(state: NavState, delta: -1 | 1): NavState {
  return canStep(state, delta) ? { entries: state.entries, index: state.index + delta } : state;
}
