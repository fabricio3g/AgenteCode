import { describe, expect, it } from 'vitest';
import type { ChatMessage, CharacterCard } from '$lib/types/chat';
import { extractMentions, lastSpeakerId, mentionsName, selectNextSpeaker } from './group-turn';

function card(name: string, overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: `char-${name.toLowerCase()}`,
    name,
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    exampleDialogue: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    role: 'assistant',
    content: '',
    createdAt: 0,
    ...overrides
  };
}

describe('mentionsName', () => {
  it('matches whole words only, ignoring case and punctuation', () => {
    expect(mentionsName('Aiko, wait!', 'Aiko')).toBe(true);
    expect(mentionsName('aiko?', 'Aiko')).toBe(true);
    expect(mentionsName('Misaka is here', 'Misa')).toBe(false);
    expect(mentionsName('Misa is here', 'Misaka')).toBe(false);
  });

  it('matches names with spaces', () => {
    expect(mentionsName('Misaka Mikoto, please.', 'Misaka Mikoto')).toBe(true);
  });
});

describe('extractMentions', () => {
  it('returns mentioned ids in cast order', () => {
    const cast = [card('Aiko'), card('Ren'), card('Yuki')];
    expect(extractMentions('Yuki and Aiko should talk.', cast)).toEqual(['char-aiko', 'char-yuki']);
  });

  it('accepts nicknames', () => {
    const cast = [card('Aiko', { nickname: 'Ai' })];
    expect(extractMentions('Ai?', cast)).toEqual(['char-aiko']);
  });
});

describe('lastSpeakerId', () => {
  it('finds the most recent attributed assistant turn', () => {
    expect(lastSpeakerId([
      message({ role: 'assistant', speakerId: 'a' }),
      message({ role: 'user' }),
      message({ role: 'assistant', speakerId: 'b' })
    ])).toBe('b');
  });
});

describe('selectNextSpeaker', () => {
  const aiko = card('Aiko');
  const ren = card('Ren');
  const yuki = card('Yuki');
  const cast = [aiko, ren, yuki];

  it('list order takes turns and wraps around', () => {
    const ctx = { strategy: 'list' as const, cast, messages: [] };
    expect(selectNextSpeaker(ctx)).toBe(aiko.id);
    expect(selectNextSpeaker({
      ...ctx,
      messages: [message({ speakerId: aiko.id, content: 'Hi.' })]
    })).toBe(ren.id);
    expect(selectNextSpeaker({
      ...ctx,
      messages: [message({ speakerId: yuki.id, content: 'Hi.' })]
    })).toBe(aiko.id);
  });

  it('list order skips muted members', () => {
    const next = selectNextSpeaker({
      strategy: 'list',
      cast,
      messages: [message({ speakerId: aiko.id, content: 'Hi.' })],
      mutedIds: [ren.id]
    });
    expect(next).toBe(yuki.id);
  });

  it('returns null when every member is muted or absent', () => {
    expect(selectNextSpeaker({ strategy: 'list', cast: [], messages: [] })).toBeNull();
    expect(selectNextSpeaker({ strategy: 'list', cast, messages: [], mutedIds: cast.map((c) => c.id) })).toBeNull();
    expect(selectNextSpeaker({ strategy: 'manual', cast, messages: [] })).toBeNull();
  });

  it('natural order lets a mention decide the speaker', () => {
    const next = selectNextSpeaker({
      strategy: 'natural',
      cast,
      messages: [message({ role: 'user', content: 'Ren, what do you think?' })],
      random: () => 0.99
    });
    expect(next).toBe(ren.id);
  });

  it('natural order never answers a mention of your own name by default', () => {
    const next = selectNextSpeaker({
      strategy: 'natural',
      cast,
      messages: [message({ speakerId: aiko.id, content: 'Ren and I were just talking about Aiko.' })],
      random: () => 0
    });
    expect(next).not.toBe(aiko.id);
  });

  it('natural order falls back to a talkativeness roll', () => {
    const quiet = card('Quiet', { talkativeness: 0 });
    const chatty = card('Chatty', { talkativeness: 100 });
    const next = selectNextSpeaker({
      strategy: 'natural',
      cast: [quiet, chatty],
      messages: [message({ role: 'user', content: 'Anyone around?' })],
      random: () => 0.5
    });
    expect(next).toBe(chatty.id);
  });

  it('natural order still picks someone when nobody is talkative', () => {
    const quietA = card('Quiet A', { talkativeness: 0 });
    const quietB = card('Quiet B', { talkativeness: 0 });
    const next = selectNextSpeaker({
      strategy: 'natural',
      cast: [quietA, quietB],
      messages: [message({ role: 'user', content: 'Hello?' })],
      random: () => 0.99
    });
    expect([quietA.id, quietB.id]).toContain(next);
  });

  it('mention strategy falls back to the primary when nobody is named', () => {
    const next = selectNextSpeaker({
      strategy: 'mention',
      cast,
      messages: [message({ role: 'user', content: 'What a strange night.' })]
    });
    expect(next).toBe(aiko.id);
  });

  it('mention strategy honours the mention', () => {
    const next = selectNextSpeaker({
      strategy: 'mention',
      cast,
      messages: [message({ role: 'user', content: 'Yuki?' })]
    });
    expect(next).toBe(yuki.id);
  });
});
