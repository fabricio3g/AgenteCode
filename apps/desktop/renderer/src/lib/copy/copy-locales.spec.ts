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

/**
 * Placeholders a message actually consumes: `{n}`, or the `{n, plural, …}`
 * that opens a plural. ICU branch bodies (`=0 {Connected}`) look identical to a
 * hole and are filtered out by SUPPLIED — nothing ever passes `Connected` as a
 * value, so it cannot be one.
 */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const holes = [...value.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[,}]/g)].map((match) => match[1]);
  return [...new Set(holes.filter((name) => SUPPLIED.has(name)))].sort();
}

function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { [prefix]: value };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key))
  ));
}

const SOURCES = import.meta.glob<string>(['../**/*.svelte', '../**/*.ts', '!../**/*.spec.ts'], { query: '?raw', import: 'default', eager: true });

/** Every value name some call site passes as `$t(key, { values: { … } })`. */
const SUPPLIED = new Set(Object.values(SOURCES).flatMap((source) =>
  [...source.matchAll(/values:\s*\{([^}]*)\}/g)]
    .flatMap(([, body]) => [...body.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:/g)].map(([, name]) => name))));

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
    const used = new Set(Object.values(SOURCES).flatMap((source) => [...source.matchAll(/\$t\('([\w.]+)'/g)].map((match) => match[1])));
    expect(used.size).toBeGreaterThan(500);
    expect([...used].filter((key) => !englishKeys.has(key)).sort()).toEqual([]);
  });

  /*
   * The bug this catches: a component reaching for a key that only half the
   * work added, so svelte-i18n printed `promptQueue.send` straight onto the
   * button. Usage is checked above; this checks the other direction — a
   * translation that drops a value the English message interpolates, which
   * renders the number nowhere at all.
   */
  it('keeps every locale consuming the same values as English', () => {
    const english = flatten(en);
    const drifted: string[] = [];
    for (const [path, module] of Object.entries(JSON_LOCALES)) {
      if (path.endsWith('/en.json')) continue;
      const translated = flatten(module.default);
      for (const key of leafKeys(module.default).filter((key) => key in english)) {
        const expected = placeholders(english[key]).join(',');
        const actual = placeholders(translated[key]).join(',');
        if (actual !== expected) drifted.push(`${path} ${key}: wants {${expected}} but has {${actual}}`);
      }
    }
    expect(drifted.sort()).toEqual([]);
  });

  /*
   * Keys built at runtime cannot be matched literally, so the static check
   * above skips them. Assert the namespace they hang off still exists — a
   * renamed subtree shows up as a whole block of raw keys at once, which is
   * exactly the failure these two screenshots caught.
   */
  it('resolves the namespace behind every interpolated key', () => {
    const orphans = [...new Set(Object.values(SOURCES).flatMap((source) =>
      [...source.matchAll(/\$t\(\s*`([^`$]*)\$\{/g)].map((match) => match[1])
    ))].filter((prefix) => prefix && ![...englishKeys].some((key) => key.startsWith(prefix))).sort();
    expect(orphans).toEqual([]);
  });

  // WorkspaceHost interpolates over literal arrays; pin those closed sets.
  it.each([
    ['workspace', ['center', 'left', 'right', 'top', 'bottom']],
    ['workspace.resizeEdges', ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']]
  ])('resolves every value of %s', (prefix, values) => {
    const missing = values.filter((value) => !englishKeys.has(`${prefix}.${value}`));
    expect(missing).toEqual([]);
  });

  /*
   * The rail is the app's most-translated surface, and the one place that
   * drifted: SearchSidebar shipped "Source Search" and "No results yet…" in
   * English only, and nothing could see it — the file never called `t()` at
   * all, so "every key the app asks for" had nothing to look at. Assert the
   * rail carries no literal user-facing text instead.
   */
  it('keeps the sidebar rail free of hardcoded copy', () => {
    const rail = Object.entries(SOURCES).filter(([path]) =>
      /(?:components\/layout\/(?:Sidebar|SidebarInstances)|components\/search\/SearchSidebar|features\/(?:shared\/SessionRow|code\/CodeSidebar|bots\/BotRoster))\.svelte$/.test(path)
    );
    expect(rail.map(([path]) => path).sort()).toHaveLength(6);

    const offenders = rail.flatMap(([path, text]) => [
      ...[...text.matchAll(/\s(?:aria-label|placeholder|title|alt)="([^"{][^"]*)"/g)].map((match) => `${path} ${match[0].trim()}`),
      ...[...text.matchAll(/>\s*([A-Z][A-Za-z]+(?: [A-Za-z]+){0,4})\s*</g)].map((match) => `${path} >${match[1]}<`)
    ]);
    expect(offenders).toEqual([]);
  });

  it('falls back to English for unknown locales', () => {
    expect(resolveCopy('xx').actions.save).toBe('Save');
    expect(resolveCopy('es').actions.save).toBe('Guardar');
  });
});
