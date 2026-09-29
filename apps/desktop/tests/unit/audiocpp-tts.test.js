import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeWav, splitSentences, toPlayerPcm } from '../../main/voice/audiocpp-tts.ts';
import { VOICE_MODELS, voiceLanguage, voiceModelRelPath } from '../../shared/voice-models.ts';

/** A mono 16-bit WAV at `rate` holding `samples`. */
function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(value * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('audio.cpp speech for the player', () => {
  it('decodes WAV and resamples to 24 kHz 16-bit PCM', () => {
    const { samples, rate } = decodeWav(wav([0, 0.5, -0.5, 0.25], 48000));
    assert.equal(rate, 48000);
    assert.equal(samples.length, 4);
    assert.ok(Math.abs(samples[1] - 0.5) < 1e-3);
    const pcm = Buffer.from(toPlayerPcm(samples, rate, 1), 'base64');
    assert.equal(pcm.length / 2, 2, '48 kHz halves to 24 kHz');
    assert.equal(pcm.readInt16LE(0), 0);
  });

  it('applies volume and clamps', () => {
    const pcm = Buffer.from(toPlayerPcm(new Float32Array([0.8]), 24000, 2), 'base64');
    assert.equal(pcm.readInt16LE(0), 32767);
  });

  it('speaks sentence by sentence, merging short ones', () => {
    const long = 'The first sentence is long enough to be spoken on its own right away. The second one follows it.';
    assert.deepEqual(splitSentences(long), [
      'The first sentence is long enough to be spoken on its own right away.',
      'The second one follows it.'
    ]);
    assert.deepEqual(splitSentences('Hi. How are you?'), ['Hi. How are you?']);
    assert.deepEqual(splitSentences('   '), []);
  });

  it('knows each voice and where its model lives', () => {
    const kokoro = VOICE_MODELS.find((model) => model.id === 'kokoro-82m');
    const supertonic = VOICE_MODELS.find((model) => model.id === 'supertonic-3');
    assert.equal(voiceLanguage(kokoro, 'zf_xiaobei', 'en'), 'zh');
    assert.equal(voiceLanguage(supertonic, 'F1', 'es'), 'es');
    assert.equal(voiceModelRelPath(kokoro), 'audiocpp/kokoro-82m/kokoro-82m-q8_0.gguf');
    assert.equal(supertonic.espeakLanguages.length, 0);
  });
});
