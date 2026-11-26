import { describe, expect, it } from 'vitest';
import { faviconUrlFor, needsDarkModeInvert } from './site-favicon';

describe('site favicon helpers', () => {
  it('only emits origin favicons for public HTTPS URLs', () => {
    expect(faviconUrlFor('https://github.com/anomalyco/opencode')).toBe('https://github.com/favicon.ico');
    expect(faviconUrlFor('http://example.com')).toBeNull();
    expect(faviconUrlFor('https://localhost:5173')).toBeNull();
    expect(faviconUrlFor('https://127.0.0.1/test')).toBeNull();
  });

  it('flags known black-monochrome favicon hosts for dark-mode inversion', () => {
    expect(needsDarkModeInvert('github.com')).toBe(true);
    expect(needsDarkModeInvert('https://gist.github.com/abc')).toBe(true);
    expect(needsDarkModeInvert('https://www.vercel.com/docs')).toBe(true);
    expect(needsDarkModeInvert('https://example.com')).toBe(false);
  });
});
