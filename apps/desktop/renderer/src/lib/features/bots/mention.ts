// `@teammate` in a bot's message box: find the mention being typed at the
// caret, list the bots it could be, and put the chosen handle in.
import { replaceCompletion } from '$lib/features/shared/name-completion';

export interface Mention {
  /** Index of the `@`. */
  start: number;
  /** What follows the `@` so far. */
  query: string;
}

/** The `@mention` the caret is at the end of, if any. */
export function mentionAt(text: string, caret: number): Mention | null {
  const match = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

/** Bots whose handle or name starts with the query (handles first), minus `self`. */
export function matchBots<T extends { handle: string; title: string }>(bots: T[], query: string, self: string, limit = 6): T[] {
  const others = bots.filter((bot) => bot.handle !== self);
  const byHandle = others.filter((bot) => bot.handle.startsWith(query));
  const byTitle = others.filter(
    (bot) => !byHandle.includes(bot) && bot.title.toLowerCase().split(/\s+/).some((word) => word.startsWith(query))
  );
  return [...byHandle, ...byTitle].slice(0, limit);
}

/** Replace the mention with `@handle ` and return the new text and caret. */
export function insertMention(text: string, caret: number, mention: Mention, handle: string): { text: string; caret: number } {
  const suffix = /^[\w-]*\s?/.exec(text.slice(caret))?.[0].length ?? 0;
  return replaceCompletion(text, { start: mention.start, end: caret + suffix }, `@${handle}`);
}
