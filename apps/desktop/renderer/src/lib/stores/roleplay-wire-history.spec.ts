import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { buildRequestMessagesFromHistory, dropFailedReplies, isFailedReply } from '$lib/stores/app-store-helpers';

function message(id: string, role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, createdAt: 1, done: true, status: 'idle', versions: [], activeVersion: 0, ...extra } as ChatMessage;
}

describe('failed roleplay replies stay out of the wire history', () => {
  const failedByStatus = message('a2', 'assistant', 'Request failed: timeout', { status: 'error' });
  const failedByMetadata = message('a3', 'assistant', 'No API key configured', { metadata: { error: true, errorMessage: 'No API key' } as ChatMessage['metadata'] });
  const history = [
    message('g', 'assistant', 'The door creaks.'),
    message('u1', 'user', 'Hello.'),
    failedByStatus,
    message('u2', 'user', 'Still there?'),
    failedByMetadata,
    message('u3', 'user', 'Hello again.')
  ];

  it('recognizes an error status and an error flag, and nothing else', () => {
    expect(isFailedReply(failedByStatus)).toBe(true);
    expect(isFailedReply(failedByMetadata)).toBe(true);
    expect(isFailedReply(history[0])).toBe(false);
    // A failed user turn is still the user's words.
    expect(isFailedReply(message('u', 'user', 'x', { status: 'error' }))).toBe(false);
  });

  it('drops every failed reply and keeps order', () => {
    expect(dropFailedReplies(history).map((entry) => entry.id)).toEqual(['g', 'u1', 'u2', 'u3']);
  });

  it('never sends a failed reply back through the request builder', () => {
    const request = buildRequestMessagesFromHistory(dropFailedReplies(history), dropFailedReplies(history).length - 1);
    expect(request.map((entry) => entry.content).join('\n')).not.toContain('Request failed');
    expect(request.map((entry) => entry.content).join('\n')).not.toContain('No API key');
    expect(request.at(-1)?.content).toBe('Hello again.');
  });
});
