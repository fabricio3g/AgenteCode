// Delete and duplicate for the roleplay library, shared by the galleries and
// the editors. A delete asks first (naming what it touches), happens at once,
// and offers Undo for a few seconds, which writes everything back.

import type { CharacterCard, ChatSession, RoleplayWorld, UserPersona } from '$lib/types/chat';
import { appStore } from '$lib/stores/app.svelte';
import { confirmStore } from '$lib/stores/confirm.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { createId } from '$lib/utils/id';
import { charactersStore } from './characters.svelte';
import { worldsStore } from './worlds.svelte';

function usesCharacter(chat: ChatSession, id: string): boolean {
  return chat.characterId === id || !!chat.roleplay?.characterIds?.includes(id);
}

/** "Used in 2 worlds and 3 scenes." — or nothing when it is used nowhere. */
export function usageLine(worlds: number, scenes: number): string {
  const parts = [
    worlds ? `${worlds} ${worlds === 1 ? 'world' : 'worlds'}` : '',
    scenes ? `${scenes} ${scenes === 1 ? 'scene' : 'scenes'}` : ''
  ].filter(Boolean);
  return parts.length ? `Used in ${parts.join(' and ')}.` : '';
}

export function deleteCharacter(card: CharacterCard, onDeleted?: () => void): void {
  const name = card.name || 'this character';
  const worlds = worldsStore.worlds.filter((world) => world.castIds.includes(card.id));
  const scenes = appStore.chats.filter((chat) => usesCharacter(chat, card.id)).length;
  confirmStore.show({
    title: `Delete ${name}?`,
    message: [
      usageLine(worlds.length, scenes),
      worlds.length ? 'They leave those casts.' : '',
      scenes ? 'Past scenes keep their messages, without this character’s name and picture.' : ''
    ].filter(Boolean).join(' ') || 'The card is removed from your library.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      await charactersStore.remove(card.id);
      await Promise.all(worlds.map((world) => worldsStore.save({ ...world, castIds: world.castIds.filter((id) => id !== card.id) })));
      onDeleted?.();
      toastStore.undoable(`Deleted ${name}`, () => {
        void charactersStore.save(card);
        for (const world of worlds) void worldsStore.save(world);
      });
    }
  });
}

export function deleteWorld(world: RoleplayWorld, onDeleted?: () => void): void {
  const name = world.name || 'this world';
  const scenes = appStore.chats.filter((chat) => chat.worldId === world.id).length;
  confirmStore.show({
    title: `Delete ${name}?`,
    message: scenes
      ? `${usageLine(0, scenes)} They keep running, without this world’s lore and openings.`
      : 'Its lorebook and openings go with it. Characters in its cast stay in your library.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      await worldsStore.remove(world.id);
      onDeleted?.();
      toastStore.undoable(`Deleted ${name}`, () => void worldsStore.save(world));
    }
  });
}

export function deletePersona(persona: UserPersona, onDeleted?: () => void): void {
  const name = persona.name || 'this persona';
  confirmStore.show({
    title: `Delete ${name}?`,
    message: 'Scenes keep running; they simply lose this persona.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      await charactersStore.removePersona(persona.id);
      onDeleted?.();
      toastStore.undoable(`Deleted ${name}`, () => void charactersStore.savePersona(persona));
    }
  });
}

const copyName = (name: string) => `${name || 'Untitled'} (copy)`;

export function duplicateCharacter(card: CharacterCard): Promise<CharacterCard> {
  const now = Date.now();
  return charactersStore.save({ ...$state.snapshot(card), id: createId('char'), name: copyName(card.name), createdAt: now, updatedAt: now });
}

export function duplicateWorld(world: RoleplayWorld): Promise<RoleplayWorld> {
  const now = Date.now();
  return worldsStore.save({ ...$state.snapshot(world), id: createId('world'), name: copyName(world.name), createdAt: now, updatedAt: now });
}

export function duplicatePersona(persona: UserPersona): Promise<UserPersona> {
  const now = Date.now();
  return charactersStore.savePersona({ ...$state.snapshot(persona), id: createId('persona'), name: copyName(persona.name), isDefault: false, createdAt: now, updatedAt: now });
}
