<svelte:options runes={true} />

<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import { SegmentedControl, Select } from '$lib/components/ui';
  import { APP_NAME } from '$lib/app-meta';
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { themeStore } from '$lib/stores/theme.svelte';
  import SetupFooter from './SetupFooter.svelte';

  let { onnext, onskip }: { onnext: () => void; onskip: () => void } = $props();
</script>

<div class="setup-step items-center justify-center text-center">
  <BrandMark size="lg" />
  <div class="space-y-1.5">
    <h1 class="text-lg font-semibold tracking-tight text-foreground">{$t('onboarding.welcomeTitle', { values: { app: APP_NAME } })}</h1>
    <p class="mx-auto max-w-sm text-sm text-muted-foreground">{$t('onboarding.welcomeLead')}</p>
  </div>

  <div class="setup-fields">
    <label class="setup-field">
      <span>{$t('onboarding.chooseLanguage')}</span>
      <Select
        class="w-full"
        value={normalizeLocaleCode($locale)}
        options={SUPPORTED_UI_LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label }))}
        onchange={(code) => setUiLocale(code)}
      />
    </label>
    <div class="setup-field">
      <span>{$t('generalSettings.theme')}</span>
      <SegmentedControl
        label={$t('generalSettings.theme')}
        value={themeStore.current}
        options={[{ value: 'light', label: $t('generalSettings.light') }, { value: 'dark', label: $t('generalSettings.dark') }]}
        onchange={(value) => themeStore.set(value as 'light' | 'dark')}
      />
    </div>
  </div>
</div>

<SetupFooter skipLabel={$t('onboarding.skipSetup')} {onskip} primaryLabel={$t('onboarding.getStarted')} onprimary={onnext} />
