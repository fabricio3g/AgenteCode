import { describe, expect, it } from 'vitest';
import type { CharacterCard, RoleplayWorld } from '$lib/types/chat';
import {
  STARTER_IDS,
  buildStarterKit,
  ensureStarterKit,
  type StarterKitStore
} from './starter-kit';

/**
 * Seed data rots quietly — a card loses its greeting, the world's cast stops
 * resolving, an entry loses its keys and can never fire again. These assert the
 * kit stays whole and that offering it does exactly one thing.
 */

function fakeStore(options: { seeded?: boolean; failOnWorldSave?: boolean } = {}) {
  const characters: CharacterCard[] = [];
  const worlds: RoleplayWorld[] = [];
  let seeded = !!options.seeded;

  const store: StarterKitStore = {
    hasCharacter: (id) => characters.some((card) => card.id === id),
    hasWorld: (id) => worlds.some((world) => world.id === id),
    saveCharacter: async (card) => {
      characters.push(card);
      return card;
    },
    saveWorld: async (world) => {
      if (options.failOnWorldSave) throw new Error('db is having a day');
      worlds.push(world);
      return world;
    },
    isSeeded: async () => seeded,
    markSeeded: async () => {
      seeded = true;
    }
  };

  return { store, characters, worlds, isSeeded: () => seeded };
}

describe('buildStarterKit', () => {
  const kit = buildStarterKit();

  it('ships two characters and one world under fixed ids', () => {
    // Fixed ids are what make the kit idempotent and let the world point at it.
    expect(kit.characters.map((card) => card.id)).toEqual([STARTER_IDS.wren, STARTER_IDS.alderic]);
    expect(kit.world.id).toBe(STARTER_IDS.world);
  });

  it('points the world at exactly the characters it ships with', () => {
    const shipped = new Set(kit.characters.map((card) => card.id));
    expect(kit.world.castIds.length).toBeGreaterThan(0);
    expect(kit.world.castIds.every((id) => shipped.has(id))).toBe(true);
  });

  it('gives every card a greeting and example dialogue', () => {
    for (const card of kit.characters) {
      expect(card.name, 'a card with no name cannot be addressed').toBeTruthy();
      expect(card.firstMessage.length, `${card.name} needs an opening`).toBeGreaterThan(0);
      expect(card.exampleDialogue.length, `${card.name} needs examples to teach the voice`).toBeGreaterThan(0);
      expect(card.description.length).toBeGreaterThan(0);
      expect(card.personality.length).toBeGreaterThan(0);
    }
  });

  it('keeps the two voices on different rhythms', () => {
    // Voice separability is the whole reason there are two of them.
    const [wren, alderic] = kit.characters;
    const wrenOpening = wren!.firstMessage.length;
    const aldericOpening = alderic!.firstMessage.length;
    expect(aldericOpening).toBeGreaterThan(wrenOpening);
    expect(wren!.talkativeness ?? 0).toBeGreaterThan(alderic!.talkativeness ?? 0);
  });

  it('offers more than one opening per card', () => {
    for (const card of kit.characters) {
      expect(card.alternateGreetings.length, `${card.name} needs alternates for the pager`).toBeGreaterThan(0);
      // Arrays, not strings: `.length` on a string would pass this by accident.
      expect(Array.isArray(card.groupOnlyGreetings), `${card.name}'s group openings must be a list`).toBe(true);
      expect(card.groupOnlyGreetings.length, `${card.name} needs a group opening`).toBeGreaterThan(0);
    }
  });

  it('gives every lore entry keys and content, and orders the book', () => {
    const entries = kit.world.book?.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.keys.length, `entry "${entry.comment}" can never fire without keys`).toBeGreaterThan(0);
      expect(entry.content.length, `entry "${entry.comment}" is empty`).toBeGreaterThan(0);
    }
    const order = entries.map((entry) => entry.insertionOrder);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('gives the world a setting and openings', () => {
    expect(kit.world.overview.length).toBeGreaterThan(0);
    expect(kit.world.scenario?.length ?? 0).toBeGreaterThan(0);
    expect(kit.world.starters.length).toBeGreaterThan(0);
    expect(kit.world.settings?.adventureChoices).toBe(true);
    expect(kit.world.settings?.replyOrder).toBe('natural');
  });

  it('uses macros the prompt composer will substitute', () => {
    // Written as {{user}}/{{char}} so one kit works under any persona name.
    expect(kit.world.scenario ?? '').toContain('{{user}}');
  });
});

describe('ensureStarterKit', () => {
  it('offers the kit once and marks it seeded', async () => {
    const fake = fakeStore();
    await ensureStarterKit(fake.store);

    expect(fake.characters).toHaveLength(2);
    expect(fake.worlds).toHaveLength(1);
    expect(fake.isSeeded()).toBe(true);
  });

  it('adds nothing on a second run', async () => {
    const fake = fakeStore();
    await ensureStarterKit(fake.store);
    await ensureStarterKit(fake.store);

    expect(fake.characters).toHaveLength(2);
    expect(fake.worlds).toHaveLength(1);
  });

  it('leaves a deleted kit deleted', async () => {
    const fake = fakeStore();
    await ensureStarterKit(fake.store);
    fake.characters.length = 0;
    fake.worlds.length = 0;

    await ensureStarterKit(fake.store);

    expect(fake.characters).toHaveLength(0);
    expect(fake.worlds).toHaveLength(0);
  });

  it('does nothing at all when already seeded', async () => {
    const fake = fakeStore({ seeded: true });
    await ensureStarterKit(fake.store);

    expect(fake.characters).toHaveLength(0);
    expect(fake.worlds).toHaveLength(0);
  });

  it('leaves the flag unset on failure so the next launch can heal it', async () => {
    const failing = fakeStore({ failOnWorldSave: true });
    await expect(ensureStarterKit(failing.store)).rejects.toThrow('db is having a day');
    expect(failing.isSeeded()).toBe(false);

    // The characters landed before the failure, so a healed run must skip them
    // rather than duplicate them, and must finish the job.
    const healed = fakeStore();
    healed.characters.push(...failing.characters);
    await ensureStarterKit(healed.store);

    expect(healed.characters).toHaveLength(2);
    expect(healed.worlds).toHaveLength(1);
    expect(healed.isSeeded()).toBe(true);
  });

  it('saves the characters before the world that casts them', async () => {
    const fake = fakeStore();
    await ensureStarterKit(fake.store);
    const world = fake.worlds[0]!;

    for (const id of world.castIds) {
      expect(fake.store.hasCharacter(id)).toBe(true);
    }
  });
});
