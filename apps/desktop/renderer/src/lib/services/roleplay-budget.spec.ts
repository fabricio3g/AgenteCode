import { describe, expect, it } from 'vitest';
import type { CharacterCard, PromptTrim, RoleplayTrimNote, RoleplayUsed, UserPersona } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat/types';
import { resolveRoleplaySettings } from '$lib/features/roleplay/roleplay-settings';
import { buildStarterKit } from '$lib/features/roleplay/starter-kit';
import { buildRoleplayPromptParts, type RoleplayPromptInput } from '$lib/services/roleplay-prompts';
import { completionReserve, fitRoleplayRequest, messageTokens, requestTokens } from '$lib/services/roleplay-budget';

/** A system message of exactly `tokens` tokens under the app's estimate (4 overhead + chars/4). */
function systemOfTokens(tokens: number): RequestMessage {
  return { role: 'system', content: 'x'.repeat(4 * Math.max(0, tokens - 4)) };
}

/** Alternating prose: even indexes are the assistant's (index 0 is the greeting), odd ones the user's. */
function turn(index: number, chars: number): RequestMessage {
  return { role: index % 2 === 0 ? 'assistant' : 'user', content: 'a'.repeat(chars) };
}

/**
 * A fake prompt with known sizes: 1000 tokens of base, 1000 for the examples,
 * 100 per kept lore entry (6 by default), 1000 for an uncut description, 100
 * once cut. Reports its trims the way the real builder does.
 */
function fakeCompose(history: RequestMessage[], trim: PromptTrim): { messages: RequestMessage[]; used: RoleplayUsed } {
  const trimmed: RoleplayTrimNote[] = [];
  let tokens = 1000;
  if (trim.examples) trimmed.push({ kind: 'examples', count: 1 });
  else tokens += 1000;
  const lore = trim.loreLimit ?? 6;
  tokens += lore * 100;
  if (lore < 6) trimmed.push({ kind: 'lore', count: 6 - lore });
  if (trim.descriptionChars) { tokens += 100; trimmed.push({ kind: 'descriptions', count: 1 }); } else tokens += 1000;
  return {
    messages: [systemOfTokens(tokens), ...history, { role: 'system', content: 'tail' }],
    used: { lore: [], memories: [], journal: [], trimmed }
  };
}

describe('fitRoleplayRequest: trim order', () => {
  const history: RequestMessage[] = [
    turn(0, 400),
    ...Array.from({ length: 19 }, (_, index) => turn(index + 1, 400)),
    { role: 'user', content: 'The new turn.' }
  ];

  it('changes nothing when the whole request fits', () => {
    const result = fitRoleplayRequest({ contextTokens: 32768, reserve: 1024, history, compose: fakeCompose });
    expect(result.fits).toBe(true);
    expect(result.used.trimmed).toEqual([]);
    expect(result.messages.filter((m) => m.role !== 'system')).toHaveLength(history.length);
  });

  it('drops example dialogue first, then lore, then descriptions, then history', () => {
    const result = fitRoleplayRequest({ contextTokens: 4096, reserve: 256, history, compose: fakeCompose });
    expect(result.fits).toBe(true);
    const kinds = result.used.trimmed.map((note) => note.kind);
    expect(kinds).toEqual(['examples', 'lore', 'descriptions']);
    expect(result.used.trimmed.find((note) => note.kind === 'lore')).toEqual({ kind: 'lore', count: 4 });
    expect(result.messages.filter((m) => m.role !== 'system')).toHaveLength(history.length);
  });

  it('trims the oldest history last, keeping the greeting and the new user turn', () => {
    const long: RequestMessage[] = [
      turn(0, 400),
      ...Array.from({ length: 59 }, (_, index) => turn(index + 1, 400)),
      { role: 'user', content: 'The new turn.' }
    ];
    const result = fitRoleplayRequest({ contextTokens: 4096, reserve: 256, history: long, compose: fakeCompose });
    expect(result.fits).toBe(true);
    const kept = result.messages.filter((m) => m.role !== 'system');
    expect(kept[0]).toEqual(long[0]);
    expect(kept.at(-1)).toEqual({ role: 'user', content: 'The new turn.' });
    expect(result.used.trimmed.at(-1)?.kind).toBe('history');
    expect(result.used.trimmed.at(-1)!.count!).toBeGreaterThan(0);
    expect(requestTokens(result.messages)).toBeLessThanOrEqual(4096 - 256);
  });

  it('never drops the new user turn, even when nothing fits', () => {
    const tiny = fitRoleplayRequest({
      contextTokens: 512,
      reserve: 128,
      history,
      compose: (messages, trim) => {
        const built = fakeCompose(messages, trim);
        return { ...built, messages: [systemOfTokens(2000), ...messages] };
      }
    });
    expect(tiny.fits).toBe(false);
    expect(tiny.messages.filter((m) => m.role !== 'system').at(-1)).toEqual({ role: 'user', content: 'The new turn.' });
  });
});

