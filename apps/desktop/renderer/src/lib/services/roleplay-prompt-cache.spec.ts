import { describe, expect, it } from 'vitest';
import type { CharacterCard, LorebookEntry, UserPersona } from '$lib/types/chat';
import { resolveRoleplaySettings } from '$lib/features/roleplay/roleplay-settings';
import { buildRoleplayPromptParts, buildRoleplaySystemPrompt, type RoleplayPromptInput } from '$lib/services/roleplay-prompts';

/*
 * The prompt is split for the prefix cache: the stable block opens the request
 * and must not move when only the per-turn parts change; the volatile tail
 * follows the history.
 */

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: 'aiko',
    name: 'Aiko',
    description: 'Aiko is a barista who works nights.',
    personality: 'Sarcastic but kind.',
    scenario: 'The cafe is closing for the night.',
    firstMessage: 'Hello.',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    exampleDialogue: '<START>\n{{user}}: Hi\n{{char}}: Hey, you again?',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

const sam: UserPersona = { id: 'p1', name: 'Sam', description: 'A tired regular.', createdAt: 0, updatedAt: 0 } as UserPersona;

function lore(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
  return { id: 'lore-1', keys: ['bell'], content: 'The door bell rings twice.', enabled: true, insertionOrder: 100, ...overrides } as LorebookEntry;
}

function input(overrides: Partial<RoleplayPromptInput> = {}): RoleplayPromptInput {
  const aiko = card();
  const ren = card({ id: 'ren', name: 'Ren', description: 'Ren keeps the books.', personality: '', scenario: 'Ren waits by the till.', exampleDialogue: '<START>\n{{user}}: Morning\n{{char}}: Late again.' });
  return {
    characters: [aiko, ren],
    primary: aiko,
    speaker: aiko,
    persona: sam,
    userName: 'Sam',
    worldName: 'Ashgrove',
    worldOverview: 'A harbour town of wet roofs.',
    settings: resolveRoleplaySettings({ interactionMode: 'chat' }),
    group: true,
    allowMultiSpeaker: false,
    participantIds: ['aiko'],
    sceneContext: 'Location: The Bent Nail\naiko: Aiko — present\nren: Ren — present',
    memoryContext: '',
    ...overrides
  };
}

