import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveWhisperContext } from '../../main/voice/whisper-window.ts';
function wav(seconds) {
  const size = Math.round(seconds * 16000) * 2;
  const bytes = Buffer.alloc(44 + size); bytes.write('RIFF'); bytes.writeUInt32LE(36 + size, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(16000,24); bytes.writeUInt32LE(32000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(size,40);
  return bytes;
}
test('live encoder windows retain all samples plus padding across duration boundaries', () => {
  for (const seconds of [.1, 1, 4.125, 5.13, 10, 15, 20, 27, 35, 60]) {
    const context = liveWhisperContext(wav(seconds));
    if (context) { assert.ok(context >= 256); assert.ok(context < 1500); assert.ok(context / 50 >= seconds + .8); }
    else assert.ok(seconds >= 27);
  }
  assert.equal(liveWhisperContext(wav(4.125)), 256);
  assert.equal(liveWhisperContext(wav(60)), 0, 'long clips retain normal windowing');
});
test('unsupported and truncated recordings retain default inference rather than losing audio', () => {
  assert.equal(liveWhisperContext(Buffer.alloc(20)), 0);
  assert.equal(liveWhisperContext(wav(4).subarray(0,50)), 0);
  const stereo = wav(4); stereo.writeUInt16LE(2,22); assert.equal(liveWhisperContext(stereo),0);
  const compressed = wav(4); compressed.writeUInt16LE(3,20); assert.equal(liveWhisperContext(compressed),0);
});
