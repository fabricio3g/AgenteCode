import { describe, expect, it } from 'vitest';
import en from '$lib/locales/en.json';
import { COPY_EN } from './en';
import { COPY_OVERRIDES } from './locales';
import { resolveCopy } from './copy.svelte';

const JSON_LOCALES = import.meta.glob<{ default: Record<string, unknown> }>('../locales/*.json', { eager: true });

function leafKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [prefix];
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  );
}

describe('locale completeness', () => {
  const englishKeys = new Set(leafKeys(en));

  for (const [path, module] of Object.entries(JSON_LOCALES)) {
    if (path.endsWith('/en.json')) continue;
    it(`${path} has every English message key`, () => {
      const keys = new Set(leafKeys(module.default));
      expect([...englishKeys].filter((key) => !keys.has(key))).toEqual([]);
    });
  }

  const copyKeys = leafKeys(COPY_EN);
  for (const [code, override] of Object.entries(COPY_OVERRIDES)) {
    it(`copy is fully translated for ${code}`, () => {
      const keys = new Set(leafKeys(override));
      expect(copyKeys.filter((key) => !keys.has(key))).toEqual([]);
    });
  }

  it('has an English message for every key the app asks for', () => {
    const sources = import.meta.glob<string>(['../**/*.svelte', '../**/*.ts', '!../**/*.spec.ts'], { query: '?raw', import: 'default', eager: true });
    const used = new Set(Object.values(sources).flatMap((source) => [...source.matchAll(/\$t\('([\w.]+)'/g)].map((match) => match[1])));
    expect(used.size).toBeGreaterThan(500);
    expect([...used].filter((key) => !englishKeys.has(key)).sort()).toEqual([]);
  });

  it('falls back to English for unknown locales', () => {
    expect(resolveCopy('xx').actions.save).toBe('Save');
    expect(resolveCopy('es').actions.save).toBe('Guardar');
  });
});
