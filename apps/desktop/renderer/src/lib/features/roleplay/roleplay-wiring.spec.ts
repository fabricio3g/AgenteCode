// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
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

    const chat = roleplayStore.startSolo(card);

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
    const chat = roleplayStore.startSolo(card);

    const prompt = roleplayStore.systemPrompt(chat);

    expect(prompt).toContain('Aiko is a barista who works nights.');
    expect(prompt).toContain('Sarcastic but kind.');
    expect(prompt).toContain('The cafe is closing.');
    expect(prompt).toContain("Write Aiko's next reply");
    expect(prompt).not.toContain('normal assistant style');
  });

  it('binds the current empty roleplay chat instead of creating another', async () => {
    const card = emptyCharacter({ name: 'Aiko', firstMessage: 'Hi.' });
    await charactersStore.save(card);

    const empty = appStore.createChat('roleplay');
    const before = appStore.visibleRoleplayChats.length;

    const chat = roleplayStore.startSolo(card);

    expect(chat.id).toBe(empty.id);
    expect(appStore.visibleRoleplayChats.length).toBe(before);
  });

  it('starts a new chat when the current roleplay chat is already in use', async () => {
    const card = emptyCharacter({ name: 'Ren', firstMessage: 'Hello.' });
    await charactersStore.save(card);

    const first = roleplayStore.startSolo(card);
    const second = roleplayStore.startSolo(card);

    expect(second.id).not.toBe(first.id);
  });

  it('starts on the selected greeting', async () => {
    const card = emptyCharacter({
      name: 'Ren',
      firstMessage: 'First.',
      alternateGreetings: ['Second.', 'Third.']
    });
    await charactersStore.save(card);

    const chat = roleplayStore.startSolo(card, { greetingIndex: 1 });

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

    const chat = roleplayStore.startScene({
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
    const chat = roleplayStore.startScene({ characters: [aiko], world, openingSource: 'greeting', openingIndex: 0 });

    const prompt = roleplayStore.systemPrompt(chat);

    expect(prompt).toContain('## Eldoria\nA floating city above a drowned world.');
    expect(prompt).toContain('The festival begins tonight.');
    expect(prompt).toContain('The city drifts west with the storm.');
  });

  it('prefers a cast card scenario over the world scenario', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', scenario: 'Aiko is closing the cafe.' });
    await charactersStore.save(aiko);
    const world = emptyWorld({ name: 'Eldoria', scenario: 'The festival begins tonight.' });
    await worldsStore.save(world);
    const chat = roleplayStore.startScene({ characters: [aiko], world });

    const prompt = roleplayStore.systemPrompt(chat);

    expect(prompt).toContain('Aiko is closing the cafe.');
    expect(prompt).not.toContain('The festival begins tonight.');
  });

  it('starts a group scene with the primary speaker only', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', firstMessage: 'Evening.' });
    const ren = emptyCharacter({ name: 'Ren', firstMessage: 'Yo.' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);

    const chat = roleplayStore.startScene({
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

    const chat = roleplayStore.startScene({ characters: [aiko] });

    expect(chat?.messages.length).toBe(0);
  });

  it('starts with no opening when the user chooses none', async () => {
    const aiko = emptyCharacter({ name: 'Aiko', firstMessage: 'Hello.' });
    await charactersStore.save(aiko);

    const chat = roleplayStore.startScene({ characters: [aiko], openingSource: 'none' });

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
    await worldsStore.save(world);

    const chat = roleplayStore.startScene({ characters: [aiko, ren], world, openingSource: 'none' });

    expect(roleplayStore.settings(chat).autoMode).toBe(true);
    expect(roleplayStore.settings(chat).replyOrder).toBe('natural');
    expect(roleplayStore.settings(chat).autoModeMaxTurns).toBe(6);
    expect(roleplayStore.settings(chat).autoModeDelayMs).toBe(12000);
    expect(roleplayStore.settings(chat).adventureChoices).toBe(true);
  });

  it('defaults the auto delay to eight seconds without a world', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    await charactersStore.save(aiko);

    const chat = roleplayStore.startScene({ characters: [aiko], openingSource: 'none' });

    expect(roleplayStore.settings(chat).autoModeDelayMs).toBe(8000);
    expect(roleplayStore.settings(chat).adventureChoices).toBe(false);
  });
});

