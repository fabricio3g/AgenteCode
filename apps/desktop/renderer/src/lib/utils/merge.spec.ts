import { describe, expect, it } from 'vitest';
import { mergeById } from '$lib/utils/merge';

describe('mergeById', () => {
  it('keeps in-memory entries that are missing from the persisted list', () => {
    const merged = mergeById(
      [{ id: 'a', name: 'In memory', updatedAt: 20 }],
      [{ id: 'b', name: 'From db', updatedAt: 10 }]
    );
    expect(merged.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
  });

  it('prefers the newer updatedAt when both sides know an entry', () => {
    const merged = mergeById(
      [{ id: 'a', name: 'Newer memory', updatedAt: 20 }],
      [{ id: 'a', name: 'Older db', updatedAt: 10 }]
    );
    expect(merged).toEqual([{ id: 'a', name: 'Newer memory', updatedAt: 20 }]);

    const persistedWins = mergeById(
      [{ id: 'a', name: 'Old memory', updatedAt: 5 }],
      [{ id: 'a', name: 'Newer db', updatedAt: 30 }]
    );
    expect(persistedWins[0].name).toBe('Newer db');
  });

  it('orders newest first', () => {
    const merged = mergeById([], [
      { id: 'a', updatedAt: 1 },
      { id: 'b', updatedAt: 3 },
      { id: 'c', updatedAt: 2 }
    ]);
    expect(merged.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });
});
