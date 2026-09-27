import type { RoleplayWorld, WorldSettings } from '$lib/types/chat';
import { loadWorldsFromDb, saveWorldToDb, deleteWorldFromDb } from '$lib/utils/storage';
import { createId } from '$lib/utils/id';
import { mergeById } from '$lib/utils/merge';
import { normalizeBook } from '$lib/services/character-card';

/**
 * World library.
 *
 * A world is a reusable scene kit — setting, lorebook, cast, openings and
 * defaults. Chats keep their own timeline; worlds are what carry over.
 */

export function emptyWorld(overrides: Partial<RoleplayWorld> = {}): RoleplayWorld {
  const now = Date.now();
  return {
    id: createId('world'),
    name: '',
    tagline: '',
    overview: '',
    scenario: '',
    avatar: '',
    book: normalizeBook(null),
    castIds: [],
    starters: [],
    defaultPersonaId: null,
    settings: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/** Fill in missing fields on persisted or imported worlds without losing data. */
export function normalizeWorld(world: Partial<RoleplayWorld>): RoleplayWorld {
  const base = emptyWorld();
  return {
    ...base,
    ...world,
    id: String(world.id || base.id),
    name: String(world.name || ''),
    tagline: String(world.tagline || ''),
    overview: String(world.overview || ''),
    scenario: String(world.scenario || ''),
    avatar: typeof world.avatar === 'string' ? world.avatar : '',
    book: normalizeBook(world.book),
    castIds: Array.isArray(world.castIds) ? world.castIds.map(String).filter(Boolean) : [],
    starters: Array.isArray(world.starters) ? world.starters.map(String) : [],
    defaultPersonaId: world.defaultPersonaId ? String(world.defaultPersonaId) : null,
    settings: { ...((world.settings || {}) as WorldSettings) },
    createdAt: Number.isFinite(world.createdAt) ? Number(world.createdAt) : base.createdAt,
    updatedAt: Number.isFinite(world.updatedAt) ? Number(world.updatedAt) : base.updatedAt
  };
}

class WorldsStore {
  worlds = $state<RoleplayWorld[]>([]);
  loaded = $state(false);

  async load() {
    const worlds = await loadWorldsFromDb();
    this.worlds = mergeById(this.worlds, worlds.map((world) => normalizeWorld(world)));
    this.loaded = true;
  }

  getById(id: string | null | undefined): RoleplayWorld | null {
    if (!id) return null;
    return this.worlds.find((world) => world.id === id) || null;
  }

  async save(world: RoleplayWorld) {
    const normalized = normalizeWorld({ ...world, updatedAt: Date.now() });
    this.worlds = [normalized, ...this.worlds.filter((entry) => entry.id !== normalized.id)];
    await saveWorldToDb(normalized);
    return normalized;
  }

  async remove(id: string) {
    this.worlds = this.worlds.filter((entry) => entry.id !== id);
    await deleteWorldFromDb(id);
  }
}

export const worldsStore = new WorldsStore();
