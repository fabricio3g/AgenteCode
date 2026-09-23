// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { charactersStore } from '$lib/features/roleplay/characters.svelte';
import { worldsStore, emptyWorld } from '$lib/features/roleplay/worlds.svelte';
import { emptyCharacter } from '$lib/services/character-card';

/**
 * End-to-end wiring check for the roleplay prompt: card in the store →
 * startRoleplay binds it → the system prompt the send path builds contains
 * the card's fields (not the assistant prompt).
 */
describe('roleplay prompt wiring', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    worldsStore.worlds = [];
    appStore.chats = [];
  });

  it('binds the card to the chat and seeds the greeting', async () => {
    const card = emptyCharacter({
      name: 'Aiko',
      description: '{{char}} is a barista.',
      firstMessage: '"You again?"'
    });
    await charactersStore.save(card);

    const chat = appStore.startRoleplay(card);

    expect(chat.contextMode).toBe('roleplay');
    expect(chat.characterId).toBe(card.id);
    expect(chat.messages[0]?.content).toBe('"You again?"');
    expect(chat.messages[0]?.speakerId).toBe(card.id);
  });

  it('builds the system prompt from the bound card, never the assistant prompt', async () => {
    const card = emptyCharacter({
      name: 'Aiko',
      description: 'Aiko is a barista who works nights.',
      personality: 'Sarcastic but kind.',
      scenario: 'The cafe is closing.',
      firstMessage: 'Hello.'
    });
    await charactersStore.save(card);
    const chat = appStore.startRoleplay(card);

    const buildPrompt = (appStore as unknown as {
      buildRoleplaySystemPrompt: (chat: unknown) => string;
    }).buildRoleplaySystemPrompt.bind(appStore);
    const prompt = buildPrompt(chat);

    expect(prompt).toContain('Aiko is a barista who works nights.');
    expect(prompt).toContain('Sarcastic but kind.');
    expect(prompt).toContain('The cafe is closing.');
    expect(prompt).toContain("Write Aiko's next reply");
    expect(prompt).not.toContain('Flaxeo Chat');
  });

  it('binds the current empty roleplay chat instead of creating another', async () => {
    const card = emptyCharacter({ name: 'Aiko', firstMessage: 'Hi.' });
    await charactersStore.save(card);

    const empty = appStore.createChat('roleplay');
    const before = appStore.visibleRoleplayChats.length;

    const chat = appStore.startRoleplay(card);

    expect(chat.id).toBe(empty.id);
    expect(appStore.visibleRoleplayChats.length).toBe(before);
  });

  it('starts a new chat when the current roleplay chat is already in use', async () => {
    const card = emptyCharacter({ name: 'Ren', firstMessage: 'Hello.' });
    await charactersStore.save(card);

    const first = appStore.startRoleplay(card);
    const second = appStore.startRoleplay(card);

    expect(second.id).not.toBe(first.id);
  });

  it('starts on the selected greeting', async () => {
    const card = emptyCharacter({
      name: 'Ren',
      firstMessage: 'First.',
      alternateGreetings: ['Second.', 'Third.']
    });
    await charactersStore.save(card);

    const chat = appStore.startRoleplay(card, { greetingIndex: 1 });

    expect(chat.greetingIndex).toBe(1);
    expect(chat.messages[0]?.content).toBe('Second.');
  });
});

