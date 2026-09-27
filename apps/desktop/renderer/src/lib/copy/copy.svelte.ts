/**
 * Shared UI strings in the current UI language.
 *
 * `copy` is one reactive object: templates read `copy.actions.save` and
 * re-render when the language changes, because the object is rebuilt in place
 * from the English source (`en.ts`) plus the locale's overrides (`locales.ts`).
 */

import { locale } from 'svelte-i18n';
import { COPY_EN } from './en';
import { COPY_OVERRIDES, SAY_STRINGS, type CopyOverride, type CopyStrings } from './locales';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** English with the locale's keys laid over it; arrays are replaced whole. */
export function resolveCopy(code: string | null | undefined): CopyStrings {
  const override: CopyOverride | undefined = code ? COPY_OVERRIDES[code] : undefined;
  const merge = (base: unknown, over: unknown): unknown => {
    if (over === undefined) return structuredClone(base);
    if (!isRecord(base) || !isRecord(over)) return structuredClone(over);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(base)) out[key] = merge(base[key], over[key]);
    return out;
  };
  return merge(COPY_EN, override) as CopyStrings;
}

let currentLocale = $state('en');

export const copy: CopyStrings = $state(resolveCopy('en'));

function apply(code: string | null | undefined) {
  const next = resolveCopy(code);
  currentLocale = code && SAY_STRINGS[code] ? code : 'en';
  for (const key of Object.keys(next) as Array<keyof CopyStrings>) {
    (copy as Record<string, unknown>)[key] = next[key];
  }
}

locale.subscribe((code) => apply(code));

function counted(count: number, noun: keyof (typeof SAY_STRINGS)['en']['nouns']): string {
  const strings = SAY_STRINGS[currentLocale] ?? SAY_STRINGS.en!;
  const [one, other] = strings.nouns[noun];
  const word = new Intl.PluralRules(currentLocale).select(count) === 'one' ? one : other;
  // CJK counters attach to the number without a space.
  return currentLocale === 'ja' || currentLocale === 'zh' ? `${count}${word}` : `${count} ${word}`;
}

/**
 * Interpolated copy. The sentence shape stays here; only values come from
 * callers. Counted nouns go through one pluralization implementation.
 */
export const say = {
  /** `3 sources` / `1 source` */
  sources: (n: number) => counted(n, 'source'),
  /** `4 files` / `1 file` */
  files: (n: number) => counted(n, 'file'),
  /** `2 results` / `1 result` */
  results: (n: number) => counted(n, 'result'),
  /** `3 steps` / `1 step` */
  steps: (n: number) => counted(n, 'step'),
  /** `2 conversations` / `1 conversation` */
  conversations: (n: number) => counted(n, 'conversation'),
  /** `Step 2 of 5` */
  stepOf: (current: number, total: number) => (SAY_STRINGS[currentLocale] ?? SAY_STRINGS.en!).stepOf(current, total),
  /** Progressive status with the canonical ellipsis, e.g. `Searching…` */
  inProgress: (verb: string) => `${verb}…`
};

