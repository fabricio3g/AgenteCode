import { describe, expect, it } from 'vitest';
import type { ChatSession } from '$lib/types/chat';
import { collectArtifacts, filterArtifacts, groupOf } from './artifact-library';

const chat = (id: string, contextMode: ChatSession['contextMode'], messages: unknown[]): ChatSession =>
  ({ id, title: `Chat ${id}`, contextMode, updatedAt: 1, messages } as unknown as ChatSession);

const report = { title: 'Q3 report', files: { 'report.md': '# Q3' } };
const deck = { title: 'Launch deck', files: { 'deck.pptx': 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,AA==' } };

describe('artifact library', () => {
  it('collects artifacts newest first and skips code chats', () => {
    const entries = collectArtifacts([
      chat('a', 'home', [{ id: 'm1', role: 'assistant', createdAt: 10, artifacts: [report] }]),
      chat('b', 'home', [{ id: 'm2', role: 'assistant', createdAt: 20, artifact: deck }]),
      chat('c', 'code', [{ id: 'm3', role: 'assistant', createdAt: 30, artifacts: [report] }])
    ]);
    expect(entries.map((e) => e.artifact.title)).toEqual(['Launch deck', 'Q3 report']);
    expect(entries[0].chatTitle).toBe('Chat b');
  });

  it('groups kinds and filters by text and group', () => {
    expect(groupOf('presentation')).toBe('presentations');
    expect(groupOf('chart')).toBe('visuals');
    const entries = collectArtifacts([chat('a', 'home', [{ id: 'm1', role: 'assistant', createdAt: 1, artifacts: [report, deck] }])]);
    expect(filterArtifacts(entries, 'deck', 'all').map((e) => e.artifact.title)).toEqual(['Launch deck']);
    expect(filterArtifacts(entries, '', 'presentations').length).toBe(1);
    expect(filterArtifacts(entries, 'chat a', 'all').length).toBe(2);
  });
});