describe('world scene wiring', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    worldsStore.worlds = [];
    appStore.chats = [];
  });

  it('binds the world, the ordered cast and a world opening', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', firstMessage: 'Hi.' });
    const ren = emptyCharacter({ name: 'Ren', firstMessage: 'Yo.' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);
    const world = emptyWorld({
      name: 'Eldoria',
      castIds: [ren.id, aiko.id],
      starters: ['The lanterns rise over the harbor.']
    });

    const chat = appStore.startScene({
      characters: [ren, aiko],
      world,
      openingSource: 'starter',
      openingIndex: 0
    });

    expect(chat?.worldId).toBe(world.id);
    expect(chat?.characterId).toBe(ren.id);
    expect(chat?.roleplay?.characterIds).toEqual([ren.id, aiko.id]);
    expect(chat?.messages[0]?.content).toBe('The lanterns rise over the harbor.');
    // A world starter is narration: no speaker is attributed to it.
    expect(chat?.messages[0]?.speakerId).toBeNull();
    expect(chat?.greetingIndex).toBe(0);
  });

  it('puts world canon and world lore into the system prompt', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', firstMessage: 'Hi.' });
    await charactersStore.save(aiko);
    const world = emptyWorld({
      name: 'Eldoria',
      overview: 'A floating city above a drowned world.',
      scenario: 'The festival begins tonight.',
      book: {
        name: 'Eldoria',
        scanDepth: 4,
        tokenBudget: 1024,
        entries: [
          {
            id: 'lore-1',
            keys: [],
            constant: true,
            content: 'The city drifts west with the storm.',
            enabled: true,
            insertionOrder: 1
          }
        ]
      }
    });
    await worldsStore.save(world);
    const chat = appStore.startScene({ characters: [aiko], world, openingSource: 'greeting', openingIndex: 0 });

    const buildPrompt = (appStore as unknown as {
      buildRoleplaySystemPrompt: (chat: unknown) => string;
    }).buildRoleplaySystemPrompt.bind(appStore);
    const prompt = buildPrompt(chat);

    expect(prompt).toContain('## Eldoria\nA floating city above a drowned world.');
    expect(prompt).toContain('The festival begins tonight.');
    expect(prompt).toContain('The city drifts west with the storm.');
  });

  it('prefers a cast card scenario over the world scenario', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', scenario: 'Aiko is closing the cafe.' });
    await charactersStore.save(aiko);
    const world = emptyWorld({ name: 'Eldoria', scenario: 'The festival begins tonight.' });
    await worldsStore.save(world);
    const chat = appStore.startScene({ characters: [aiko], world });

    const buildPrompt = (appStore as unknown as {
      buildRoleplaySystemPrompt: (chat: unknown) => string;
    }).buildRoleplaySystemPrompt.bind(appStore);
    const prompt = buildPrompt(chat);

    expect(prompt).toContain('Aiko is closing the cafe.');
    expect(prompt).not.toContain('The festival begins tonight.');
  });

  it('starts a group scene with the primary speaker only', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', firstMessage: 'Evening.' });
    const ren = emptyCharacter({ name: 'Ren', firstMessage: 'Yo.' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);

    const chat = appStore.startScene({
      characters: [aiko, ren],
      openingSource: 'greeting',
      openingIndex: 0
    });

    expect(chat?.roleplay?.characterIds).toEqual([aiko.id, ren.id]);
    expect(chat?.title).toBe('Aiko +1');
    expect(chat?.messages[0]?.content).toBe('Evening.');
    expect(chat?.messages[0]?.speakerId).toBe(aiko.id);
  });

  it('starts with no opening when neither world nor card provides one', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    await charactersStore.save(aiko);

    const chat = appStore.startScene({ characters: [aiko] });

    expect(chat?.messages.length).toBe(0);
  });

  it('starts with no opening when the user chooses none', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', firstMessage: 'Hello.' });
    await charactersStore.save(aiko);

    const chat = appStore.startScene({ characters: [aiko], openingSource: 'none' });

    expect(chat?.messages.length).toBe(0);
  });

  it('honors the world defaults for speaker order and auto mode', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    const ren = emptyCharacter({ name: 'Ren' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);
    const world = emptyWorld({
      name: 'Eldoria',
      settings: { autoMode: true, replyOrder: 'natural', autoModeMaxTurns: 6, autoModeDelayMs: 12000, adventureChoices: true }
    });

    const chat = appStore.startScene({ characters: [aiko, ren], world, openingSource: 'none' });

    expect(chat?.roleplay?.autoMode).toBe(true);
    expect(chat?.roleplay?.replyOrder).toBe('natural');
    expect(chat?.roleplay?.autoModeMaxTurns).toBe(6);
    expect(chat?.roleplay?.autoModeDelayMs).toBe(12000);
    expect(chat?.roleplay?.adventureChoices).toBe(true);
  });

  it('defaults the auto delay to eight seconds without a world', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    await charactersStore.save(aiko);

    const chat = appStore.startScene({ characters: [aiko], openingSource: 'none' });

    expect(chat?.roleplay?.autoModeDelayMs).toBe(8000);
    expect(chat?.roleplay?.adventureChoices).toBe(false);
  });
});

describe('mid-scene cast editing', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    worldsStore.worlds = [];
    appStore.chats = [];
  });

  it('edits the cast and promotes a new primary when the old one leaves', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    const ren = emptyCharacter({ name: 'Ren' });
    const yuki = emptyCharacter({ name: 'Yuki' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);
    await charactersStore.save(yuki);

    const chat = appStore.startScene({ characters: [aiko, ren], openingSource: 'none' });
    appStore.toggleRoleplayMute(ren.id);
    appStore.setRoleplayCast([ren.id, yuki.id]);

    expect(chat?.characterId).toBe(ren.id);
    expect(chat?.roleplay?.characterIds).toEqual([ren.id, yuki.id]);
    expect(chat?.roleplay?.mutedIds).toEqual([ren.id]);
  });

  it('ignores unknown ids and drops muted members that left', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    const ren = emptyCharacter({ name: 'Ren' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);

    const chat = appStore.startScene({ characters: [aiko, ren], openingSource: 'none' });
    appStore.toggleRoleplayMute(ren.id);
    appStore.setRoleplayCast([aiko.id, 'char-missing']);

    expect(chat?.roleplay?.characterIds).toEqual([aiko.id]);
    expect(chat?.roleplay?.mutedIds).toEqual([]);
  });

  it('refuses an empty cast', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    await charactersStore.save(aiko);
    const chat = appStore.startScene({ characters: [aiko], openingSource: 'none' });

    appStore.setRoleplayCast([]);

    expect(chat?.roleplay?.characterIds).toEqual([aiko.id]);
  });
});
