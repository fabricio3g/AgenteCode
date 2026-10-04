import { expect, it } from 'vitest';
import { SpokenReply, VoiceActivity } from './voice-activity';
it('ignores clicks and low noise, then endpoints a spoken utterance', () => {
  const vad = new VoiceActivity();
  expect(vad.sample(.002, 0)).toBeUndefined();
  expect(vad.sample(.08, 100)).toBeUndefined();
  expect(vad.sample(.002, 150)).toBeUndefined();
  expect(vad.sample(.04, 200)).toBeUndefined();
  expect(vad.sample(.04, 330)).toBe('start');
  expect(vad.sample(.002, 900)).toBeUndefined();
  expect(vad.sample(.002, 1200)).toBe('end');
});
it('bounds continuous speech without a pause', () => {
  const vad = new VoiceActivity(); vad.sample(.04, 0); vad.sample(.04, 130);
  expect(vad.sample(.04, 20_131)).toBe('end');
});
it('speaks streaming sentences once, flushes the tail, and skips interrupted playback', () => {
  const reply = new SpokenReply();
  expect(reply.take('Checking the', false)).toBeUndefined();
  expect(reply.take('Checking the source. Still', false)).toBe('Checking the source.');
  expect(reply.take('Checking the source. Still looking', false)).toBeUndefined();
  reply.skip('Checking the source. Still looking');
  expect(reply.take('Checking the source. Still looking. Found it.', true)).toBe('. Found it.');
  expect(reply.take('Checking the source. Still looking. Found it.', true)).toBeUndefined();
});

it('starts a long streaming reply at a natural clause before the sentence finishes', () => {
  const reply = new SpokenReply();
  const text = 'I found the information you asked for, and I can explain the result while the background search keeps running';
  expect(reply.take(text, false)).toBe('I found the information you asked for,');
  expect(reply.take(text, true)).toBe('and I can explain the result while the background search keeps running');
});
