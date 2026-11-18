/**
 * Context budgeting for roleplay requests.
 *
 * A roleplay request is the stable block, the history, and the volatile tail.
 * When it does not fit the window (after the completion reserve), the budget
 * trims in a fixed order, cheapest first:
 *
 *   1. example dialogue of the primary
 *   2. lore, cut to the top N by priority
 *   3. long descriptions, cut to their first N characters
 *   4. the oldest history turns
 *
 * The first greeting (an opening assistant message) is never dropped: it sets
 * the scene's voice and the first thing the user read. The newest user turn is
 * never dropped either. Measurements use the app's own estimator (about four
 * characters per token, plus four per message), the same one the local
 * backstop in main/token-counter uses, so a request this module fits is not
 * trimmed again there.
 */

import type { RequestMessage } from './chat-api';
import type { PromptTrim, RoleplayUsed } from '$lib/types/chat';
import { LOCAL_ROLEPLAY_MAX_TOKENS } from './roleplay-prompts';

/** Window assumed when the runtime reports none. */
export const FALLBACK_CONTEXT_TOKENS = 4096;

/** Completion reserve for cloud scenes that set no `max_tokens`. */
const CLOUD_COMPLETION_RESERVE = 1024;

/** The trims applied in order; each step keeps the previous ones. */
const PROMPT_TRIM_LADDER: readonly PromptTrim[] = [
  {},
  { examples: true },
  { examples: true, loreLimit: 4 },
  { examples: true, loreLimit: 2, descriptionChars: 800 },
  { examples: true, loreLimit: 0, descriptionChars: 400 }
];

/** The app's per-message estimate: a fixed overhead plus characters / 4. */
export function messageTokens(message: RequestMessage): number {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const reasoning = message.reasoning_content ? String(message.reasoning_content) : '';
  return 4 + Math.ceil(content.length / 4) + Math.ceil(reasoning.length / 4);
}

export function requestTokens(messages: RequestMessage[]): number {
  let total = 0;
  for (const message of messages) total += messageTokens(message);
  return total;
}

/**
 * Tokens held back for the reply. The scene's own cap wins when it is smaller;
 * otherwise the local default (or the cloud default) applies. Never more than a
 * quarter of the window, so a small model keeps room for its prompt.
 */
export function completionReserve(input: { contextTokens: number; maxTokens?: number | null; backend: 'local' | 'api' }): number {
  const fallback = input.backend === 'local' ? LOCAL_ROLEPLAY_MAX_TOKENS : CLOUD_COMPLETION_RESERVE;
  const wanted = input.maxTokens && input.maxTokens > 0 ? Math.floor(input.maxTokens) : fallback;
  return Math.min(wanted, Math.floor(input.contextTokens * 0.25));
}

export interface ComposedRequest {
  messages: RequestMessage[];
  used: RoleplayUsed;
}

export interface FitRoleplayInput {
  contextTokens: number;
  reserve: number;
  /** The history as sent, oldest first. The last message is the new user turn. */
  history: RequestMessage[];
  /** Build the full request for a history and a trim level (stable block, history, tail). */
  compose: (history: RequestMessage[], trim: PromptTrim) => ComposedRequest;
}

export interface FitRoleplayResult extends ComposedRequest {
  /** False when even the trimmed prompt with only the new turn is over the room. */
  fits: boolean;
}

/**
 * Fit a roleplay request into `contextTokens - reserve`. Walks the prompt trims
 * until the whole history fits, then drops the oldest history turns (keeping
 * the greeting and the newest user turn). Returns the request and its `used`
 * record, with every trim listed in `used.trimmed`.
 */
export function fitRoleplayRequest(input: FitRoleplayInput): FitRoleplayResult {
  const room = Math.max(0, input.contextTokens - input.reserve);
  const history = input.history;
  const perMessage = history.map(messageTokens);
  const historyTotal = perMessage.reduce((sum, tokens) => sum + tokens, 0);
  const greeting = history.length > 1 && history[0]?.role === 'assistant' ? 1 : 0;
  const last = history.length - 1;

  // The prompt-only cost of each trim level: the request without history.
  let level = 0;
  let base = requestTokens(input.compose([], PROMPT_TRIM_LADDER[0]!).messages);
  while (level < PROMPT_TRIM_LADDER.length - 1 && base + historyTotal > room) {
    level += 1;
    base = requestTokens(input.compose([], PROMPT_TRIM_LADDER[level]!).messages);
  }
  const trim = PROMPT_TRIM_LADDER[level]!;

  // History: the smallest start index whose suffix fits, then aligned on a user turn.
  let start = greeting;
  if (base + historyTotal > room && last > greeting) {
    const greetingTokens = perMessage.slice(0, greeting).reduce((sum, tokens) => sum + tokens, 0);
    let suffix = historyTotal - greetingTokens;
    let s = greeting;
    while (s < last && base + greetingTokens + suffix > room) {
      suffix -= perMessage[s]!;
      s += 1;
    }
    while (s < last && history[s]!.role !== 'user') s += 1;
    start = s;
  }

  const kept = [...history.slice(0, greeting), ...history.slice(start)];
  const composed = input.compose(kept, trim);
  const dropped = start - greeting;
  const used: RoleplayUsed = dropped > 0
    ? { ...composed.used, trimmed: [...composed.used.trimmed, { kind: 'history', count: dropped }] }
    : composed.used;
  return {
    messages: composed.messages,
    used,
    fits: requestTokens(composed.messages) <= room
  };
}
