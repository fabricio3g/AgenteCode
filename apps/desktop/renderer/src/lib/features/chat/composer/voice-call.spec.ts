import { afterEach, expect, it, vi } from 'vitest';
import { VoiceCall } from './voice-call.svelte';
const microphone = vi.hoisted(() => vi.fn());
vi.mock('./mic-probe', () => ({ requestMicrophone: microphone, micStateFromError: () => 'blocked' }));
vi.mock('$lib/services/stt', () => ({ sttTranscribe: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('releases a microphone permission result arriving after the call ended', async () => {
  let resolve!: (stream: MediaStream) => void;
  microphone.mockImplementation(() => new Promise<MediaStream>(done => { resolve = done; }));
  const stop = vi.fn();
  const call = new VoiceCall({ onSpeech: vi.fn(), onText: vi.fn() });
  const pending = call.start();
  expect(call.phase).toBe('permission');
  call.stop();
  resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await pending;
  expect(stop).toHaveBeenCalledOnce();
  expect(call.phase).toBe('idle');
});
it('does not restart capture after a denied permission', async () => {
  microphone.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  const call = new VoiceCall({ onSpeech: vi.fn(), onText: vi.fn() });
  await call.start();
  expect(call.phase).toBe('error');
  expect(call.error).toContain('blocked');
  expect(microphone).toHaveBeenCalledOnce();
});
