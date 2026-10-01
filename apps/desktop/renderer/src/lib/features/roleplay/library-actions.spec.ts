// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { confirmStore } from '$lib/stores/confirm.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { ChatSession } from '$lib/types/chat';
import { charactersStore, emptyCharacter } from './characters.svelte';
import { emptyWorld, worldsStore } from './worlds.svelte';
import { deleteCharacter, deleteWorld, duplicateWorld, usageLine } from './library-actions.svelte';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('roleplay library actions', () => {
  beforeEach(() => {
    localStorage.clear();
    toastStore.toasts = [];
    charactersStore.characters = [];
    worldsStore.worlds = [];
    appStore.chats = [];
  });

  it('names what a delete touches', () => {
    expect(usageLine(1, 3)).toBe('Used in 1 world and 3 scenes.');
    expect(usageLine(0, 1)).toBe('Used in 1 scene.');
    expect(usageLine(0, 0)).toBe('');
  });

  it('deletes a character, takes them out of world casts, and Undo puts both back', async () => {
    const mira = emptyCharacter({ id: 'char-mira', name: 'Mira' });
    const world = emptyWorld({ id: 'world-ash', name: 'Ashgrove', castIds: ['char-mira', 'char-other'] });
    charactersStore.characters = [mira];
    worldsStore.worlds = [world];
    appStore.chats = [{ id: 'c1', characterId: 'char-mira' } as ChatSession];

    deleteCharacter(mira);
    expect(confirmStore.options?.message).toContain('Used in 1 world and 1 scene.');
    confirmStore.confirm();
    await settle();

    expect(charactersStore.getById('char-mira')).toBeNull();
    expect(worldsStore.getById('world-ash')?.castIds).toEqual(['char-other']);

    toastStore.toasts.at(-1)?.action?.run();
    await settle();
    expect(charactersStore.getById('char-mira')?.name).toBe('Mira');
    expect(worldsStore.getById('world-ash')?.castIds).toEqual(['char-mira', 'char-other']);
  });

  it('Undo is offered once: a second click does nothing', async () => {
    const world = emptyWorld({ id: 'world-1', name: 'Eldoria' });
    worldsStore.worlds = [world];
    deleteWorld(world);
    confirmStore.confirm();
    await settle();
    const undo = toastStore.toasts.at(-1)?.action?.run;
    undo?.();
    expect(toastStore.toasts).toHaveLength(0);
    undo?.();
    await settle();
    expect(worldsStore.worlds.filter((entry) => entry.id === 'world-1')).toHaveLength(1);
  });

  it('duplicates a world under a new id', async () => {
    const world = emptyWorld({ id: 'world-1', name: 'Eldoria', castIds: ['a'] });
    worldsStore.worlds = [world];
    const copy = await duplicateWorld(world);
    expect(copy.id).not.toBe('world-1');
    expect(copy.name).toBe('Eldoria (copy)');
    expect(copy.castIds).toEqual(['a']);
    expect(worldsStore.worlds).toHaveLength(2);
  });
});
