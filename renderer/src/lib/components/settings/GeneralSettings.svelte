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
    composerModeControl = $bindable(),
    hfToken = $bindable(),
    onsaveHfToken,
  }: {
    showAssistantText: boolean;
    enableThinking: boolean;
    composerModeControl: 'tabs' | 'auto';
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

<div class="space-y-4">
  <section class="aui-card-quiet p-4 text-muted-foreground">
    <h4 class="mb-4 text-base font-medium text-foreground">General</h4>

    <div class="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-foreground">{$t('generalSettings.yourName')}</h5>
        <p class="text-xs leading-normal text-muted-foreground">{$t('generalSettings.shownOnWelcome')}</p>
      </div>
      <input
        type="text"
        bind:value={nameValue}
        oninput={() => appStore.setUserName(nameValue)}
        placeholder={$t('generalSettings.enterYourName')}
        class="aui-input sm:w-72"
      />
    </div>

    <div class="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-foreground">{$t('generalSettings.language')}</h5>
        <p class="text-xs leading-normal text-muted-foreground">{$t('generalSettings.languageDesc')}</p>
      </div>
      <select
        class="aui-input sm:w-72"
        value={normalizeLocaleCode($locale)}
        onchange={(e) => setLocale((e.target as HTMLSelectElement).value)}
      >
        {#each languages as lang (lang.code)}
          <option value={lang.code}>{lang.label}</option>
        {/each}
      </select>
    </div>
  </section>

  <section class="aui-card-quiet p-4 text-muted-foreground">
    <h4 class="mb-4 text-base font-medium text-foreground">Chat behavior</h4>

    <div class="flex items-center justify-between gap-6 pb-4">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-foreground">{$t('generalSettings.showAssistantText')}</h5>
        <p class="text-xs leading-normal text-muted-foreground">{$t('generalSettings.showAssistantTextDesc')}</p>
      </div>
      <label class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
        <input type="checkbox" bind:checked={showAssistantText} class="peer sr-only" />
        <span class="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-primary"></span>
        <span class="absolute left-0.5 size-4 rounded-full bg-foreground transition peer-checked:translate-x-4 peer-checked:bg-primary-foreground"></span>
      </label>
    </div>

    <div class="flex items-center justify-between gap-6 pt-2">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-foreground">{$t('generalSettings.enableThinking')}</h5>
        <p class="text-xs leading-normal text-muted-foreground">{$t('generalSettings.enableThinkingDesc')}</p>
      </div>
      <label class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
        <input type="checkbox" bind:checked={enableThinking} class="peer sr-only" />
        <span class="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-primary"></span>
        <span class="absolute left-0.5 size-4 rounded-full bg-foreground transition peer-checked:translate-x-4 peer-checked:bg-primary-foreground"></span>
      </label>
    </div>

    <div class="flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-foreground">Chat / Agent control</h5>
        <p class="text-xs leading-normal text-muted-foreground">
          Auto hides the Chat/Agent tabs and routes each message by what you ask. Tabs lets you pick manually.
        </p>
      </div>
      <select
        class="aui-input sm:w-72"
        bind:value={composerModeControl}
      >
        <option value="auto">Auto (recommended)</option>
        <option value="tabs">Show Chat / Agent tabs</option>
      </select>
    </div>
  </section>

  <section class="aui-card-quiet p-4 text-muted-foreground">
    <h4 class="mb-1 text-base font-medium text-foreground">{$t('generalSettings.huggingFaceAccess')}</h4>
    <p class="mb-4 text-xs leading-normal text-muted-foreground">{$t('generalSettings.huggingFaceDesc')}</p>

    <label class="mb-2 block text-sm font-medium text-foreground" for="hf-access-token">{$t('generalSettings.accessToken')}</label>
    <div class="flex flex-col gap-2 sm:flex-row">
      <input
        id="hf-access-token"
        type="password"
        bind:value={hfToken}
        placeholder="hf_..."
        class="aui-input min-w-0 flex-1"
      />
      <button
        type="button"
        class="aui-btn aui-btn-primary"
        onclick={onsaveHfToken}
      >
        {$t('generalSettings.save')}
      </button>
    </div>
  </section>
</div>
