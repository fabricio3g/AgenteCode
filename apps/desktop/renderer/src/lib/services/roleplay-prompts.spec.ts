import { describe, expect, it } from 'vitest';
import type { CharacterCard, LorebookEntry } from '$lib/types/chat';
import { resolveRoleplaySettings } from '$lib/features/roleplay/roleplay-settings';
import {
  CONTENT_FRAME_SFW,
  CONTENT_FRAME_UNRESTRICTED,
  ROLEPLAY_BASE_PROMPT,
  buildRoleplaySystemPrompt,
  resolveLorebooks,
  resolveRoleplaySampling,
  selectLoreEntries,
  substituteMacros
} from '$lib/services/roleplay-prompts';

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: 'char-1',
    name: 'Aiko',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    exampleDialogue: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function entry(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
  return {
    id: 'entry-1',
    keys: [],
    content: 'Lore content',
    enabled: true,
    insertionOrder: 100,
    ...overrides
  };
}

describe('substituteMacros', () => {
  it('replaces char, user, persona and nickname in any case', () => {
    const names = { char: 'Aiko', user: 'Sam' };
    expect(substituteMacros('{{char}} meets {{user}}', names)).toBe('Aiko meets Sam');
    expect(substituteMacros('{{CHAR}}/{{ Persona }}/{{nickname}}', names)).toBe('Aiko/Sam/Sam');
  });
});

describe('buildRoleplaySystemPrompt', () => {
  it('keeps Chat conversational even with narrative card overrides and inherited reply styles', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card({ systemPrompt: 'Always narrate gestures.', postHistoryInstructions: 'Use elaborate prose.' })],
      authorNote: 'Describe the room first.',
      settings: resolveRoleplaySettings({ interactionMode: 'chat', replyStyle: 'narrative' })
    });
    const policy = prompt.slice(prompt.indexOf('## Character chat policy'));
    expect(policy).toContain('Chat mode is always dialogue-only');
    expect(policy).toContain('No narration, stage directions, italic actions');
    expect(policy).toContain('Reply style: dialogue');
    expect(policy).not.toContain('Use light italic emphasis');
    expect(prompt.indexOf('## Character chat policy')).toBeGreaterThan(prompt.indexOf('Use elaborate prose.'));
  });

  it('uses a distinct narrator protocol in Narrative and retains opt-in directions in Dynamic', () => {
    const narrative = buildRoleplaySystemPrompt({ characters: [card()], settings: resolveRoleplaySettings({ interactionMode: 'narrative' }) });
    expect(narrative).toContain('## Narrative scene policy');
    expect(narrative).toContain('starting with "Narrator:"');
    expect(narrative).toContain('even with a single character');
    expect(narrative).toContain('Never narrate unexpressed user actions or thoughts.');
    const dynamic = buildRoleplaySystemPrompt({ characters: [card()], settings: resolveRoleplaySettings({ interactionMode: 'dynamic' }) });
    expect(dynamic).toContain('## Dynamic scene policy');
    expect(dynamic).not.toContain('Chat mode is always dialogue-only');
  });

  it('uses the roleplay base prompt, never the assistant style or chart hint', () => {
    const prompt = buildRoleplaySystemPrompt({ characters: [card()] });
    expect(prompt).toContain('Aiko');
    expect(prompt).toContain("Write Aiko's next reply");
    expect(prompt).not.toContain('normal assistant style');
    expect(prompt).not.toContain('<chart');
  });

  it('lets a card system prompt replace the base', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card({ systemPrompt: 'You are {{char}}, a pirate captain.' })]
    });
    expect(prompt).toContain('You are Aiko, a pirate captain.');
    expect(prompt).not.toContain(ROLEPLAY_BASE_PROMPT);
  });

  it('composes sections in spec order with macros substituted', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card({
        description: '{{char}} is a barista.',
        personality: 'Sarcastic.',
        scenario: '{{user}} arrives late.',
        exampleDialogue: '<START>\n{{user}}: Hi\n{{char}}: Hey.',
        postHistoryInstructions: 'Keep replies under 120 words.'
      })],
      persona: { id: 'p1', name: 'Sam', description: 'A tired regular.', createdAt: 0, updatedAt: 0 },
      loreEntries: [entry({ content: 'The cafe closes at midnight.' })],
      authorNote: 'Slow burn.'
    });

    const order = [
      "Write Aiko's next reply",
      '## Aiko',
      '## Scenario',
      '## Sam',
      '## Example dialogue',
      '## Lore',
      "## Author's note",
      'Keep replies under 120 words.'
    ].map((marker) => prompt.indexOf(marker));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain('Aiko is a barista.');
    expect(prompt).toContain('Sam arrives late.');
  });

  it('adds a one-speaker instruction for group scenes', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card({ name: 'Aiko' }), card({ id: 'char-2', name: 'Ren' })],
      speaker: card({ name: 'Ren' }),
      group: true
    });
    expect(prompt).toContain('Write only Ren');
    expect(prompt).toContain('Aiko, Ren');
  });

  it('asks for a choices block only when adventure choices are on', () => {
    const off = buildRoleplaySystemPrompt({ characters: [card()] });
    expect(off).not.toContain('[choices]');

    const on = buildRoleplaySystemPrompt({ characters: [card()], adventureChoices: true });
    expect(on).toContain('[choices]');
    expect(on).toContain('[/choices]');
    expect(on).toContain('Suggested actions');
  });

  it('frames the content only when a rating is set', () => {
    expect(buildRoleplaySystemPrompt({ characters: [card()] })).not.toContain('## Content');

    const sfw = buildRoleplaySystemPrompt({ characters: [card()], contentRating: 'sfw' });
    expect(sfw).toContain(CONTENT_FRAME_SFW);
    expect(sfw).not.toContain(CONTENT_FRAME_UNRESTRICTED);

    const open = buildRoleplaySystemPrompt({ characters: [card()], contentRating: 'unrestricted' });
    expect(open).toContain(CONTENT_FRAME_UNRESTRICTED);
    expect(open).not.toContain(CONTENT_FRAME_SFW);
  });

  it('puts the content frame ahead of the cast it frames', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card({ description: 'Aiko is a barista.' })],
      contentRating: 'sfw'
    });
    expect(prompt.indexOf('## Content')).toBeLessThan(prompt.indexOf('## Aiko'));
    expect(prompt.indexOf("Write Aiko's next reply")).toBeLessThan(prompt.indexOf('## Content'));
  });

  it('lets a multi-speaker turn voice the cast, and pins one speaker otherwise', () => {
    const cast = [card({ name: 'Aiko' }), card({ id: 'char-2', name: 'Ren' })];

    const single = buildRoleplaySystemPrompt({ characters: cast, speaker: cast[0], group: true });
    expect(single).toContain('Write only Aiko');
    expect(single).not.toContain('This turn can voice more than one');

    const multi = buildRoleplaySystemPrompt({
      characters: cast,
      speaker: cast[0],
      group: true,
      allowMultiSpeaker: true
    });
    expect(multi).toContain('This turn can voice more than one');
    expect(multi).not.toContain('Write only Aiko');
    expect(multi).toContain('Aiko, Ren');
  });
});

