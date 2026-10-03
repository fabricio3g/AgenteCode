<svelte:options runes={true} />

<script lang="ts">
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { Sparkles, ArrowRight } from 'lucide-svelte';
  import { t, locale } from 'svelte-i18n';
  import { APP_NAME } from '$lib/app-meta';
  import { Select } from '$lib/components/ui';

  const languages = SUPPORTED_UI_LANGUAGES;

  let { onNext } = $props<{ onNext: () => void }>();

  function setLocale(code: string) {
    setUiLocale(code);
  }
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
  <div class="flex size-12 items-center justify-center rounded-2xl bg-muted ring-1 ring-border">
    <Sparkles class="size-6 text-muted-foreground" />
  </div>

  <div class="space-y-2">
    <h1 class="text-2xl font-bold tracking-tight text-foreground">{$t('onboarding.welcome')}</h1>
    <p class="max-w-xs text-sm leading-relaxed text-muted-foreground">
      {$t('onboarding.welcomeDesc').replace('{{APP_NAME}}', APP_NAME)}
    </p>
  </div>

  <div class="w-full max-w-xs space-y-1.5 text-left">
    <label class="block text-xs font-medium text-muted-foreground" for="onboarding-language">{$t('onboarding.chooseLanguage')}</label>
    <Select
      id="onboarding-language"
      class="w-full"
      value={normalizeLocaleCode($locale)}
      options={languages.map((lang) => ({ value: lang.code, label: lang.label }))}
      onchange={setLocale}
    />
  </div>

  <div class="flex gap-1.5 text-[12px] text-muted-foreground">
    <span class="rounded-full bg-muted px-2.5 py-1 font-medium">{$t('onboarding.runtime')}</span>
    <span class="rounded-full bg-muted px-2.5 py-1 font-medium">{$t('onboarding.model')}</span>
    <span class="rounded-full bg-primary px-2.5 py-1 font-semibold text-primary-foreground">{$t('onboarding.startChatting')}</span>
  </div>

  <button
    type="button"
    class="ui-btn ui-btn-primary mt-2 gap-1.5 px-6 py-3 text-sm"
    onclick={onNext}
  >
    {$t('onboarding.startChatting')}
    <ArrowRight class="size-4" />
  </button>
</div>
