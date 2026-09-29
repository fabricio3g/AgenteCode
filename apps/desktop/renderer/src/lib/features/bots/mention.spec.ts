import { describe, expect, it } from 'vitest';
import { insertMention, matchBots, mentionAt } from './mention';

const bots = [
  { handle: 'colina', title: 'Colina' },
  { handle: 'scout', title: 'Scout' },
  { handle: 'quill', title: 'Research Quill' }
];

describe('mentionAt', () => {
  it('finds the mention at the caret', () => {
    expect(mentionAt('ask @sc', 7)).toEqual({ start: 4, query: 'sc' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('ignores emails and finished words', () => {
    expect(mentionAt('mail a@b', 8)).toBeNull();
    expect(mentionAt('@scout ok', 9)).toBeNull();
  });
});

describe('matchBots', () => {
  it('matches handles first, then words of the name, never the bot itself', () => {
    expect(matchBots(bots, 'r', 'colina').map((bot) => bot.handle)).toEqual(['quill']);
    expect(matchBots(bots, '', 'colina').map((bot) => bot.handle)).toEqual(['scout', 'quill']);
    expect(matchBots(bots, 'co', 'colina')).toEqual([]);
  });
});

describe('insertMention', () => {
  it('replaces the partial handle and puts the caret after it', () => {
    expect(insertMention('ask @sc please', 7, { start: 4, query: 'sc' }, 'scout')).toEqual({ text: 'ask @scout please', caret: 11 });
    expect(insertMention('@', 1, { start: 0, query: '' }, 'quill')).toEqual({ text: '@quill ', caret: 7 });
  });
});
