import { describe, expect, it } from 'vitest';
import { encodeWav, WHISPER_SAMPLE_RATE } from './wav-encode';

describe('encodeWav', () => {
  it('writes a 16 kHz mono PCM16 header whisper.cpp accepts', () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const view = new DataView(bytes.buffer);
    const text = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(WHISPER_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(bytes.length).toBe(44 + 10);
  });

  it('clamps and scales samples to 16-bit', () => {
    const view = new DataView(encodeWav(new Float32Array([1, -1, 2, -2, 0])).buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(50, true)).toBe(-32768);
    expect(view.getInt16(52, true)).toBe(0);
  });
});
