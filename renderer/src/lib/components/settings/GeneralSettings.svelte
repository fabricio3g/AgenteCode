<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
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

  let {
    showAssistantText = $bindable(),
    enableThinking = $bindable(),
    hfToken = $bindable(),
    onsaveHfToken,
  }: {
    showAssistantText: boolean;
    enableThinking: boolean;
    hfToken: string;
    onsaveHfToken: () => void;
  } = $props();

  let nameValue = $state(appStore.userName);

  function setLocale(code: string) {
    const resolved = normalizeLocaleCode(code);
    locale.set(resolved);
    localStorage.setItem('chatealm_locale', resolved);
  }
</script>

<div class="space-y-6">
  <div class="border-b border-[var(--border)] pb-6">
    <h3 class="mb-1 text-sm font-medium text-[var(--text)]">{$t('generalSettings.yourName')}</h3>
    <p class="mb-3 text-xs text-[var(--text-tertiary)]">{$t('generalSettings.shownOnWelcome')}</p>
    <input
      type="text"
      bind:value={nameValue}
      oninput={() => appStore.setUserName(nameValue)}
      placeholder={$t('generalSettings.enterYourName')}
      class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]"
    />
  </div>

  <div class="border-b border-[var(--border)] pb-6">
    <h3 class="mb-1 text-sm font-medium text-[var(--text)]">{$t('generalSettings.language')}</h3>
    <p class="mb-3 text-xs text-[var(--text-tertiary)]">{$t('generalSettings.languageDesc')}</p>
    <select
      class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
      value={normalizeLocaleCode($locale)}
      onchange={(e) => setLocale((e.target as HTMLSelectElement).value)}
    >
      {#each languages as lang (lang.code)}
        <option value={lang.code}>{$locale === lang.code ? lang.label : lang.label}</option>
      {/each}
    </select>
  </div>

  <div class="flex items-center justify-between py-2">
    <div>
      <div class="text-sm font-medium text-[var(--text-secondary)]">{$t('generalSettings.showAssistantText')}</div>
      <div class="text-xs text-[var(--text-tertiary)]">{$t('generalSettings.showAssistantTextDesc')}</div>
    </div>
    <label class="relative inline-flex h-5 w-9 cursor-pointer items-center">
      <input type="checkbox" bind:checked={showAssistantText} class="peer sr-only" />
      <span class="absolute inset-0 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)]"></span>
      <span class="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--text)] transition peer-checked:translate-x-4 peer-checked:bg-[var(--primary-fg)]"></span>
    </label>
  </div>

  <div class="flex items-center justify-between py-2">
    <div>
      <div class="text-sm font-medium text-[var(--text-secondary)]">{$t('generalSettings.enableThinking')}</div>
      <div class="text-xs text-[var(--text-tertiary)]">{$t('generalSettings.enableThinkingDesc')}</div>
    </div>
    <label class="relative inline-flex h-5 w-9 cursor-pointer items-center">
      <input type="checkbox" bind:checked={enableThinking} class="peer sr-only" />
      <span class="absolute inset-0 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)]"></span>
      <span class="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--text)] transition peer-checked:translate-x-4 peer-checked:bg-[var(--primary-fg)]"></span>
    </label>
  </div>

  <div class="border-t border-[var(--border)] pt-6">
    <h3 class="mb-1 text-sm font-medium text-[var(--text)]">{$t('generalSettings.huggingFaceAccess')}</h3>
    <p class="mb-4 text-xs text-[var(--text-tertiary)]">{$t('generalSettings.huggingFaceDesc')}</p>
    <label class="mb-2 block text-sm text-[var(--text-secondary)]" for="hf-access-token">{$t('generalSettings.accessToken')}</label>
    <div class="flex gap-2">
      <input
        id="hf-access-token"
        type="password"
        bind:value={hfToken}
        placeholder="hf_..."
        class="flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
      />
      <button
        class="inline-flex items-center gap-1.5 rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)] transition hover:opacity-90"
        onclick={onsaveHfToken}
      >
        {$t('generalSettings.save')}
      </button>
    </div>
  </div>
</div>
