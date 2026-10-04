import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav, recordingToWav, WHISPER_SAMPLE_RATE } from './wav-encode';

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

afterEach(() => vi.unstubAllGlobals());
it('sends only the utterance range to transcription, not the preceding idle recording', async () => {
  const start = vi.fn();
  const close = vi.fn(async () => {});
  const render = vi.fn(async () => ({ getChannelData: () => new Float32Array(6400) }));
  const constructor = vi.fn();
  vi.stubGlobal('AudioContext', class { close = close; decodeAudioData = async () => ({ duration: 8 }); });
  vi.stubGlobal('OfflineAudioContext', class {
    destination = {};
    constructor(...args: unknown[]) { constructor(...args); }
    createBufferSource() { return { buffer: null, connect: vi.fn(), start }; }
    startRendering = render;
  });
  const wav = await recordingToWav({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob, { start: 2.8, end: 3.2 });
  expect(start.mock.calls[0]?.[0]).toBe(0);
  expect(start.mock.calls[0]?.[1]).toBe(2.8);
  expect(start.mock.calls[0]?.[2]).toBeCloseTo(.4);
  expect(constructor.mock.calls[0]?.[1]).toBeLessThanOrEqual(6401);
  expect(wav.length).toBe(44 + 6400 * 2);
  expect(close).toHaveBeenCalledOnce();
});