describe('Chat / Dynamic integration', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    worldsStore.worlds = [];
    appStore.chats = [];
    appStore.activeRunsByChat = {};
    appStore.composer = '';
  });

  async function start() {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko' });
    const ren = emptyCharacter({ id: 'ren', name: 'Ren', description: '{{char}} speaks softly.' });
    await charactersStore.save(aiko); await charactersStore.save(ren);
    return roleplayStore.startScene({ characters: [aiko, ren], openingSource: 'none' })!;
  }

  it('starts Chat by default and permits ensemble replies only when invited', async () => {
    const scene = await start();
    expect(roleplayStore.settings(scene).interactionMode).toBe('chat');
    expect(roleplayStore.systemPrompt(scene)).toContain('Chat mode is always dialogue-only');
    expect(roleplayStore.systemPrompt(scene)).toContain('Ren speaks softly.');
    scene.messages.push({ id: 'invite', role: 'user', content: 'Talk to each other.', createdAt: 1 });
    const turn = roleplayStore.prepareTurn(scene);
    expect(turn.decorate([{ role: 'user', content: 'Talk to each other.' }]).at(-1)?.content).toContain('one response');
    expect(turn.stop).not.toContain('\nRen:');
    expect(turn.snapshot?.participantIds).toEqual(['aiko', 'ren']);
    roleplayStore.setOption('npcDialogue', false);
    const solo = roleplayStore.prepareTurn(scene);
    expect(solo.decorate([]).at(-1)?.content).toContain('only Aiko');
    expect(solo.stop).toContain('\nRen:');
  });

  it('keeps a targeted Dynamic reply exclusive through streaming, finalization and Retry', async () => {
    const scene = await start();
    roleplayStore.setOption('interactionMode', 'dynamic');
    scene.messages.push({ id: 'question', role: 'user', content: 'Ren, what do you think about Aiko?', createdAt: 1 });
    roleplayStore.routeTurn(scene, scene.messages);
    const turn = roleplayStore.prepareTurn(scene, { consumeRouting: true });
    expect(turn.speakerId).toBe('ren');
    expect(turn.snapshot?.participantIds).toEqual(['ren']);
    expect(turn.decorate([]).at(-1)?.content).toContain('Ren only');
    const raw = 'Narrator: Rain falls.\nRen: Aiko is kind.\nAiko: Thank you.\nRen: Very kind.';
    expect(turn.sanitize?.(raw)).not.toContain('Aiko:');
    turn.record(raw);
    const target = { content: raw };
    turn.finalize(target);
    const retry = roleplayStore.prepareTurn(scene, { snapshot: turn.snapshot, speakerId: 'aiko' });
    expect(retry.speakerId).toBe('ren');
    expect(retry.snapshot?.participantIds).toEqual(['ren']);
  });

  it('routes only present characters, including scene-local NPCs, and keeps preview stable', async () => {
    const scene = await start();
    roleplayStore.setScene({ ...roleplayStore.room(), presentIds: ['ren'] });
    expect(roleplayStore.peekSpeaker()?.id).toBe('ren');
    expect(roleplayStore.routeTurn(scene, scene.messages)).toBe(true);
    expect(roleplayStore.prepareTurn(scene).speakerId).toBe('ren');
    roleplayStore.setScene({ ...roleplayStore.room(), presentIds: [], npcs: [{ id: 'npc-mira', name: 'Mira', description: 'A practical dockhand.' }] });
    expect(roleplayStore.routeTurn(scene, [{ id: 'u', role: 'user', content: '@Mira, help?', createdAt: 1 }])).toBe(true);
    const turn = roleplayStore.prepareTurn(scene);
    expect(turn.speakerId).toBe('npc-mira');
    expect(roleplayStore.systemPrompt(scene, turn.speakerId)).toContain('npc-mira: Mira — present');
    expect(roleplayStore.peekSpeaker()?.id).toBe('npc-mira');
  });

  it('suggestions fill a draft without starting generation', async () => {
    await start();
    const send = vi.spyOn(appStore, 'sendCurrentMessage');
    await roleplayStore.sendChoice('I ask Ren about the letter.');
    expect(appStore.composer).toBe('I ask Ren about the letter.');
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it('carries world timers and props through the shared settings resolver', async () => {
    const character = emptyCharacter({ name: 'Ren' });
    await charactersStore.save(character);
    const world = emptyWorld({ settings: { props: true, choiceTimerSeconds: 60, interactionMode: 'dynamic' } });
    await worldsStore.save(world);
    const scene = roleplayStore.startScene({ characters: [character], world, settings: { choiceTimerSeconds: 0 } })!;
    const settings = roleplayStore.settings(scene);
    expect(settings.props).toBe(true);
    expect(settings.choiceTimerSeconds).toBe(0);
    expect(settings.interactionMode).toBe('dynamic');
    // Only the scene's own choice is stored; the rest is inherited.
    expect(scene.roleplay?.choiceTimerSeconds).toBe(0);
    expect(scene.roleplay).not.toHaveProperty('props');
  });

  it('saves options as overrides and keeps room and journal changes made meanwhile', async () => {
    const scene = await start();
    const draft = { ...scene.roleplay, interactionMode: 'dynamic' as const, replyLength: 'adaptive' as const };
    scene.roleplay = { ...scene.roleplay, journal: [{ id: 'j', kind: 'note', title: 'Kept', body: '', pinned: false, createdAt: 1 }] } as typeof scene.roleplay;
    roleplayStore.setSettings(draft);
    expect(scene.roleplay?.interactionMode).toBe('dynamic');
    expect(scene.roleplay).not.toHaveProperty('replyLength');
    expect(scene.roleplay?.journal?.[0]?.title).toBe('Kept');
    expect(scene.roleplay?.characterIds).toEqual(['aiko', 'ren']);
  });

  it('switches response versions in place and branches only when asked', async () => {
    const scene = await start();
    roleplayStore.setOption('interactionMode', 'dynamic');
    const turn = roleplayStore.prepareTurn(scene);
    const first = { id: 'response', role: 'assistant' as const, content: 'At the harbor.', createdAt: 2, done: true, status: 'idle' as const, versions: [], activeVersion: 0 };
    turn.finalize(first);
    const snapshot = turn.snapshot!;
    const firstState = { ...snapshot, settled: true, sceneAfter: { ...snapshot.sceneBefore, location: 'Harbor' } };
    const secondState = { ...firstState, sceneAfter: { ...snapshot.sceneBefore, location: 'Forest' } };
    appStore.appendMessageToChat(scene.id, { ...first, metadata: { roleplay: firstState }, versions: [{ content: 'Harbor', createdAt: 2, metadata: { roleplay: firstState } }, { content: 'Forest', createdAt: 3, metadata: { roleplay: secondState } }] });
    appStore.appendMessageToChat(scene.id, { id: 'later', role: 'user', content: 'Where now?', createdAt: 4 });
    const before = appStore.chats.length;
    appStore.setMessageActiveVersion('response', 1);
    expect(roleplayStore.room().location).toBe('Forest');
    expect(appStore.currentChat?.messages).toHaveLength(2);
    expect(appStore.chats).toHaveLength(before);
    appStore.branchFromMessage('response');
    expect(appStore.chats).toHaveLength(before + 1);
    const branch = appStore.currentChat!;
    expect(branch.id).not.toBe(scene.id);
    expect(branch.messages).toHaveLength(1);
    expect(branch.messages[0].activeVersion).toBe(1);
    expect(branch.messages[0].id).not.toBe('response');
    expect(appStore.chats.find((entry) => entry.id === scene.id)?.messages).toHaveLength(2);
    appStore.selectChat(scene.id);
    const retry = roleplayStore.prepareTurn(scene, { snapshot: secondState, historyEnd: 0 });
    expect(retry.snapshot?.seed).toBe(secondState.seed);
    expect(retry.snapshot?.direction).toBe(secondState.direction);
    expect(retry.snapshot?.settled).toBe(false);
    expect(retry.snapshot?.sceneAfter).toEqual(secondState.sceneBefore);
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

    const chat = roleplayStore.startScene({ characters: [aiko, ren], openingSource: 'none' });
    roleplayStore.toggleMute(ren.id);
    roleplayStore.setCast([ren.id, yuki.id]);

    expect(chat?.characterId).toBe(ren.id);
    expect(chat?.roleplay?.characterIds).toEqual([ren.id, yuki.id]);
    expect(chat?.roleplay?.mutedIds).toEqual([ren.id]);
  });

  it('ignores unknown ids and drops muted members that left', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    const ren = emptyCharacter({ name: 'Ren' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);

    const chat = roleplayStore.startScene({ characters: [aiko, ren], openingSource: 'none' });
    roleplayStore.toggleMute(ren.id);
    roleplayStore.setCast([aiko.id, 'char-missing']);

    expect(chat?.roleplay?.characterIds).toEqual([aiko.id]);
    expect(chat?.roleplay?.mutedIds).toEqual([]);
  });

  it('refuses an empty cast', async () => {
    const aiko = emptyCharacter({ name: 'Aiko' });
    await charactersStore.save(aiko);
    const chat = roleplayStore.startScene({ characters: [aiko], openingSource: 'none' });

    roleplayStore.setCast([]);

    expect(chat?.roleplay?.characterIds).toEqual([aiko.id]);
  });
});