describe('resolveRoleplaySampling', () => {
  it('prefers the card, then the session, then the world', () => {
    const cardSettings = card({ temperature: 1.1, topP: 0.9, maxTokens: 500 });
    const chatSettings = { temperature: 0.5, topP: 0.4, maxTokens: 100 };
    const worldSettings = { temperature: 0.1, topP: 0.2, maxTokens: 50 };

    expect(resolveRoleplaySampling({ speaker: cardSettings, chatSettings, worldSettings })).toEqual({
      temperature: 1.1,
      topP: 0.9,
      maxTokens: 500
    });
    expect(resolveRoleplaySampling({ chatSettings, worldSettings })).toEqual({
      temperature: 0.5,
      topP: 0.4,
      maxTokens: 100
    });
    expect(resolveRoleplaySampling({ worldSettings })).toEqual({
      temperature: 0.1,
      topP: 0.2,
      maxTokens: 50
    });
  });

  it('falls through to the next level per knob, not per whole setting', () => {
    const sampling = resolveRoleplaySampling({
      speaker: card({ temperature: 1.3 }),
      chatSettings: { temperature: 0.5, topP: 0.4 },
      worldSettings: { maxTokens: 50 }
    });
    expect(sampling).toEqual({ temperature: 1.3, topP: 0.4, maxTokens: 50 });
  });

  it('sends nothing when nothing is configured, and treats 0 as set', () => {
    expect(resolveRoleplaySampling({})).toEqual({});
    expect(resolveRoleplaySampling({ chatSettings: {} })).toEqual({});
    expect(resolveRoleplaySampling({ chatSettings: { temperature: 0 } })).toEqual({ temperature: 0 });
  });

  it('drops values that could not be sent', () => {
    expect(resolveRoleplaySampling({
      chatSettings: { temperature: Number.NaN, topP: -1, maxTokens: 0 }
    })).toEqual({});
  });
});

