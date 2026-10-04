/** Whisper encoder positions span 20 ms each. Live WAV clips can avoid
 * encoding a full 30-second window, retaining padding and every audio frame.
 * Unknown formats and long clips retain the engine's default window.
 */
export function liveWhisperContext(wav: Buffer): number {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let offset = 12, rate = 0, align = 0, pcm = false, dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > wav.length) return 0;
    if (tag === 'fmt ' && size >= 16) {
      pcm = wav.readUInt16LE(body) === 1 && wav.readUInt16LE(body + 2) === 1 && wav.readUInt16LE(body + 14) === 16;
      rate = wav.readUInt32LE(body + 4); align = wav.readUInt16LE(body + 12);
    } else if (tag === 'data') dataBytes += size;
    offset = body + size + (size % 2);
  }
  if (!pcm || rate !== 16000 || align !== 2 || !dataBytes || dataBytes % align) return 0;
  const seconds = dataBytes / (rate * align);
  const positions = Math.max(256, Math.ceil((seconds + .8) * 50 / 128) * 128);
  return positions < 1500 ? positions : 0;
}
