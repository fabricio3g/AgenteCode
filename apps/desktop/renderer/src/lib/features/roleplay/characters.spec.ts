// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { CharacterCard } from '$lib/types/chat';
import { emptyCharacter, greetingsFor, normalizeCharacterCard } from './characters.svelte';

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return emptyCharacter({ name: 'Aiko', ...overrides });
}

describe('normalizeCharacterCard', () => {
  it('fills missing fields without dropping provided ones', () => {
    const normalized = normalizeCharacterCard({ id: 'char-1', name: 'Aiko', description: 'Barista' } as Partial<CharacterCard>);
    expect(normalized.name).toBe('Aiko');
    expect(normalized.description).toBe('Barista');
    expect(normalized.alternateGreetings).toEqual([]);
    expect(normalized.tags).toEqual([]);
    expect(normalized.spec).toBe('flaxeo');
  });
});

describe('greetingsFor', () => {
  it('returns the first message followed by alternates, skipping blanks', () => {
    const greetings = greetingsFor(card({
      firstMessage: 'Hello.',
      alternateGreetings: ['Second.', '  ']
    }));
    expect(greetings).toEqual(['Hello.', 'Second.']);
  });

  it('includes group-only greetings only for group scenes', () => {
    const value = card({
      firstMessage: 'One.',
      groupOnlyGreetings: ['Group only.']
    });
    expect(greetingsFor(value)).toEqual(['One.']);
    expect(greetingsFor(value, { group: true })).toEqual(['One.', 'Group only.']);
  });

  it('returns nothing when every greeting is blank', () => {
    expect(greetingsFor(card())).toEqual([]);
  });
});
