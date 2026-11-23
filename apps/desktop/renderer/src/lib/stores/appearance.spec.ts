import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  getTitlebarColors,
  hexToRgbTriplet,
  isIntegratedComposerStyle,
  normalizeHexColor,
  parseAppearance,
  resolveColorMode
} from '$shared/appearance';
import { windowThemeBootstrap, windowThemeCss } from '$shared/window-theme';

describe('appearance shared helpers', () => {
  it('returns defaults for null or malformed JSON', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{bad json')).toEqual(DEFAULT_APPEARANCE);
  });

  it('respects legacy theme when appearance storage is absent', () => {
    expect(parseAppearance(null, 'light').mode).toBe('light');
    expect(parseAppearance(null, 'dark').mode).toBe('dark');
  });

  it('sanitizes unknown values while keeping valid fields', () => {
    const parsed = parseAppearance(
      JSON.stringify({
        mode: 'system',
        theme: 'parchment',
        accent: 'terracotta',
        customAccentHex: '#abc',
        uiStyle: 'sharp',
        composerStyle: 'card',
        tintedUserBubbles: true
      })
    );
    expect(parsed).toEqual({
      mode: 'system',
      theme: 'parchment',
      accent: 'terracotta',
      customAccentHex: '#aabbcc',
      uiStyle: 'sharp',
      composerStyle: 'card',
      tintedUserBubbles: true
    });

    const invalid = parseAppearance(
      JSON.stringify({
        mode: 'neon',
        theme: 'unknown',
        accent: 'rainbow',
        customAccentHex: 'not-a-hex',
        uiStyle: 'weird',
        composerStyle: 'floating',
        tintedUserBubbles: 'yes'
      })
    );
    expect(invalid).toEqual(DEFAULT_APPEARANCE);
  });

  it('normalizes hex colors and converts to RGB triplets', () => {
    expect(normalizeHexColor('#F0A')).toBe('#ff00aa');
    expect(normalizeHexColor('  #3B82F6 ')).toBe('#3b82f6');
    expect(normalizeHexColor('invalid', '#112233')).toBe('#112233');
    expect(hexToRgbTriplet('#e8793a')).toBe('232 121 58');
  });

  it('resolves color mode against system preference', () => {
    expect(resolveColorMode('system', true)).toBe('dark');
    expect(resolveColorMode('system', false)).toBe('light');
    expect(resolveColorMode('light', true)).toBe('light');
    expect(resolveColorMode('dark', false)).toBe('dark');
  });

  it('reports integrated composer layout for non-default prompt shells', () => {
    expect(isIntegratedComposerStyle('agente')).toBe(false);
    expect(isIntegratedComposerStyle('pill')).toBe(true);
    expect(isIntegratedComposerStyle('card')).toBe(true);
    expect(isIntegratedComposerStyle('terminal')).toBe(true);
    expect(isIntegratedComposerStyle('minimal')).toBe(true);
  });

  it('provides titlebar colors and startup CSS/bootstrap for all themes', () => {
    expect(getTitlebarColors('parchment', 'dark')).toEqual({ color: '#1f1d1a', symbolColor: '#f4f0e8' });
    expect(getTitlebarColors('midnight', 'dark')).toEqual({ color: '#0f1012', symbolColor: '#f3f4f6' });

    const css = windowThemeCss();
    expect(css).toContain(':root[data-theme="parchment"]');
    expect(css).toContain(':root.dark[data-theme="midnight"]');

    const bootstrap = windowThemeBootstrap();
    expect(bootstrap).toContain('agente_appearance');
    expect(bootstrap).toContain('composerStyle');
  });
});
