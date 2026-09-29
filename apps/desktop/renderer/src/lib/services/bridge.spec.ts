import { describe, expect, it } from 'vitest';
import { cloneable } from './bridge';

describe('cloneable', () => {
  it('keeps values IPC can copy and turns proxies into plain data', () => {
    const plain = { a: [1, 2] };
    expect(cloneable(plain)).toBe(plain);
    const proxied = new Proxy({ attachments: [{ name: 'a.png' }] }, {});
    // structuredClone refuses proxies, as it does Svelte's $state.
    expect(() => structuredClone(proxied)).toThrow();
    expect(cloneable(proxied)).toEqual({ attachments: [{ name: 'a.png' }] });
    expect(cloneable(undefined)).toBeUndefined();
  });
});
