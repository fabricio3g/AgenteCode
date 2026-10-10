// Steering a scene without writing the next turn yourself: continue the last
// reply, draft your own next line (impersonate), and keep a running summary of
// the story so long scenes stay consistent. Pure prompt builders; the store
// runs them.

import type { RequestMessage } from '$lib/services/chat/types';
import type { ChatMessage, RoleplayStorySummary } from '$lib/types/chat';
import { getMessageRequestContent } from '$lib/stores/app-store-helpers';

/** Characters of transcript a summary or an impersonation reads, newest last. */
const TRANSCRIPT_CHARS = 12_000;

/** Appended after the history when the last reply should keep going. */
export const CONTINUE_INSTRUCTION =
  'Continue your previous reply from exactly where it stopped, in the same voice and format. ' +
  'Do not repeat or summarize what is already written; write only the continuation.';

/** The turns as a plain transcript: `Name: text`, newest last, cut from the front. */
export function transcript(messages: ChatMessage[], nameOf: (message: ChatMessage) => string): string {
  const lines = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `${nameOf(message)}: ${getMessageRequestContent(message).trim()}`)
    .filter((line) => !line.endsWith(': '));
  const text = lines.join('\n\n');
  return text.length > TRANSCRIPT_CHARS ? text.slice(-TRANSCRIPT_CHARS) : text;
}

/** Ask for the user's next line, in their persona's voice, as a draft to edit. */
export function impersonationMessages(input: { userName: string; persona?: string; characters: string[]; transcript: string }): RequestMessage[] {
  return [
    {
      role: 'system',
      content: [
        `You write the next message for ${input.userName} in a roleplay with ${input.characters.join(', ') || 'the characters'}.`,
        input.persona?.trim() ? `About ${input.userName}: ${input.persona.trim()}` : '',
        `Write only ${input.userName}'s next message, in first person, one to three sentences, matching how ${input.userName} has been writing.`,
        'Do not write for any other character, add a name label, or explain.'
      ].filter(Boolean).join('\n')
    },
    { role: 'user', content: input.transcript || '(The scene has just begun.)' }
  ];
}

/** Update the story so far with the turns since the last summary. */
export function summaryMessages(input: { previous?: string; transcript: string; words: number }): RequestMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You keep the running summary of a roleplay story.',
        `Rewrite the summary to include the new turns, in at most ${input.words} words of plain past-tense prose.`,
        'Keep what matters later: events, decisions, promises, secrets revealed, where everyone is and how they feel about each other.',
        'Leave out small talk and exact wording. Reply with the summary only.'
      ].join('\n')
    },
    { role: 'user', content: `${input.previous?.trim() ? `Summary so far:\n${input.previous.trim()}\n\n` : ''}New turns:\n${input.transcript}` }
  ];
}

/** The turns a summary hasn't covered yet: everything after its last message. */
export function unsummarized(messages: ChatMessage[], summary: RoleplayStorySummary | null | undefined): ChatMessage[] {
  const from = summary?.throughId ? messages.findIndex((message) => message.id === summary.throughId) + 1 : 0;
  return messages.slice(Math.max(0, from)).filter((message) => message.done !== false);
}

/**
 * Time to update the summary: `every` replies since the last one, or the context is getting full.
 * `onlyWhenFull` waits for the full context alone (local models, where a side call costs the cached prompt).
 */
export function summaryDue(
  messages: ChatMessage[],
  summary: RoleplayStorySummary | null | undefined,
  every: number,
  contextRatio = 0,
  options: { onlyWhenFull?: boolean } = {}
): boolean {
  const pending = unsummarized(messages, summary).filter((message) => message.role === 'assistant').length;
  const full = contextRatio >= 0.7 && pending >= 2;
  if (options.onlyWhenFull) return full;
  if (every <= 0) return false;
  return pending >= every || full;
}

/** A model's draft, cleaned: no name label, no wrapping quotes. */
export function cleanDraft(text: string, userName: string): string {
  const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.trim().replace(new RegExp(`^(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*`, 'i'), '').replace(/^"([^"]*)"$/, '$1').trim();
}

/** A continuation joined to the reply it extends: a space mid-sentence, a paragraph break otherwise. */
export function joinContinuation(prefix: string, tail: string): string {
  const head = prefix.replace(/\s+$/, '');
  const next = tail.replace(/^\s+/, '');
  if (!next) return head;
  return /[.!?…"”*)\]]$/.test(head) ? `${head}\n\n${next}` : `${head} ${next}`;
}
