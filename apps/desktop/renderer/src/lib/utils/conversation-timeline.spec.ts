import { describe, expect, it } from 'vitest';
import {
  conversationDialWindow,
  conversationDialRadius,
  conversationTimelinePreview
} from './conversation-timeline';
import type { ChatMessage } from '$lib/types/chat';

describe('conversationDialWindow', () => {
  it('keeps tick targets apart as the available height shrinks', () => {
    for (const height of [32, 64, 96, 144, 192]) {
      const entries = conversationDialWindow(100, 50, conversationDialRadius(height));
      for (let i = 1; i < entries.length; i++) expect((entries[i].position - entries[i - 1].position) * height / 100).toBeGreaterThanOrEqual(18);
      expect(entries.some(entry => entry.index === 50)).toBe(true);
    }
  });
  it('keeps the selected turn centered in a bounded message window', () => {
    const window = conversationDialWindow(20, 10, 3);
    expect(window.map(({ index, distance }) => ({ index, distance }))).toEqual([
      { index: 7, distance: -3 },
      { index: 8, distance: -2 },
      { index: 9, distance: -1 },
      { index: 10, distance: 0 },
      { index: 11, distance: 1 },
      { index: 12, distance: 2 },
      { index: 13, distance: 3 }
    ]);
    expect(window[0].position).toBe(12);
    expect(window[3].position).toBe(50);
    expect(window[6].position).toBe(88);
  });

  it('tapers at the beginning and end of a conversation', () => {
    const window = conversationDialWindow(5, 4, 3);
    expect(window.map(({ index, distance }) => ({ index, distance }))).toEqual([
      { index: 1, distance: -3 },
      { index: 2, distance: -2 },
      { index: 3, distance: -1 },
      { index: 4, distance: 0 }
    ]);
    expect(window[0].position).toBe(12);
    expect(window[3].position).toBe(88);
  });
});

describe('conversationTimelinePreview', () => {
  const baseMessage: ChatMessage = {
    id: 'message-1',
    role: 'assistant',
    content: '',
    createdAt: 1
  };

  it('converts markdown into a compact plain-text preview', () => {
    expect(
      conversationTimelinePreview({
        ...baseMessage,
        content: '## Result\n\nSee **the [documentation](https://example.com)**.'
      })
    ).toBe('Result See the documentation .');
  });

  it('uses the active version and truncates long content', () => {
    expect(
      conversationTimelinePreview(
        {
          ...baseMessage,
          content: 'Old answer',
          activeVersion: 1,
          versions: [
            { content: 'First answer', createdAt: 1 },
            { content: 'This is the active and much longer answer', createdAt: 2 }
          ]
        },
        20
      )
    ).toBe('This is the active…');
  });
});
