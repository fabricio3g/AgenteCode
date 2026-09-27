import type { ChatMessage, CharacterCard, RoleplayReplyOrder } from '$lib/types/chat';

/**
 * Group turn routing.
 *
 * Pure functions: given the cast, the history and a strategy, decide who
 * speaks next. No store access, no randomness beyond the injected `random`,
 * so every rule is unit-testable.
 */

export interface TurnContext {
  strategy: RoleplayReplyOrder;
  /** Ordered cast; the first member is the primary speaker. */
  cast: CharacterCard[];
  messages: ChatMessage[];
  mutedIds?: string[];
  /** Allow the same character to speak twice in a row. */
  allowSelfReplies?: boolean;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word mention test, tolerant of punctuation around the name. */
export function mentionsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}($|[^\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

/** Characters mentioned in a message, in cast order. */
function mentionedCast(text: string, cast: CharacterCard[]): CharacterCard[] {
  if (!text) return [];
  return cast.filter((card) => mentionsName(text, card.name) || (!!card.nickname && mentionsName(text, card.nickname)));
}

/** Character ids mentioned in a message, in cast order. */
export function extractMentions(text: string, cast: CharacterCard[]): string[] {
  return mentionedCast(text, cast).map((card) => card.id);
}

/** The speaker of the most recent attributed assistant turn. */
export function lastSpeakerId(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.speakerId) return message.speakerId;
  }
  return null;
}

function activeCast(ctx: TurnContext): CharacterCard[] {
  const muted = new Set(ctx.mutedIds || []);
  return ctx.cast.filter((card) => card.id && !muted.has(card.id));
}

function pick<T>(items: T[], random: () => number): T | null {
  if (!items.length) return null;
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))] || null;
}

function withoutSelf(ctx: TurnContext, candidates: CharacterCard[], last: string | null): CharacterCard[] {
  if (ctx.allowSelfReplies || !last) return candidates;
  const filtered = candidates.filter((card) => card.id !== last);
  return filtered.length ? filtered : candidates;
}

/**
 * Who speaks next.
 *
 * - list:    round-robin through the unmuted cast, after the last speaker.
 * - natural: mentions first, then a talkativeness roll, then a random member.
 * - mention: mentioned members only, falling back to the primary.
 * - manual:  never auto-selects (the UI force-talks a member instead).
 */
export function selectNextSpeaker(ctx: TurnContext): string | null {
  const cast = activeCast(ctx);
  if (!cast.length) return null;

  const random = ctx.random || Math.random;
  const last = lastSpeakerId(ctx.messages);
  const lastMessage = [...ctx.messages].reverse().find((message) => (message.content || '').trim());

  if (ctx.strategy === 'manual') return null;

  if (ctx.strategy === 'list') {
    const lastIndex = cast.findIndex((card) => card.id === last);
    const next = cast[(lastIndex + 1) % cast.length];
    return next?.id ?? cast[0].id;
  }

  const mentioned = mentionedCast(lastMessage?.content || '', cast);
  if (ctx.strategy === 'mention') {
    const candidates = withoutSelf(ctx, mentioned.length ? mentioned : cast, last);
    return (candidates[0] || cast[0]).id;
  }

  // natural
  const mentionedCandidates = withoutSelf(ctx, mentioned, last);
  if (mentionedCandidates.length) return mentionedCandidates[0].id;

  const chatty = cast.filter((card) => {
    const talkativeness = Number.isFinite(card.talkativeness) ? Number(card.talkativeness) : 50;
    return random() * 100 < talkativeness;
  });
  const pool = withoutSelf(ctx, chatty.length ? chatty : cast, last);
  return pick(pool, random)?.id ?? cast[0].id;
}
