<svelte:options runes={true} />

<script lang="ts">
  import { Sparkles, ArrowRight } from 'lucide-svelte';
  import { t, locale } from 'svelte-i18n';
  import { APP_NAME } from '$lib/app-meta';

  const languages = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Español' },
    { code: 'pt-BR', label: 'Português (Brasil)' },
    { code: 'zh', label: '中文' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'ja', label: '日本語' }
  ];

  function normalizeLocaleCode(value: string | null | undefined): string {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'en';
    if (raw === 'pt-br' || raw.startsWith('pt')) return 'pt-BR';
    if (raw.startsWith('es')) return 'es';
    if (raw.startsWith('zh')) return 'zh';
    if (raw.startsWith('fr')) return 'fr';
    if (raw.startsWith('de')) return 'de';
    if (raw.startsWith('ja')) return 'ja';
    if (raw.startsWith('en')) return 'en';
    return 'en';
  }

  let { onNext } = $props<{ onNext: () => void }>();

  function setLocale(code: string) {
    const resolved = normalizeLocaleCode(code);
    locale.set(resolved);
    localStorage.setItem('talamolm_locale', resolved);
  }
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
  <Sparkles class="h-8 w-8 text-[var(--text-secondary)]" />

  <div class="space-y-2">
    <h1 class="text-xl font-semibold text-[var(--text)]">{$t('onboarding.welcome')}</h1>
    <p class="text-sm text-[var(--text-secondary)]">
      {$t('onboarding.welcomeDesc').replace('{{APP_NAME}}', APP_NAME)}
    </p>
  </div>

  <div class="w-full max-w-xs text-left">
    <select
      class="w-full rounded-full border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2 text-sm text-[var(--text)] outline-none transition-colors"
      value={normalizeLocaleCode($locale)}
      onchange={(e) => setLocale((e.target as HTMLSelectElement).value)}
    >
      {#each languages as lang (lang.code)}
        <option value={lang.code}>{lang.label}</option>
      {/each}
    </select>
  </div>

  <div class="flex gap-2 text-xs text-[var(--text-muted)]">
    <span class="rounded-full px-2 py-1">{$t('onboarding.runtime')}</span>
    <span class="rounded-full px-2 py-1">{$t('onboarding.model')}</span>
    <span class="rounded-full px-2 py-1">{$t('onboarding.startChatting')}</span>
  </div>

  <button
    class="mt-2 inline-flex items-center gap-2 rounded-full bg-[var(--text)] px-6 py-2.5 text-sm font-medium text-[var(--surface)] transition hover:opacity-90"
    onclick={onNext}
  >
    {$t('onboarding.startChatting')}
    <ArrowRight class="h-4 w-4" />
  </button>
</div>