describe('selectLoreEntries', () => {
  it('always includes constants and matches keys case-insensitively', () => {
    const selected = selectLoreEntries({
      entries: [
        entry({ id: 'a', constant: true, content: 'Always here' }),
        entry({ id: 'b', keys: ['dragon'], content: 'Dragon lore' }),
        entry({ id: 'c', keys: ['spaceship'], content: 'Space lore' })
      ]
    }, 'The DRAGON roars.');
    expect(selected.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('requires a secondary key when selective', () => {
    const book = {
      entries: [
        entry({ id: 'a', keys: ['forest'], secondaryKeys: ['moon'], selective: true, content: 'Forest at night' }),
        entry({ id: 'b', keys: ['forest'], secondaryKeys: ['moon'], selective: true, content: 'Forest by day' })
      ]
    };
    expect(selectLoreEntries(book, 'The forest is quiet.').map((e) => e.id)).toEqual([]);
    expect(selectLoreEntries(book, 'The forest under the moon.').map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('orders by insertion order and respects the token budget', () => {
    const big = 'x'.repeat(400); // ~100 tokens
    const selected = selectLoreEntries({
      tokenBudget: 120,
      entries: [
        entry({ id: 'late', constant: true, insertionOrder: 200, content: big }),
        entry({ id: 'early', constant: true, insertionOrder: 1, content: big }),
        entry({ id: 'small', constant: true, insertionOrder: 300, content: 'tiny' })
      ]
    }, '');
    // 'early' (100) fits; 'late' (100 more) is dropped; 'small' still fits.
    expect(selected.map((e) => e.id)).toEqual(['early', 'small']);
  });

  it('skips disabled entries and supports regex keys', () => {
    const selected = selectLoreEntries({
      entries: [
        entry({ id: 'off', constant: true, enabled: false, content: 'Off' }),
        entry({ id: 'regex', keys: ['\\bsword\\b'], useRegex: true, content: 'Sword lore' })
      ]
    }, 'He drew his sword.');
    expect(selected.map((e) => e.id)).toEqual(['regex']);
  });

  it('applies the secondary-key logic modes', () => {
    const book = {
      entries: [
        entry({ id: 'any', keys: ['forest'], secondaryKeys: ['moon', 'star'], selective: true, secondaryLogic: 'and_any', content: 'Any' }),
        entry({ id: 'all', keys: ['forest'], secondaryKeys: ['moon', 'star'], selective: true, secondaryLogic: 'and_all', content: 'All' }),
        entry({ id: 'not_any', keys: ['forest'], secondaryKeys: ['sun'], selective: true, secondaryLogic: 'not_any', content: 'Not any' }),
        entry({ id: 'not_all', keys: ['forest'], secondaryKeys: ['moon', 'sun'], selective: true, secondaryLogic: 'not_all', content: 'Not all' })
      ]
    };
    // 'moon' only: any → yes, all → no, not_any → yes, not_all → yes.
    expect(selectLoreEntries(book, 'The forest under the moon.').map((e) => e.id)).toEqual(['any', 'not_any', 'not_all']);
    // 'moon' and 'sun': any → yes, all → no, not_any → no, not_all → no.
    expect(selectLoreEntries(book, 'The forest under the moon and sun.').map((e) => e.id)).toEqual(['any']);
  });
});

describe('resolveLorebooks', () => {
  it('merges sources in priority order and dedupes identical entries', () => {
    const shared = entry({ id: 'w1', constant: true, content: 'The city floats.' });
    const merged = resolveLorebooks(
      [
        { source: 'world', book: { entries: [shared] } },
        {
          source: 'character',
          characterId: 'char-1',
          book: {
            entries: [
              { ...shared },
              entry({ id: 'c1', keys: ['dragon'], content: 'Dragon lore' })
            ]
          }
        }
      ],
      'The dragon flies.'
    );
    expect(merged.map((e) => e.content)).toEqual(['The city floats.', 'Dragon lore']);
  });

  it('caps the combined result with the first defined budget', () => {
    const big = 'x'.repeat(400); // ~100 tokens
    const merged = resolveLorebooks(
      [
        { source: 'world', book: { tokenBudget: 120, entries: [entry({ id: 'a', constant: true, insertionOrder: 1, content: big })] } },
        {
          source: 'character',
          book: {
            tokenBudget: 1000,
            entries: [
              entry({ id: 'b', constant: true, insertionOrder: 2, content: big }),
              entry({ id: 'c', constant: true, insertionOrder: 3, content: 'tiny' })
            ]
          }
        }
      ],
      ''
    );
    expect(merged.map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('world sections', () => {
  it('includes the world overview and falls back to the world scenario', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card()],
      worldName: 'Eldoria',
      worldOverview: 'A floating city.',
      worldScenario: 'The festival begins.'
    });
    expect(prompt).toContain('## Eldoria\nA floating city.');
    expect(prompt).toContain('## Scenario\nThe festival begins.');
  });

  it('prefers the card scenario over the world scenario', () => {
    const prompt = buildRoleplaySystemPrompt({
      characters: [card({ scenario: 'Card scene.' })],
      worldScenario: 'World scene.'
    });
    expect(prompt).toContain('Card scene.');
    expect(prompt).not.toContain('World scene.');
  });
});
