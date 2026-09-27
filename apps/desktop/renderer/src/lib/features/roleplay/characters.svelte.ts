import type { CharacterCard, UserPersona } from '$lib/types/chat';
import {
  loadCharactersFromDb,
  saveCharacterToDb,
  deleteCharacterFromDb,
  loadPersonasFromDb,
  savePersonaToDb,
  deletePersonaFromDb
} from '$lib/utils/storage';
import { createId } from '$lib/utils/id';
import { mergeById } from '$lib/utils/merge';
import { emptyCharacter, greetingsFor, normalizeCharacterCard } from '$lib/services/character-card';

// Re-exported so feature code keeps importing card helpers from one place.
export { emptyCharacter, greetingsFor, normalizeCharacterCard };

/**
 * Character & persona library.
 *
 * The store owns the in-memory list and writes through to SQLite (Electron)
 * or localStorage (browser dev). Cards are stored as whole objects; the DB
 * keeps id/name columns only for listing and ordering.
 */

export function emptyPersona(overrides: Partial<UserPersona> = {}): UserPersona {
  const now = Date.now();
  return {
    id: createId('persona'),
    name: '',
    description: '',
    avatar: '',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

class CharactersStore {
  characters = $state<CharacterCard[]>([]);
  personas = $state<UserPersona[]>([]);
  loaded = $state(false);

  async load() {
    const [characters, personas] = await Promise.all([loadCharactersFromDb(), loadPersonasFromDb()]);
    // Merge instead of replace: a card saved while this query was in flight
    // must not be dropped from the store (it is already in the database).
    this.characters = mergeById(this.characters, characters.map((card) => normalizeCharacterCard(card)));
    this.personas = mergeById(this.personas, personas);
    this.loaded = true;
  }

  getById(id: string | null | undefined): CharacterCard | null {
    if (!id) return null;
    return this.characters.find((card) => card.id === id) || null;
  }

  getPersonaById(id: string | null | undefined): UserPersona | null {
    if (!id) return null;
    return this.personas.find((persona) => persona.id === id) || null;
  }

  get defaultPersona(): UserPersona | null {
    return this.personas.find((persona) => persona.isDefault) || null;
  }

  async save(card: CharacterCard) {
    const normalized = normalizeCharacterCard({ ...card, updatedAt: Date.now() });
    this.characters = [normalized, ...this.characters.filter((entry) => entry.id !== normalized.id)];
    await saveCharacterToDb(normalized);
    return normalized;
  }

  async remove(id: string) {
    this.characters = this.characters.filter((entry) => entry.id !== id);
    await deleteCharacterFromDb(id);
  }

  async savePersona(persona: UserPersona) {
    const normalized: UserPersona = { ...persona, updatedAt: Date.now() };
    // Exactly one default persona.
    if (normalized.isDefault) {
      this.personas = this.personas.map((entry) => ({ ...entry, isDefault: false }));
    }
    this.personas = [normalized, ...this.personas.filter((entry) => entry.id !== normalized.id)];
    await savePersonaToDb(normalized);
    if (normalized.isDefault) {
      await Promise.all(
        this.personas
          .filter((entry) => entry.id !== normalized.id && entry.isDefault)
          .map((entry) => savePersonaToDb({ ...entry, isDefault: false }))
      );
    }
    return normalized;
  }

  async removePersona(id: string) {
    this.personas = this.personas.filter((entry) => entry.id !== id);
    await deletePersonaFromDb(id);
  }
}

export const charactersStore = new CharactersStore();
