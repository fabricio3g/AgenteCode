import { afterEach, describe, expect, it, vi } from 'vitest';
import { micStateFromError, probeMicrophone, requestMicrophone } from './mic-probe';

describe('micStateFromError', () => {
  it('tells "nothing plugged in" apart from "access denied"', () => {
    expect(micStateFromError(new DOMException('x', 'NotFoundError'))).toBe('none');
    expect(micStateFromError(new DOMException('x', 'NotAllowedError'))).toBe('blocked');
    expect(micStateFromError(new DOMException('x', 'NotReadableError'))).toBe('busy');
  });
});


afterEach(() => vi.unstubAllGlobals());
it('captures even when Ubuntu initially enumerates no inputs', async () => {
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: vi.fn(async () => []), getUserMedia } });
  expect((await probeMicrophone()).state).toBe('ready');
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});
it('falls back to the system microphone when a saved USB device id expired', async () => {
  const stream = { getTracks: () => [] };
  const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException('USB reconnected', 'OverconstrainedError')).mockResolvedValueOnce(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  expect(await requestMicrophone('old-usb-id')).toBe(stream);
  expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'old-usb-id' });
  expect(getUserMedia.mock.calls[1][0].audio.deviceId).toBeUndefined();
});
it('does not retry a denied microphone permission', async () => {
  const getUserMedia = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  await expect(requestMicrophone('usb')).rejects.toMatchObject({ name: 'NotAllowedError' });
  expect(getUserMedia).toHaveBeenCalledOnce();
});
