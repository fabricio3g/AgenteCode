import { describe, expect, it } from 'vitest';
import type { ChatSession } from '$lib/types/chat';
import { applyArtifactToMessage, resolveArtifactForMessage } from './app-store-artifacts';

function chat(): ChatSession {
  return {
    id: 'chat-a',
    title: 'Chat',
    messages: [
      { id: 'message-a', role: 'assistant', content: 'A' },
      { id: 'message-b', role: 'assistant', content: 'B' }
    ]
  } as ChatSession;
}

describe('app store artifact helpers', () => {
  it('updates exactly the originating message and normalizes the saved artifact', () => {
    const session = chat();
    const saved = applyArtifactToMessage(session, 'message-b', { title: 'Page', files: { 'index.html': '<h1>Saved</h1>' } });
    expect(saved).toBe(true);
    expect(session.messages[0].artifact).toBeUndefined();
    expect(resolveArtifactForMessage(session, 'message-b')?.manifest).toMatchObject({ kind: 'web', presentation: 'web', status: 'ready' });
  });

  it('refuses missing messages without mutating the chat', () => {
    const session = chat();
    expect(applyArtifactToMessage(session, 'missing', { title: 'Nope', files: { 'x.txt': 'x' } })).toBe(false);
    expect(session.messages.every((message) => !message.artifact)).toBe(true);
  });
});
