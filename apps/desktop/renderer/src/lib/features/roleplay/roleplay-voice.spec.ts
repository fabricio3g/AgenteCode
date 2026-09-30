import { describe, expect, it } from 'vitest';
import { characterBubbles, messageSpeechParts, voiceConfig } from './roleplay-voice';
import { selectTurnParticipants } from './group-turn';
import { emptyCharacter } from '$lib/services/character-card';
import type { AppConfig } from '$lib/types/chat';

const cards = [emptyCharacter({ id: 'rachel', name: 'Rachel', voice: { backend: 'api', provider: 'openai', voice: 'coral' } }),
  emptyCharacter({ id: 'wren', name: 'Wren', voice: { backend: 'local', model: 'kokoro-82m', voice: 'af_bella' } })];
const names = new Map(cards.map((card) => [card.id, card.name]));
const config: AppConfig = { tts: { voice: 'af_heart', narrator: { backend: 'api', provider: 'openai', voice: 'onyx' }, providers: { openai: { type: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy' } } } };

describe('Roleplay speaking boundaries', () => {
  it('distinguishes one addressee, a list, a reference, and an invited exchange', () => {
    expect(selectTurnParticipants('Rachel, what do you like about Wren?', cards, 'wren', true)).toEqual(['rachel']);
    expect(selectTurnParticipants('Rachel and Wren, how are you?', cards, 'rachel', true)).toEqual(['rachel', 'wren']);
    expect(selectTurnParticipants('Wren was kind to me.', cards, 'rachel', true)).toEqual(['rachel']);
    expect(selectTurnParticipants('Talk to each other about the rain.', cards, 'rachel', true)).toEqual(['rachel', 'wren']);
    expect(selectTurnParticipants('Talk to each other about the rain.', cards, 'rachel', false)).toEqual(['rachel']);
  });
  it('merges a character’s contributions without repeating their header or reading labels', () => {
    const content = 'Rachel: Hello, Wren.\nWren: Hi.\nNarrator: Rain falls.\nRachel: Good to see you.';
    expect(characterBubbles(content, names, 'rachel').map((part) => part.speakerId)).toEqual(['rachel', 'wren', null]);
    const parts = messageSpeechParts({ id: 'reply', role: 'assistant', speakerId: 'rachel', content, createdAt: 1 }, cards, config);
    expect(parts.map((part) => part.text)).toEqual(['Hello, Wren.\n\nGood to see you.', 'Hi.', 'Rain falls.']);
    expect(parts.map((part) => part.config.tts?.voice)).toEqual(['coral', 'af_bella', 'onyx']);
    expect(parts.map((part) => part.config.tts?.backend_mode)).toEqual(['api', 'local', 'api']);
  });
  it('inherits the API default without borrowing a local voice or mutating settings', () => {
    const resolved = voiceConfig({ ...config, tts: { ...config.tts, backend_mode: 'api', api_provider: 'openai' } });
    expect(resolved.tts?.voice).toBe('alloy');
    expect(config.tts?.voice).toBe('af_heart');
  });
});
