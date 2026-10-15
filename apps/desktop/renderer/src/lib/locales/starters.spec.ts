import { describe, expect, it } from 'vitest';

const LOCALES = import.meta.glob<{ default: Record<string, unknown> }>('./*.json', { eager: true });

const IDS = ['explain', 'bug', 'tests', 'run'] as const;
/** Only the prompts that are the start of a sentence carry a blank to fill. */
const WITH_SLOT = ['bug', 'tests'];

interface StarterRow {
  label: string;
  hint: string;
  slot?: string;
  prompt: string;
}

const starters = (module: { default: Record<string, unknown> }) =>
  (module.default.code as { starters: Record<string, StarterRow> & { title: string } }).starters;

describe('code starters', () => {
  for (const [path, module] of Object.entries(LOCALES)) {
    const name = path.replace('./', '').replace('.json', '');
    const block = starters(module);

    it(`${name} names every starter, and only the starters`, () => {
      expect(Object.keys(block).sort()).toEqual(['title', ...IDS].sort());
    });

    it(`${name} shows complete sentences, never a prompt fragment`, () => {
      for (const id of IDS) {
        const row = block[id];
        const fields: (keyof StarterRow)[] = WITH_SLOT.includes(id) ? ['label', 'hint', 'slot'] : ['label', 'hint'];
        for (const field of fields) {
          const value = row[field] ?? '';
          expect(value, `${name}.${id}.${field} is missing`).not.toBe('');
          expect(value, `${name}.${id}.${field} has stray whitespace`).toBe(value.trim());
          // The renderer used to append an ellipsis to any string ending in a
          // space, because it was displaying prompts as labels. Labels are
          // sentences now, so an ellipsis here means a fragment crept back in.
          expect(value, `${name}.${id}.${field} reads as truncated`).not.toContain('…');
          expect(value, `${name}.${id}.${field} reads as truncated`).not.toContain('...');
        }
      }
    });

    it(`${name} keeps the prompts intact for the composer`, () => {
      for (const id of IDS) {
        expect(block[id].prompt.trim(), `${name}.${id}.prompt`).not.toBe('');
      }
    });

    it(`${name} gives a slot to exactly the prompts that need one`, () => {
      for (const id of IDS) {
        expect('slot' in block[id], `${name}.${id}`).toBe(WITH_SLOT.includes(id));
      }
    });
  }
});
