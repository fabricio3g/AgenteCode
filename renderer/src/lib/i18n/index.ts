import { init, register, locale, waitLocale } from 'svelte-i18n';

register('en', () => import('../locales/en.json'));
register('es', () => import('../locales/es.json'));
register('pt-BR', () => import('../locales/pt-BR.json'));
register('zh', () => import('../locales/zh.json'));
register('fr', () => import('../locales/fr.json'));
register('de', () => import('../locales/de.json'));
register('ja', () => import('../locales/ja.json'));

const SUPPORTED_LOCALES = ['en', 'es', 'pt-BR', 'zh', 'fr', 'de', 'ja'] as const;

function normalizeLocaleCode(value: string | null | undefined): (typeof SUPPORTED_LOCALES)[number] {
  const raw = String(value || '').trim();
  if (!raw) return 'en';
  const lower = raw.toLowerCase();

  if (lower === 'pt-br' || lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('es')) return 'es';
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('fr')) return 'fr';
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('en')) return 'en';

  return 'en';
}

const SUPPORTED_UI_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'zh', label: '中文' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' }
] as const;

init({
  fallbackLocale: 'en',
  initialLocale: (() => {
    try {
      const stored = localStorage.getItem('chatealm_locale');
      const resolved = normalizeLocaleCode(stored || navigator?.language || 'en');
      if (stored !== resolved) localStorage.setItem('chatealm_locale', resolved);
      return resolved;
    } catch {
      return 'en';
    }
  })(),
});

export const i18nReady = waitLocale();

