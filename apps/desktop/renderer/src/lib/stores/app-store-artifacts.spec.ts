import { describe, expect, it } from 'vitest';
import type { ChatSession } from '$lib/types/chat';
import {
  applyArtifactsToMessage,
  artifactsForMessage,
  resolveArtifactForMessage,
  upsertArtifactOnMessage
} from './app-store-artifacts';

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
    const saved = upsertArtifactOnMessage(session, 'message-b', { title: 'Page', files: { 'index.html': '<h1>Saved</h1>' } });
    expect(saved).toBe(true);
    expect(session.messages[0].artifact).toBeUndefined();
    expect(resolveArtifactForMessage(session, 'message-b')?.manifest).toMatchObject({ kind: 'web', presentation: 'web', status: 'ready' });
  });

  it('refuses missing messages without mutating the chat', () => {
    const session = chat();
    expect(upsertArtifactOnMessage(session, 'missing', { title: 'Nope', files: { 'x.txt': 'x' } })).toBe(false);
    expect(session.messages.every((message) => !message.artifact)).toBe(true);
  });

  it('keeps every artifact a turn produced and exposes the last as the primary', () => {
    const session = chat();
    applyArtifactsToMessage(session, 'message-b', [
      { title: 'chart.json', files: { 'chart.json': '{}' }, manifest: { schemaVersion: 1, kind: 'chart', presentation: 'inline', entryPath: 'chart.json', status: 'ready' } },
      { title: 'diagram.json', files: { 'diagram.json': '{}' }, manifest: { schemaVersion: 1, kind: 'diagram', presentation: 'inline', entryPath: 'diagram.json', status: 'ready' } }
    ]);
    expect(artifactsForMessage(session.messages[1]).map((entry) => entry.manifest?.kind)).toEqual(['chart', 'diagram']);
    expect(session.messages[1].artifact?.manifest?.kind).toBe('diagram');
  });

  it('upserts one artifact without dropping its siblings', () => {
    const session = chat();
    applyArtifactsToMessage(session, 'message-b', [
      { title: 'chart.json', files: { 'chart.json': '{"v":1}' }, manifest: { schemaVersion: 1, kind: 'chart', presentation: 'inline', entryPath: 'chart.json', status: 'ready' } },
      { title: 'diagram.json', files: { 'diagram.json': '{}' }, manifest: { schemaVersion: 1, kind: 'diagram', presentation: 'inline', entryPath: 'diagram.json', status: 'ready' } }
    ]);
    // Editing the chart in the studio must not delete the diagram.
    upsertArtifactOnMessage(session, 'message-b', {
      title: 'chart.json',
      files: { 'chart.json': '{"v":2}' },
      manifest: { schemaVersion: 1, kind: 'chart', presentation: 'inline', entryPath: 'chart.json', status: 'ready' }
    });
    const kept = artifactsForMessage(session.messages[1]);
    expect(kept).toHaveLength(2);
    expect(kept[0].files['chart.json']).toBe('{"v":2}');
    expect(kept[1].manifest?.kind).toBe('diagram');
  });

  it('promotes a legacy single artifact to a one-item list', () => {
    const session = chat();
    session.messages[1].artifact = { title: 'old', files: { 'a.md': '# a' } };
    expect(artifactsForMessage(session.messages[1])).toHaveLength(1);
  });
});
