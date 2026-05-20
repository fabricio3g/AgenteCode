import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRoleplayMessages, matchRoleplayLorebookEntries } from '../../renderer/src/lib/services/roleplay-prompt.ts';

const settings = {
  responseLength: 'balanced',
  narrationStyle: 'immersive',
  maxSpeakerTurns: 2,
  allowMultipleCharacters: true,
  allowNarrator: true,
  userName: 'Sam',
  sceneContext: 'The archive is closed during a thunderstorm.',
  conversationMode: 'group',
  primaryCharacterId: 'ada'
};

describe('roleplay prompt builder', () => {
  it('injects cast, settings, matching lore, and excludes agent/search instructions', () => {
    const chat = {
      id: 'chat',
      title: 'Scene',
      createdAt: 1,
      updatedAt: 1,
      draft: '',
      messages: [{ id: 'm1', role: 'user', content: 'We enter the library.', createdAt: 1 }],
      activeCharacterIds: ['ada'],
      lorebookIds: ['book'],
      settings
    };
    const characters = [{
      id: 'ada',
      name: 'Ada',
      description: 'A scholar',
      personality: 'Curious',
      scenario: 'Archive',
      firstMessage: 'Welcome, {{user}}.',
      exampleDialogue: '',
      creatorNotes: '',
      tags: [],
      sourceFormat: 'tavern-v2-json',
      createdAt: 1,
      updatedAt: 1
    }];
    const lorebooks = [{
      id: 'book',
      name: 'Lore',
      createdAt: 1,
      updatedAt: 1,
      entries: [
        { id: 'e1', keys: ['library'], content: 'The library remembers every visitor.', enabled: true },
        { id: 'e2', keys: ['mountain'], content: 'Unrelated.', enabled: true }
      ]
    }];

    const messages = buildRoleplayMessages({ chat, characters, lorebooks, latestUserMessage: 'library' });
    const system = messages[0].content;

    assert.match(system, /Active cast:/);
    assert.match(system, /Scene context:/);
    assert.match(system, /The archive is closed during a thunderstorm\./);
    assert.match(system, /Chat mode: group chat/);
    assert.match(system, /separate labeled sections/);
    assert.match(system, /Name: Ada/);
    assert.match(system, /Welcome, Sam\./);
    assert.match(system, /The library remembers every visitor\./);
    assert.doesNotMatch(system, /Unrelated\./);
    assert.match(system, /Do not use agent tools, web search, deep research/);
  });

  it('matches only enabled keyword entries plus constants', () => {
    const entries = matchRoleplayLorebookEntries({
      chat: {
        id: 'chat',
        title: 'Scene',
        createdAt: 1,
        updatedAt: 1,
        draft: '',
        messages: [],
        activeCharacterIds: [],
        lorebookIds: ['book'],
        settings
      },
      latestUserMessage: 'A clock starts ticking.',
      lorebooks: [{
        id: 'book',
        name: 'Lore',
        createdAt: 1,
        updatedAt: 1,
        entries: [
          { id: 'enabled', keys: ['clock'], content: 'Clock lore', enabled: true },
          { id: 'disabled', keys: ['clock'], content: 'Hidden lore', enabled: false },
          { id: 'constant', keys: [], content: 'Constant lore', enabled: true, constant: true }
        ]
      }]
    });

    assert.deepEqual(entries.map((entry) => entry.id), ['enabled', 'constant']);
  });
});
