// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { buildRequestMessagesFromHistory } from '$lib/stores/app-store-helpers';
import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
import { charactersStore, emptyPersona } from '$lib/features/roleplay/characters.svelte';
import { worldsStore } from '$lib/features/roleplay/worlds.svelte';
import { emptyCharacter } from '$lib/services/character-card';
import type { ChatMessage } from '$lib/types/chat';

/** A finished assistant turn spoken by `speakerId`. */
function reply(id: string, speakerId: string, content: string, createdAt = 1): ChatMessage {
  return { id, role: 'assistant', content, createdAt, done: true, status: 'idle', speakerId, versions: [], activeVersion: 0 };
}

/**
 * Macros in a live scene. Messages are stored raw; what the viewer reads and
 * what the model is sent is resolved against the persona and speaker involved.
 */
describe('roleplay macros in a scene', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    charactersStore.personas = [
      emptyPersona({ id: 'p-sam', name: 'Sam', isDefault: true }),
      emptyPersona({ id: 'p-jo', name: 'Jo' })
    ];
    worldsStore.worlds = [];
    appStore.chats = [];
    appStore.activeRunsByChat = {};
    appStore.composer = '';
  });

  it('renders a greeting with the persona name and sends it resolved to the model', async () => {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko', firstMessage: 'Hello, {{user}}. I am {{char}}.' });
    await charactersStore.save(aiko);

    const chat = roleplayStore.startScene({ characters: [aiko], personaId: 'p-sam', openingSource: 'greeting' })!;
    const greeting = chat.messages[0]!;

    expect(greeting.content).toBe('Hello, {{user}}. I am {{char}}.');
    expect(roleplayStore.displayText(greeting.content, { messageId: greeting.id })).toBe('Hello, Sam. I am Aiko.');
    expect(buildRequestMessagesFromHistory(roleplayStore.resolveHistory(chat), 0)).toEqual([
      { role: 'assistant', content: 'Hello, Sam. I am Aiko.' }
    ]);
  });

  it('resolves the card text the system prompt is built from, with the same names', async () => {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko', description: '{{user}} is a regular here.', firstMessage: 'Hi.' });
    await charactersStore.save(aiko);
    const chat = roleplayStore.startScene({ characters: [aiko], personaId: 'p-sam', openingSource: 'none' })!;

    expect(roleplayStore.systemPrompt(chat)).toContain('Sam is a regular here.');
    expect(roleplayStore.systemPrompt(chat)).not.toContain('{{user}}');
  });

  it('resolves a group greeting to each speaker, and a line you wrote to whoever answered it', async () => {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko' });
    const ren = emptyCharacter({ id: 'ren', name: 'Ren' });
    await charactersStore.save(aiko);
    await charactersStore.save(ren);
    const chat = roleplayStore.startScene({ characters: [aiko, ren], personaId: 'p-sam', openingSource: 'none' })!;
    chat.messages.push(
      reply('g-aiko', 'aiko', '{{char}} waves at {{user}}.'),
      { id: 'u1', role: 'user', content: '{{char}}, who else is here?', createdAt: 2, done: true, status: 'idle', versions: [], activeVersion: 0 },
      reply('g-ren', 'ren', '{{char}} points at the door.', 3)
    );

    expect(roleplayStore.displayText(chat.messages[0]!.content, { messageId: 'g-aiko' })).toBe('Aiko waves at Sam.');
    expect(roleplayStore.displayText(chat.messages[2]!.content, { messageId: 'g-ren' })).toBe('Ren points at the door.');
    expect(roleplayStore.displayText(chat.messages[1]!.content, { messageId: 'u1' })).toBe('Ren, who else is here?');
    expect(roleplayStore.resolveHistory(chat).map((message) => message.content)).toEqual([
      'Aiko waves at Sam.',
      'Ren, who else is here?',
      'Ren points at the door.'
    ]);
  });

  it('re-resolves old messages when the persona changes, and stores the raw text', async () => {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko', firstMessage: 'Hello, {{user}}.' });
    await charactersStore.save(aiko);
    const chat = roleplayStore.startScene({ characters: [aiko], personaId: 'p-sam', openingSource: 'greeting' })!;
    const greeting = chat.messages[0]!;
    expect(roleplayStore.displayText(greeting.content, { messageId: greeting.id })).toBe('Hello, Sam.');

    roleplayStore.setPersona('p-jo');

    expect(roleplayStore.displayText(greeting.content, { messageId: greeting.id })).toBe('Hello, Jo.');
    expect(greeting.content).toBe('Hello, {{user}}.');
    // A turn built with an earlier persona keeps that name for the model.
    expect(roleplayStore.resolveHistory(chat, chat.messages, { user: 'Sam' })[0]?.content).toBe('Hello, Sam.');
  });

  it('reads a message\'s time and random draws the same way on every render', async () => {
    const aiko = emptyCharacter({
      id: 'aiko',
      name: 'Aiko',
      firstMessage: 'It is {{isotime}}. Pick: {{pick::red::green::blue::black}}. Roll {{roll::1d100}}.'
    });
    await charactersStore.save(aiko);
    const chat = roleplayStore.startScene({ characters: [aiko], personaId: 'p-sam', openingSource: 'greeting' })!;
    const greeting = chat.messages[0]!;
    greeting.createdAt = new Date(2026, 0, 2, 9, 5).getTime();

    const first = roleplayStore.displayText(greeting.content, { messageId: greeting.id });
    expect(first.startsWith('It is 09:05. Pick: ')).toBe(true);
    expect(roleplayStore.displayText(greeting.content, { messageId: greeting.id })).toBe(first);
  });

  it('keeps the system prompt byte-stable as the scene grows', async () => {
    const aiko = emptyCharacter({
      id: 'aiko',
      name: 'Aiko',
      description: 'Opened at {{time}}. Luck {{roll:1d1000}}.',
      firstMessage: 'Hi.'
    });
    await charactersStore.save(aiko);
    const chat = roleplayStore.startScene({ characters: [aiko], personaId: 'p-sam', openingSource: 'greeting' })!;
    const before = roleplayStore.systemPrompt(chat);

    chat.messages.push(
      { id: 'u1', role: 'user', content: 'Hello there.', createdAt: Date.now(), done: true, status: 'idle', versions: [], activeVersion: 0 },
      reply('a1', 'aiko', 'Hey.', Date.now())
    );

    expect(roleplayStore.systemPrompt(chat)).toBe(before);
  });

  it('exports a roleplay chat as it reads on screen', async () => {
    const aiko = emptyCharacter({ id: 'aiko', name: 'Aiko', firstMessage: 'Hello, {{user}}.' });
    await charactersStore.save(aiko);
    const chat = roleplayStore.startScene({ characters: [aiko], personaId: 'p-sam', openingSource: 'greeting' })!;

    expect(roleplayStore.forExport(chat).messages[0]?.content).toBe('Hello, Sam.');
    expect(chat.messages[0]?.content).toBe('Hello, {{user}}.');
  });
});
