<svelte:options runes={true} />

<script lang="ts">
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
  import { Button, Field, Input, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import SettingsSection from './SettingsSection.svelte';
  const languages = SUPPORTED_UI_LANGUAGES;

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
    setUiLocale(code);
  }
</script>

<div class="space-y-7">
  <SettingsSection title={$t('generalSettings.profile')}>
      <Field
        horizontal
        class="py-4"
        label={$t('generalSettings.yourName')}
        description={$t('generalSettings.shownOnWelcome')}
        htmlFor="profile-name"
      >
        <Input
          id="profile-name"
          type="text"
          bind:value={nameValue}
          oninput={() => appStore.setUserName(nameValue)}
          placeholder={$t('generalSettings.enterYourName')}
        />
      </Field>

      <Field
        horizontal
        class="py-4"
        label={$t('generalSettings.language')}
        description={$t('generalSettings.languageDesc')}
        htmlFor="interface-language"
      >
        <Select
          id="interface-language"
          value={normalizeLocaleCode($locale)}
          options={languages.map((lang) => ({ value: lang.code, label: lang.label }))}
          onchange={setLocale}
        />
      </Field>
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.chatBehavior')}>
      <Field
        horizontal
        class="py-4"
        label={$t('generalSettings.showAssistantText')}
        description={$t('generalSettings.showAssistantTextDesc')}
      >
        <div class="flex justify-end"><Switch bind:checked={showAssistantText} label={$t('generalSettings.showAssistantText')} /></div>
      </Field>

      <Field
        horizontal
        class="py-4"
        label={$t('generalSettings.enableThinking')}
        description={$t('generalSettings.enableThinkingDesc')}
      >
        <div class="flex justify-end"><Switch bind:checked={enableThinking} label={$t('generalSettings.enableThinking')} /></div>
      </Field>

      <Field
        horizontal
        class="py-4"
        label={$t('generalSettings.roleplay')}
        description={$t('generalSettings.roleplayDesc')}
      >
        <div class="flex justify-end">
          <Switch
            checked={appStore.roleplayEnabled}
            label={$t('generalSettings.roleplay')}
            onchange={(checked) => void appStore.setRoleplayEnabled(checked)}
          />
        </div>
      </Field>
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.appearance')}>
      <Field
        horizontal
        class="py-4"
        label={$t('generalSettings.theme')}
        description={$t('generalSettings.themeDesc')}
      >
        <SegmentedControl
          label={$t('generalSettings.theme')}
          value={themeStore.current}
          options={[{ value: 'light', label: $t('generalSettings.light') }, { value: 'dark', label: $t('generalSettings.dark') }]}
          onchange={(value) => themeStore.set(value as 'light' | 'dark')}
        />
      </Field>
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.huggingFaceAccess')} description={$t('generalSettings.huggingFaceDesc')}>
    <div class="py-4">
      <Field label={$t('generalSettings.accessToken')} htmlFor="hf-access-token">
        <div class="flex flex-col gap-2 sm:flex-row">
          <Input
            id="hf-access-token"
            type="password"
            bind:value={hfToken}
            placeholder="hf_..."
            class="min-w-0 flex-1"
          />
          <Button onclick={onsaveHfToken}>{$t('generalSettings.save')}</Button>
        </div>
      </Field>
    </div>
  </SettingsSection>
</div>
