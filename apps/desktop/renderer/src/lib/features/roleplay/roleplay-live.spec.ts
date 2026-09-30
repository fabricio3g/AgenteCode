// @vitest-environment jsdom
// Opt-in live probe; run with `npm run smoke:roleplay` from apps/desktop.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import { charactersStore } from './characters.svelte';
import { roleplayStore } from './roleplay.svelte';
import { emptyCharacter } from '$lib/services/character-card';
import { buildRequestMessagesWithPatchedUser, buildOutboundMessages } from '$lib/stores/app-message-pipeline';
import { characterBubbles } from './roleplay-voice';
import { parseContributions, turnSnapshot } from './roleplay-scene';
import type { CharacterCard, ChatMessage } from '$lib/types/chat';

const url = process.env.ROLEPLAY_LIVE_URL;
async function request(route: string, body?: unknown) {
  const response = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.ROLEPLAY_LIVE_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

describe.skipIf(!url)('live configured Roleplay model', () => {
  it('respects addressed speakers and user agency through real production turns', async () => {
    const context = await request('/context');
    const find = (name: string) => context.cards.find((card: CharacterCard) => card.name.startsWith(name))
      ?? emptyCharacter({ id: name.toLowerCase(), name, personality: 'Speaks naturally and responds to the topic without taking control.' });
    const cards = [find('Rachel'), find('Wren'), find('Aldric')] as CharacterCard[];
    charactersStore.characters = cards;
    const names = new Map(cards.map((card) => [card.id, card.name]));
    const results: Array<Record<string, unknown>> = [];
    const reportPath = process.env.ROLEPLAY_REPORT || '/tmp/opencode/roleplay-live-results.json';
    const scenarios = [
      { mode: 'dynamic' as const, turns: [
        { text: 'Rachel, what do you enjoy doing? I just want to chat.', expected: [cards[0].id] },
        { text: 'Rachel, what do you like about Wren?', expected: [cards[0].id] },
        { text: 'Wren and Aldric, what do you each think about rainy evenings?', expected: [cards[1].id, cards[2].id] },
        { text: 'I just wanted some company, nothing to do or decide.', count: 1 },
        { text: 'Talk to each other about the rain for a moment.', count: 3 }
      ] },
      { mode: 'chat' as const, turns: [{ text: 'Rachel, say hello to me. Just a normal conversation.', expected: [cards[0].id] }, { text: 'Rachel, Wren was kind to me. How are you today?', expected: [cards[0].id] }] },
      { mode: 'narrative' as const, turns: [{ text: 'Wren, I stay by the doorway and say hello. Describe the room, but leave my next move to me.', expected: [cards[1].id] }] }
    ];
    for (const scenario of scenarios) {
      const chat = roleplayStore.startScene({ characters: cards, openingSource: 'none' })!;
      chat.roleplay = { ...chat.roleplay, interactionMode: scenario.mode, npcDialogue: true, surprise: 0, adventureChoices: false, props: false, maxExchangeLines: 3 };
      for (const probe of scenario.turns) {
        const user: ChatMessage = { id: `live-user-${results.length}`, role: 'user', content: probe.text, createdAt: Date.now() };
        appStore.appendMessageToChat(chat.id, user);
        expect(roleplayStore.routeTurn(chat, chat.messages)).toBe(true);
        const turn = roleplayStore.prepareTurn(chat, { consumeRouting: true });
        if ('expected' in probe) expect(turn.snapshot?.participantIds).toEqual(probe.expected);
        if ('count' in probe) expect(turn.snapshot?.participantIds).toHaveLength(probe.count!);
        const messages = turn.decorate(buildOutboundMessages({ systemPrompt: roleplayStore.systemPrompt(chat, turn.speakerId, turn.snapshot), messages: buildRequestMessagesWithPatchedUser({
          messages: chat.messages, assistantMessageId: 'not-yet-created', userMessageId: user.id, userContent: user.content,
          buildContextualPrompt: (text) => text, attribution: turn.attribution
        }) }));
        const started = Date.now();
        const response = await request('/complete', { messages, stop: turn.stop, temperature: turn.sampling.temperature, max_tokens: turn.sampling.maxTokens });
        const target: ChatMessage = { id: `live-reply-${results.length}`, role: 'assistant', content: response.content || '', speakerId: turn.speakerId, createdAt: Date.now(), done: true, status: 'idle' };
        // Exercise the same raw accumulator used by streaming, with partial boundaries.
        for (let at = 0; at < target.content.length; at += 17) turn.record(target.content.slice(at, at + 17));
        const raw = target.content;
        turn.finalize(target);
        const rawParts = parseContributions(raw.replace(/\[scene\][\s\S]*/i, ''), names, turn.speakerId);
        const bubbles = characterBubbles(target.content, names, turn.speakerId);
        const actual = [...new Set(bubbles.flatMap((part) => part.speakerId ? [part.speakerId] : []))];
        const checks = {
          nonempty: !!target.content.trim(),
          permittedSpeakers: rawParts.every((part) => !part.speakerId || turn.snapshot!.participantIds!.includes(part.speakerId)),
          oneBubblePerCharacter: bubbles.filter((part) => part.speakerId).length === actual.length,
          expectedReplies: !('expected' in probe) || probe.expected!.every((id) => actual.includes(id)),
          noPlayerTurn: !/^\s*(?:\*\*)?(?:User|Sam)\s*:/im.test(raw),
          dialogueOnly: scenario.mode !== 'chat' || !/\*[^*]+\*|^Narrator:/im.test(raw)
        };
        results.push({ mode: scenario.mode, user: probe.text, participants: turn.snapshot?.participantIds, raw, visible: target.content, checks, elapsedMs: Date.now() - started, usage: response.usage });
        fs.mkdirSync('/tmp/opencode', { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify({ provider: context.provider, model: context.model, results }, null, 2));
        console.log(JSON.stringify(results.at(-1), null, 2));
        expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((key) => [key, true])));
        appStore.appendMessageToChat(chat.id, target);
        const retry = roleplayStore.prepareTurn(chat, { speakerId: target.speakerId, snapshot: turnSnapshot(target), historyEnd: chat.messages.length - 1 });
        expect(retry.snapshot?.participantIds).toEqual(turn.snapshot?.participantIds);
      }
    }
  }, 1200000);
});