describe('fitRoleplayRequest: real builder at small and large windows', () => {
  const kit = buildStarterKit();
  const [wren, aldric] = kit.characters as CharacterCard[];
  const persona = { id: 'p1', name: 'Sam', description: 'A tired regular who keeps late hours.', createdAt: 0, updatedAt: 0 } as UserPersona;
  const settings = resolveRoleplaySettings({ interactionMode: 'dynamic' });
  const base: RoleplayPromptInput = {
    characters: [wren!, aldric!],
    primary: wren!,
    speaker: wren!,
    persona,
    userName: 'Sam',
    worldName: kit.world.name,
    worldOverview: kit.world.overview,
    worldScenario: kit.world.scenario,
    settings,
    group: true,
    allowMultiSpeaker: true,
    participantIds: [wren!.id, aldric!.id],
    sceneContext: `Location: ${kit.world.name}\n${wren!.id}: ${wren!.name} — present\n${aldric!.id}: ${aldric!.name} — present`,
    memoryContext: 'Story so far: Sam arrived at the inn in the rain and asked about the road north.'
  };
  /** A long chat: a greeting, then alternating turns of prose. */
  const chat: RequestMessage[] = [
    { role: 'assistant', content: 'The door creaks as you step inside.' },
    ...Array.from({ length: 40 }, (_, index) => turn(index + 1, 600)),
    { role: 'user', content: 'I take a seat by the fire.' }
  ];
  const compose = (messages: RequestMessage[], trim: PromptTrim) => {
    const parts = buildRoleplayPromptParts({ ...base, trim });
    return {
      messages: [{ role: 'system' as const, content: parts.stable }, ...messages, { role: 'system' as const, content: parts.volatile }],
      used: parts.used
    };
  };

  for (const [contextTokens, maxTokens] of [[4096, 400], [8192, 400], [32768, 1024]] as const) {
    it(`fits a ${contextTokens} window within its completion reserve, keeping the scene's opening and the new turn`, () => {
      const reserve = completionReserve({ contextTokens, maxTokens, backend: 'local' });
      const result = fitRoleplayRequest({ contextTokens, reserve, history: chat, compose });
      const conversation = result.messages.filter((m) => m.role !== 'system');
      expect(conversation.at(-1)?.content).toBe('I take a seat by the fire.');
      if (result.used.trimmed.some((note) => note.kind === 'history')) {
        expect(conversation[0]?.content).toBe('The door creaks as you step inside.');
      }
      if (result.fits) expect(requestTokens(result.messages)).toBeLessThanOrEqual(contextTokens - reserve);
      const order = ['examples', 'lore', 'descriptions', 'history'];
      const kinds = result.used.trimmed.map((note) => order.indexOf(note.kind));
      expect([...kinds].sort((a, b) => a - b)).toEqual(kinds);
    });
  }

  it('leaves a 32k window untouched', () => {
    const result = fitRoleplayRequest({ contextTokens: 32768, reserve: 1024, history: chat, compose });
    expect(result.fits).toBe(true);
    expect(result.used.trimmed.filter((note) => note.kind === 'history')).toEqual([]);
    expect(result.messages.filter((m) => m.role !== 'system')).toHaveLength(chat.length);
  });
});

describe('completionReserve', () => {
  it('uses the local default when the scene sets no cap, never more than a quarter of the window', () => {
    expect(completionReserve({ contextTokens: 4096, backend: 'local' })).toBe(400);
    expect(completionReserve({ contextTokens: 1024, backend: 'local' })).toBe(256);
  });

  it('honours a smaller scene cap and ignores a larger one beyond the quarter', () => {
    expect(completionReserve({ contextTokens: 8192, maxTokens: 150, backend: 'local' })).toBe(150);
    expect(completionReserve({ contextTokens: 2048, maxTokens: 4000, backend: 'api' })).toBe(512);
  });

  it('reserves the cloud default when the model reports its window and the scene sets no cap', () => {
    expect(completionReserve({ contextTokens: 32768, backend: 'api' })).toBe(1024);
  });
});

describe('messageTokens', () => {
  it('matches the app estimate: four per message plus a quarter of the characters', () => {
    expect(messageTokens({ role: 'user', content: 'abcdefgh' })).toBe(4 + 2);
    expect(messageTokens({ role: 'user', content: 'abcde', reasoning_content: 'abcdefgh' })).toBe(4 + 2 + 2);
  });
});
