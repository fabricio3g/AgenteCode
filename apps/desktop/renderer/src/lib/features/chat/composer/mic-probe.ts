/**
 * Is there a microphone we can use, and if not, why not?
 *
 * Capture is authoritative: Linux can expose an empty device list before
 * the first successful permission request. An empty list is not a denial.
 */

export type MicState = 'ready' | 'none' | 'blocked' | 'busy' | 'unsupported';

export type MicProbe = { state: MicState; devices: MediaDeviceInfo[] };

export function micStateFromError(err: unknown): MicState {
  const name = err instanceof DOMException || (err && typeof err === 'object' && 'name' in err) ? String((err as { name: string }).name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'blocked';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'none';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'blocked';
}

async function audioInputs(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  } catch {
    return [];
  }
}

/** Any microphone plugged in at all (no permission prompt). */
export async function hasMicrophone(): Promise<boolean> {
  return (await audioInputs()).length > 0;
}

/** Retry a stale persisted device id after USB reconnection, using the OS default. */
export async function requestMicrophone(deviceId?: string): Promise<MediaStream> {
  const options = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...options, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (!deviceId || !['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(name)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: options });
  }
}

export async function probeMicrophone(): Promise<MicProbe> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return { state: 'unsupported', devices: [] };
  try {
    const stream = await requestMicrophone();
    stream.getTracks().forEach((track) => track.stop());
  } catch (err) {
    return { state: micStateFromError(err), devices: await audioInputs() };
  }
  // Labels are only filled in once access was granted.
  return { state: 'ready', devices: await audioInputs() };
}

/** Call `onChange` whenever a microphone is plugged in or removed. */
export function watchMicrophones(onChange: () => void): () => void {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.addEventListener) return () => {};
  devices.addEventListener('devicechange', onChange);
  return () => devices.removeEventListener('devicechange', onChange);
}
