// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ isElectron: vi.fn(() => true), invoke: vi.fn() }));
vi.mock('$lib/services/bridge', () => bridge);
import { writeToClipboard } from './clipboard';

beforeEach(() => { bridge.invoke.mockReset(); bridge.isElectron.mockReturnValue(true); });
describe('message clipboard', () => {
  it('uses native Electron without requiring browser clipboard focus', async () => {
    bridge.invoke.mockResolvedValue({ ok: true });
    const text = 'Full message\nUnicode: 日 · ñ';
    expect(await writeToClipboard(text)).toBe(true);
    expect(bridge.invoke).toHaveBeenCalledWith('clipboard_write', { text });
  });
  it('uses the selection fallback when the native and browser APIs reject', async () => {
    bridge.invoke.mockRejectedValue(new Error('Unavailable'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Not focused')) } });
    const copy = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
    expect(await writeToClipboard('Selected text')).toBe(true);
    expect(copy).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('does not replace the clipboard with an empty message', async () => {
    expect(await writeToClipboard('')).toBe(false);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});
