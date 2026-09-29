import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ttsStore } from './tts.svelte';
import { toastStore } from './toast.svelte';
import type { AppConfig } from '$lib/types/chat';

const handlers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
const requests: Array<Record<string, unknown>> = [];
const sources: Array<{ onended: (() => void) | null; start: ReturnType<typeof vi.fn> }> = [];
const config = { tts: { voice: 'af_bella' } } as AppConfig;
const pcm = Buffer.from([0, 0, 255, 127, 0, 128, 0, 64]).toString('base64');

class TestAudioContext {
  currentTime = 1;
  state = 'suspended';
  destination = {};
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: vi.fn() };
  }
  createBufferSource() {
    const source = { onended: null as (() => void) | null, start: vi.fn(), connect: vi.fn(), buffer: null };
    sources.push(source);
    return source;
  }
}

function emit(channel: string, requestId: unknown, fields: Record<string, unknown> = {}) {
  // seq deliberately bears no relation to the renderer's cancellation count.
  for (const handler of handlers.get(channel) ?? []) handler({ requestId, seq: 87, ...fields });
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear(); requests.length = sources.length = 0;
  vi.stubGlobal('AudioContext', TestAudioContext);
  vi.stubGlobal('window', { electronAPI: {
    isElectron: true,
    invoke: vi.fn(async (channel: string, args?: { request?: Record<string, unknown> }) => {
      if (channel === 'generate_tts_stream') requests.push(args!.request!);
      return { ok: true };
    }),
    on: (channel: string, callback: (event: Record<string, unknown>) => void) => {
      const subscribers = handlers.get(channel) ?? new Set();
      handlers.set(channel, subscribers); subscribers.add(callback);
      return () => subscribers.delete(callback);
    }
  } });
  ttsStore.stop();
  ttsStore.audioBuffers.clear(); ttsStore.storedAudioIds = new Set();
  ttsStore.lastError = null; toastStore.toasts = [];
  ttsStore.onAudioComplete = vi.fn();
});

afterEach(() => {
  ttsStore.stop(); ttsStore.onAudioComplete = null;
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('audio.cpp playback requests', () => {
  it('plays matched PCM even after repeated cancellation has advanced the engine sequence', async () => {
    ttsStore.stop(); ttsStore.stop();
    await ttsStore.speak('message', 'Read this aloud.', config);
    const id = requests[0].requestId;
    emit('tts-start', id, { total: 1 });
    emit('tts-chunk', id, { index: 0, total: 1, base64: pcm });
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalled();
    emit('tts-done', id, { total: 1 });
    expect(ttsStore.isGenerating).toBe(false);
    expect(ttsStore.playing).toBe(true);
    sources[0].onended?.();
    expect(ttsStore.playing).toBe(false);
    expect(ttsStore.hasStoredAudio('message')).toBe(true);
    expect([...ttsStore.audioBuffers.get('message')!]).toEqual([0, 32767 / 32768, -1, 0.5]);
    expect(ttsStore.onAudioComplete).toHaveBeenCalledOnce();
  });

  it('keeps playing when synthesis finishes after the last clip has already ended', async () => {
    await ttsStore.speak('message', 'Two sentences.', config);
    const id = requests[0].requestId;
    emit('tts-chunk', id, { index: 0, total: 2, base64: pcm });
    sources[0].onended?.();
    expect(ttsStore.playing).toBe(true);
    emit('tts-chunk', id, { index: 1, total: 2, base64: pcm });
    sources[1].onended?.();
    emit('tts-done', id, { total: 2 });
    expect(ttsStore.playing).toBe(false);
    expect(ttsStore.audioBuffers.get('message')).toHaveLength(8);
  });

  it('ignores old events and old audio completion when another message starts', async () => {
    await ttsStore.speak('old', 'First message.', config);
    const old = requests[0].requestId;
    emit('tts-chunk', old, { index: 0, total: 1, base64: pcm });
    const oldSource = sources[0];
    await ttsStore.speak('new', 'Second message.', config);
    emit('tts-done', old, { total: 1 }); oldSource.onended?.();
    emit('tts-chunk', old, { index: 1, total: 2, base64: pcm });
    expect(ttsStore.currentMessageId).toBe('new');
    expect(ttsStore.playing).toBe(true);
    expect(sources).toHaveLength(1);
    emit('tts-chunk', requests[1].requestId, { index: 0, total: 1, base64: pcm });
    expect(sources).toHaveLength(2);
  });

  it('surfaces voice-engine errors and clears the pending player', async () => {
    await ttsStore.speak('message', 'Read this aloud.', config);
    emit('tts-error', requests[0].requestId, { message: 'Download a voice model in Settings → Voice first.' });
    expect(ttsStore.playing).toBe(false);
    expect(ttsStore.isGenerating).toBe(false);
    expect(toastStore.toasts[0].message).toMatch(/Download a voice model/);
    expect(ttsStore.hasStoredAudio('message')).toBe(false);
    expect(ttsStore.onAudioComplete).not.toHaveBeenCalled();
  });
});
