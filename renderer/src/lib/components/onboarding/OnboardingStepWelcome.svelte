<svelte:options runes={true} />

<script lang="ts">
  import { Sparkles, ArrowRight } from 'lucide-svelte';
  import { t, locale } from 'svelte-i18n';

  const languages = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Espanol' },
    { code: 'pt-BR', label: 'Portugues (Brasil)' },
    { code: 'zh', label: '中文' },
    { code: 'fr', label: 'Francais' },
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

<div class="flex flex-1 flex-col items-center justify-center gap-8 px-8 text-center">
  <div class="flex h-20 w-20 items-center justify-center rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)]">
    <Sparkles class="h-10 w-10" />
  </div>

  <div class="space-y-3">
    <h1 class="text-2xl font-bold text-[var(--text)] font-serif tracking-tight">{$t('onboarding.welcome')}</h1>
    <p class="max-w-md text-[var(--text-secondary)]">
      {$t('onboarding.welcomeDesc')}
    </p>
  </div>

  <div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-left">
    <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]" for="onboarding-lang-select">{$t('generalSettings.language')}</label>
    <select
      id="onboarding-lang-select"
      class="w-full rounded-md border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
      value={normalizeLocaleCode($locale)}
      onchange={(e) => setLocale((e.target as HTMLSelectElement).value)}
    >
      {#each languages as lang (lang.code)}
        <option value={lang.code}>{lang.label}</option>
      {/each}
    </select>
  </div>

  <div class="flex gap-3 text-sm text-[var(--text-muted)]">
    <span class="flex items-center gap-1.5 rounded-full bg-[var(--surface)] border border-[var(--border-light)] px-3 py-1.5">
      <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
      {$t('onboarding.runtime')}
    </span>
    <span class="flex items-center gap-1.5 rounded-full bg-[var(--surface)] border border-[var(--border-light)] px-3 py-1.5">
      <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
      {$t('onboarding.model')}
    </span>
    <span class="flex items-center gap-1.5 rounded-full bg-[var(--surface)] border border-[var(--border-light)] px-3 py-1.5">
      <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
      {$t('onboarding.startChatting')}
    </span>
  </div>

  <button
    class="mt-2 inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-6 py-3 text-sm font-medium text-[var(--primary-fg)] transition hover:opacity-90 active:scale-[0.98]"
    onclick={onNext}
  >
    {$t('onboarding.startChatting')}
    <ArrowRight class="h-4 w-4" />
  </button>
</div>