describe('roleplay prompt parts: byte stability', () => {
  it('keeps the stable block identical when only lore, room, memory and author note change', () => {
    const before = buildRoleplayPromptParts(input());
    const after = buildRoleplayPromptParts(input({
      loreEntries: [lore()],
      sceneContext: 'Location: The Market\naiko: Aiko — present',
      memoryContext: 'Story so far: Sam paid for the tea.',
      authorNote: 'Keep it tense.'
    }));
    expect(after.stable).toBe(before.stable);
    expect(after.volatile).not.toBe(before.volatile);
    expect(after.volatile).toContain('The door bell rings twice.');
    expect(after.volatile).toContain('The Market');
  });

  it('keeps the stable block identical when the group speaker switches, and names the speaker only in the tail', () => {
    const aiko = input();
    const ren = input({ speaker: card({ id: 'ren', name: 'Ren', description: 'Ren keeps the books.' }), participantIds: ['ren'] });
    const asAiko = buildRoleplayPromptParts(aiko);
    const asRen = buildRoleplayPromptParts(ren);
    expect(asRen.stable).toBe(asAiko.stable);
    expect(asAiko.volatile).toContain("Write only Aiko's reply this turn");
    expect(asRen.volatile).toContain("Write only Ren's reply this turn");
    expect(asRen.stable).not.toContain("Write only Ren's reply");
    expect(asRen.stable).not.toContain("Write only Aiko's reply");
  });

  it("uses the scene's primary for scenario and examples even when another character speaks (A5)", () => {
    const parts = buildRoleplayPromptParts(input({ speaker: card({ id: 'ren', name: 'Ren' }), participantIds: ['ren'] }));
    expect(parts.stable).toContain('The cafe is closing for the night.');
    expect(parts.stable).toContain('Hey, you again?');
    expect(parts.stable).not.toContain('Ren waits by the till.');
    expect(parts.stable).not.toContain('Late again.');
  });

  it('lists every cast definition in roster order inside the stable block', () => {
    const parts = buildRoleplayPromptParts(input());
    expect(parts.stable.indexOf('## Aiko')).toBeLessThan(parts.stable.indexOf('## Ren'));
    expect(parts.stable).toContain('Ren keeps the books.');
    expect(parts.volatile).not.toContain('## Ren');
  });

  it('keeps scene NPCs out of the stable block', () => {
    const npc = card({ id: 'npc-tom', name: 'Tom', description: 'Tom sweeps the step.' });
    const parts = buildRoleplayPromptParts(input({ npcs: [npc] }));
    expect(parts.stable).not.toContain('Tom sweeps the step.');
    expect(parts.volatile).toContain('Tom sweeps the step.');
  });

  it('places a card post-history override before the mode policy, so the policy closes the stable block', () => {
    const primary = card({ postHistoryInstructions: 'Use elaborate prose.' });
    const parts = buildRoleplayPromptParts(input({
      characters: [primary],
      primary,
      participantIds: undefined,
      group: false
    }));
    expect(parts.stable.indexOf('Use elaborate prose.')).toBeGreaterThan(-1);
    expect(parts.stable.indexOf('Use elaborate prose.')).toBeLessThan(parts.stable.indexOf('## Character chat policy'));
  });

  it('orders the volatile lore by id, whatever the priority order it arrived in', () => {
    const parts = buildRoleplayPromptParts(input({
      loreEntries: [lore({ id: 'b-entry', content: 'Bravo fact.' }), lore({ id: 'a-entry', content: 'Alpha fact.' })]
    }));
    expect(parts.volatile.indexOf('Alpha fact.')).toBeLessThan(parts.volatile.indexOf('Bravo fact.'));
  });

  it('routes a section that reads {{lastMessage}} to the tail, so the stable block does not move', () => {
    const withLast = (lastMessage: string) => buildRoleplayPromptParts(input({
      characters: [card({ description: 'Aiko answers: {{lastMessage}}' }), card({ id: 'ren', name: 'Ren' })],
      macros: { lastMessage }
    }));
    const first = withLast('Hi there.');
    const second = withLast('Something else.');
    expect(second.stable).toBe(first.stable);
    expect(first.stable).not.toContain('Aiko answers');
    expect(first.volatile).toContain('Aiko answers: Hi there.');
    expect(second.volatile).toContain('Aiko answers: Something else.');
  });

  it('keeps buildRoleplaySystemPrompt as the stable block followed by the tail', () => {
    const parts = buildRoleplayPromptParts(input({ loreEntries: [lore()] }));
    expect(buildRoleplaySystemPrompt(input({ loreEntries: [lore()] }))).toBe([parts.stable, parts.volatile].join('\n\n'));
  });
});

describe('roleplay prompt parts: used record', () => {
  it('reports the lore ids, memory ids and journal ids that the prompt carried', () => {
    const parts = buildRoleplayPromptParts(input({
      loreEntries: [lore({ id: 'lore-bell' })],
      memoryContext: 'Story so far: Sam paid for the tea.\nSam owes Ren a favour.',
      memoryUsed: { memories: ['summary', 'relationship:0'], journal: ['journal-oath'] }
    }));
    expect(parts.used).toEqual({
      lore: ['lore-bell'],
      memories: ['summary', 'relationship:0'],
      journal: ['journal-oath'],
      trimmed: []
    });
  });

  it('lists what a lore trim removed', () => {
    const parts = buildRoleplayPromptParts(input({
      loreEntries: [lore({ id: 'a' }), lore({ id: 'b' }), lore({ id: 'c' })],
      trim: { loreLimit: 1 }
    }));
    expect(parts.used.lore).toEqual(['a']);
    expect(parts.used.trimmed).toEqual([{ kind: 'lore', count: 2 }]);
  });

  it('reports example dialogue and descriptions the trim shortened or dropped', () => {
    const long = 'x'.repeat(2000);
    const parts = buildRoleplayPromptParts(input({
      characters: [card({ description: long })],
      group: false,
      participantIds: undefined,
      trim: { examples: true, descriptionChars: 800 }
    }));
    expect(parts.stable).not.toContain('Hey, you again?');
    expect(parts.stable).toContain(`${'x'.repeat(800)}…`);
    expect(parts.used.trimmed).toEqual([{ kind: 'examples', count: 1 }, { kind: 'descriptions', count: 1 }]);
  });
});
