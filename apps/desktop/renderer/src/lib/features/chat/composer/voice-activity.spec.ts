import { expect, it } from 'vitest';
import { PendingSpeech, spokenTranscript, voiceLikeSpectrum, SpokenReply, VoiceActivity } from './voice-activity';
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

it('rejects loud sustained non-speech without blocking a subsequent spoken reply', () => {
  const vad = new VoiceActivity();
  for (let now = 0; now < 5000; now += 40) expect(vad.sample(.06, now, false)).toBeUndefined();
  expect(vad.sample(.04, 5000, true)).toBeUndefined();
  expect(vad.sample(.04, 5160, true)).toBe('start');
  expect(vad.sample(.06, 5800, false)).toBe('end');
});
it('rejects broad hiss, low hum and a single tone, but passes a speech-like harmonic spectrum', () => {
  expect(voiceLikeSpectrum(new Float32Array(512).fill(-35), 48000)).toBe(false);
  const silent = new Float32Array(512).fill(-Infinity);
  expect(voiceLikeSpectrum(silent, 48000)).toBe(false);
  const hum = silent.slice(); hum[1] = -20;
  expect(voiceLikeSpectrum(hum, 48000)).toBe(false);
  const tone = silent.slice(); tone[20] = -20;
  expect(voiceLikeSpectrum(tone, 48000)).toBe(false);
  const voice = new Float32Array(512).fill(-95);
  for (let bin = 4; bin < 100; bin += 4) voice[bin] = -35 - bin / 10;
  expect(voiceLikeSpectrum(voice, 48000)).toBe(true);
  const lowVoice = new Float32Array(512).fill(-95);
  for (let bin = 2; bin < 40; bin += 2) lowVoice[bin] = -35 - bin / 3;
  expect(voiceLikeSpectrum(lowVoice, 48000)).toBe(true);
});
it('ignores explicit non-speech transcripts but preserves short and multilingual replies', () => {
  for (const text of ['[BLANK_AUDIO]', '[noise]', '(music)', '...', '']) expect(spokenTranscript(text)).toBeUndefined();
  for (const text of ['Yes.', 'No', 'Sí', '你好', 'ありがとう', '42']) expect(spokenTranscript(text)).toBe(text);
});

it('holds early transcripts through pauses and sends a single complete spoken turn', () => {
  const speech = new PendingSpeech();
  speech.heard(0); speech.append('Find the');
  expect(speech.take(700, 0, false)).toBeUndefined();
  speech.heard(900);
  expect(speech.take(1800, 0, true)).toBeUndefined();
  speech.heard(1900); speech.append('project documentation.');
  expect(speech.take(3500, 1, false)).toBeUndefined();
  expect(speech.take(3500, 0, false)).toBe('Find the project documentation.');
  expect(speech.take(5000, 0, false)).toBeUndefined();
});
it('does not send a slow transcript while the user has resumed speaking, and discards ended calls', () => {
  const speech = new PendingSpeech();
  speech.heard(0); speech.heard(2900); speech.append('First part');
  expect(speech.take(3000, 0, false)).toBeUndefined();
  speech.clear(); expect(speech.take(8000, 0, false)).toBeUndefined();
});
