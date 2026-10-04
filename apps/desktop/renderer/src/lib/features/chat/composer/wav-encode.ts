/**
 * Recorded audio → the 16 kHz mono 16-bit WAV whisper.cpp reads directly.
 * Doing it here means the app never needs ffmpeg on the user's machine.
 */

export const WHISPER_SAMPLE_RATE = 16_000;

/** PCM16 WAV bytes for mono float samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate = WHISPER_SAMPLE_RATE): Uint8Array {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(bytes);
}

/** Decode any recording the browser can play, downmix and resample to 16 kHz. */
export async function recordingToWav(blob: Blob, range?: { start: number; end: number }): Promise<Uint8Array> {
  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void decodeContext.close();
  }
  const start = Math.max(0, Math.min(decoded.duration, range?.start ?? 0));
  const end = Math.max(start, Math.min(decoded.duration, range?.end ?? decoded.duration));
  const duration = end - start;
  const frames = Math.max(1, Math.ceil(duration * WHISPER_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination); // a mono destination downmixes the channels
  source.start(0, start, duration);
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0));
}
