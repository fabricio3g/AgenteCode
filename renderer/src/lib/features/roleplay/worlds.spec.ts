// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { normalizeWorld } from './worlds.svelte';

describe('normalizeWorld', () => {
  it('fills missing fields without dropping provided ones', () => {
    const world = normalizeWorld({ id: 'world-1', name: 'Eldoria', overview: 'A floating city.' });
    expect(world.name).toBe('Eldoria');
    expect(world.overview).toBe('A floating city.');
    expect(world.castIds).toEqual([]);
    expect(world.starters).toEqual([]);
    expect(world.book?.entries).toEqual([]);
    expect(world.book?.scanDepth).toBe(4);
  });

  it('keeps cast order and normalizes the book', () => {
    const world = normalizeWorld({
      id: 'world-1',
      castIds: ['b', 'a'],
      book: {
        tokenBudget: 500,
        entries: [{ id: 'e1', keys: ['moon'], content: 'Lunar lore', enabled: true, insertionOrder: 3 }]
      }
    });
    expect(world.castIds).toEqual(['b', 'a']);
    expect(world.book?.tokenBudget).toBe(500);
    expect(world.book?.entries[0].keys).toEqual(['moon']);
  });
});
