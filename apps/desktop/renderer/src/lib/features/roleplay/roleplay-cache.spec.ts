// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat/types';
import { appStore } from '$lib/stores/app.svelte';
import { roleplayStore } from './roleplay.svelte';
import { charactersStore } from './characters.svelte';
import { worldsStore } from './worlds.svelte';
import { emptyCharacter } from '$lib/services/character-card';
import type { RoleplayTurn } from './roleplay-turn';

/*
 * The send path through the real store: the stable block of a group chat must
 * stay byte-identical across turns and speakers, and the turn's used record
 * must name what the prompt carried.
 */

/** The history as the send path hands it to the turn: role and text only. */
function asRequest(messages: ChatMessage[]): RequestMessage[] {
  return messages.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }));
}

function stableOf(turn: RoleplayTurn, history: RequestMessage[] = []): string {
  const first = turn.compose(history).messages[0];
  return typeof first?.content === 'string' ? first.content : '';
}

function reply(id: string, content: string, speakerId: string): ChatMessage {
  return { id, role: 'assistant', content, createdAt: 2, done: true, status: 'idle', speakerId, versions: [], activeVersion: 0 } as ChatMessage;
}

describe('roleplay send path: prompt stability', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    worldsStore.worlds = [];
    appStore.chats = [];
    appStore.activeRunsByChat = {};
    appStore.composer = '';
  });

  async function groupScene() {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko', description: 'Aiko runs the bakery.', scenario: 'Early morning at the bakery.', exampleDialogue: '<START>\n{{user}}: Morning\n{{char}}: Flour everywhere.' });
    const ren = emptyCharacter({ id: 'ren', name: 'Ren', description: 'Ren delivers the milk.', scenario: 'Ren is late with the milk.', exampleDialogue: '<START>\n{{user}}: Hi\n{{char}}: Milk first.' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);
    return roleplayStore.startScene({ characters: [aiko, ren], openingSource: 'none' })!;
  }

  it('keeps the stable block identical across turns and speakers, and names the speaker only in the tail', async () => {
    const scene = await groupScene();
    const first = roleplayStore.prepareTurn(scene, { speakerId: 'aiko' });
    const stable = stableOf(first);
    expect(stable).toContain('Early morning at the bakery.');
    expect(stable).not.toContain('Ren is late with the milk.');
    expect(stable).not.toContain('Milk first.');

    scene.messages.push(
      { id: 'u1', role: 'user', content: 'Hello there.', createdAt: 1, done: true, status: 'idle', versions: [], activeVersion: 0 } as ChatMessage,
      reply('a1', 'Good morning.', 'aiko'),
      { id: 'u2', role: 'user', content: 'And you?', createdAt: 3, done: true, status: 'idle', versions: [], activeVersion: 0 } as ChatMessage
    );
    const second = roleplayStore.prepareTurn(scene, { speakerId: 'ren' });
    const history = asRequest(scene.messages.slice(0, -1));
    expect(stableOf(second, history)).toBe(stable);

    const request = second.compose(history).messages;
    expect(request.at(-1)?.content).toContain("Ren's reply");
    expect(request.at(-1)?.content).not.toContain("Aiko's reply");
  });

  it('keeps the stable block identical when the story so far and the lore change', async () => {
    const scene = await groupScene();
    const before = stableOf(roleplayStore.prepareTurn(scene, { speakerId: 'aiko' }));
    roleplayStore.addJournalEntry({ kind: 'note', title: 'Oath', body: 'Sam swore to find the bell.', pinned: true });
    scene.roleplay = { ...scene.roleplay, storySummary: { text: 'Sam came to the bakery at dawn.', throughId: null, updatedAt: 1 } } as typeof scene.roleplay;
    const after = roleplayStore.prepareTurn(scene, { speakerId: 'aiko' });
    expect(stableOf(after)).toBe(before);
    expect(after.compose([]).messages.some((message) => String(message.content).includes('Sam swore to find the bell.'))).toBe(true);
  });

  it('reports the pinned journal entries and the summary the turn drew on', async () => {
    const scene = await groupScene();
    roleplayStore.addJournalEntry({ kind: 'note', title: 'Oath', body: 'Sam swore to find the bell.', pinned: true });
    const journalId = scene.roleplay?.journal?.[0]?.id;
    expect(journalId).toBeTruthy();
    scene.roleplay = { ...scene.roleplay, storySummary: { text: 'Sam came to the bakery at dawn.', throughId: null, updatedAt: 1 } } as typeof scene.roleplay;

    const turn = roleplayStore.prepareTurn(scene, { speakerId: 'aiko' });
    const { used } = turn.compose([]);
    expect(used.journal).toEqual([journalId]);
    expect(used.memories).toContain('summary');
    expect(used.trimmed).toEqual([]);
  });

  it('reports the lore entries that fired in the scene text', async () => {
    const bell = emptyCharacter({
      id: 'bell-keeper',
      name: 'Keeper',
      book: { entries: [{ id: 'lore-bell', keys: ['bakery'], content: 'The bakery bell rings at six.', enabled: true, constant: true, insertionOrder: 100 }] } as never
    });
    await charactersStore.save(bell);
    const scene = roleplayStore.startScene({ characters: [bell], openingSource: 'none' })!;
    const turn = roleplayStore.prepareTurn(scene);
    expect(turn.compose([]).used.lore).toEqual(['lore-bell']);
    expect(stableOf(turn)).not.toContain('The bakery bell rings at six.');
    expect(turn.compose([]).messages.some((message) => String(message.content).includes('The bakery bell rings at six.'))).toBe(true);
  });

  it('keeps the recall honest: only the lore the budget kept, and what it trimmed', async () => {
    const bell = emptyCharacter({
      id: 'bell-keeper',
      name: 'Keeper',
      book: { entries: [
        { id: 'lore-a', keys: ['bakery'], content: 'Alpha fact.', enabled: true, constant: true, insertionOrder: 100 },
        { id: 'lore-b', keys: ['bakery'], content: 'Bravo fact.', enabled: true, constant: true, insertionOrder: 200 }
      ] } as never
    });
    await charactersStore.save(bell);
    const scene = roleplayStore.startScene({ characters: [bell], openingSource: 'none' })!;
    const turn = roleplayStore.prepareTurn(scene);
    expect(turn.snapshot?.recall?.lore.map((entry) => entry.id)).toEqual(['lore-a', 'lore-b']);

    const trimmed = turn.compose([], { loreLimit: 1 });
    turn.noteUsed(trimmed.used);
    expect(turn.snapshot?.recall?.lore.map((entry) => entry.id)).toEqual(['lore-a']);
    expect(turn.snapshot?.recall?.trimmed).toEqual([{ kind: 'lore', count: 1 }]);

    turn.noteUsed(turn.compose([]).used);
    expect(turn.snapshot?.recall?.lore.map((entry) => entry.id)).toEqual(['lore-a', 'lore-b']);
    expect(turn.snapshot?.recall?.trimmed).toBeUndefined();
  });
});
