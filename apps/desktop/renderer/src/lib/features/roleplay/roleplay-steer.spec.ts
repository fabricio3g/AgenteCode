import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { cleanDraft, impersonationMessages, joinContinuation, summaryDue, transcript, unsummarized } from './roleplay-steer';

const msg = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 0, done: true });

describe('roleplay steering', () => {
  const turns = [msg('u1', 'user', 'Hi.'), msg('a1', 'assistant', 'Hello.'), msg('u2', 'user', 'Where to?'), msg('a2', 'assistant', 'North.')];

  it('writes a transcript with each speaker named', () => {
    expect(transcript(turns.slice(0, 2), (m) => (m.role === 'user' ? 'Kai' : 'Ren'))).toBe('Kai: Hi.\n\nRen: Hello.');
  });

  it('summarizes only the turns after the last summary, when enough replies piled up', () => {
    const summary = { text: 'They met.', throughId: 'a1', updatedAt: 1 };
    expect(unsummarized(turns, summary).map((m) => m.id)).toEqual(['u2', 'a2']);
    expect(summaryDue(turns, summary, 1)).toBe(true);
    expect(summaryDue(turns, summary, 2)).toBe(false);
    expect(summaryDue(turns, null, 2)).toBe(true);
    expect(summaryDue(turns, null, 0)).toBe(false);
  });

  it('updates early when the context is nearly full', () => {
    expect(summaryDue(turns, null, 8, 0.75)).toBe(true);
    expect(summaryDue(turns, null, 8, 0.5)).toBe(false);
  });

  it('asks for the user line only, in their voice', () => {
    const [system] = impersonationMessages({ userName: 'Kai', persona: 'A tired courier.', characters: ['Ren'], transcript: '' });
    expect(system.content).toContain("Write only Kai's next message");
    expect(system.content).toContain('A tired courier.');
  });

  it('cleans a draft of its name label and quotes', () => {
    expect(cleanDraft('Kai: "I shrug."', 'Kai')).toBe('I shrug.');
    expect(cleanDraft('**Kai:** Fine.', 'Kai')).toBe('Fine.');
  });

  it('joins a continuation mid-sentence or as a new paragraph', () => {
    expect(joinContinuation('She turned', ' away.')).toBe('She turned away.');
    expect(joinContinuation('She left.', 'Rain fell.')).toBe('She left.\n\nRain fell.');
  });
});
