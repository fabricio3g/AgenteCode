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
    localStorage.setItem('chatealm_locale', resolved);
  }
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
  <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface-highlight)] ring-1 ring-[var(--border)]">
    <Sparkles class="h-6 w-6 text-[var(--text-secondary)]" />
  </div>

  <div class="space-y-2">
    <h1 class="text-2xl font-bold text-[var(--text)] tracking-tight">{$t('onboarding.welcome')}</h1>
    <p class="max-w-xs text-sm text-[var(--text-secondary)] leading-relaxed">
      {$t('onboarding.welcomeDesc').replace('{{APP_NAME}}', APP_NAME)}
    </p>
  </div>

  <div class="w-full max-w-xs text-left space-y-1.5">
    <label class="block text-xs font-medium text-[var(--text-muted)]">{$t('onboarding.chooseLanguage')}</label>
    <select
      class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--text)] outline-none transition-colors hover:border-[var(--border-strong)] focus:border-[var(--border-strong)]"
      value={normalizeLocaleCode($locale)}
      onchange={(e) => setLocale((e.target as HTMLSelectElement).value)}
    >
      {#each languages as lang (lang.code)}
        <option value={lang.code}>{lang.label}</option>
      {/each}
    </select>
  </div>

  <div class="flex gap-1.5 text-[11px] text-[var(--text-muted)]">
    <span class="rounded-full bg-[var(--surface-highlight)] border border-[var(--border)] px-2.5 py-1 font-medium">{$t('onboarding.runtime')}</span>
    <span class="rounded-full bg-[var(--surface-highlight)] border border-[var(--border)] px-2.5 py-1 font-medium">{$t('onboarding.model')}</span>
    <span class="rounded-full bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1 font-semibold text-[var(--text)]">{$t('onboarding.startChatting')}</span>
  </div>

  <button
    class="mt-2 inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--primary)] px-6 py-3 text-sm font-semibold text-[var(--primary-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition hover:opacity-90 active:scale-[0.98]"
    onclick={onNext}
  >
    {$t('onboarding.startChatting')}
    <ArrowRight class="h-4 w-4" />
  </button>
</div>
