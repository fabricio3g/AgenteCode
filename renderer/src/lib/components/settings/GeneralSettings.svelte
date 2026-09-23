<svelte:options runes={true} />

<script lang="ts">
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
  import { Button, Field, Input, SegmentedControl, Select, Switch } from '$lib/components/ui';
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

<div class="space-y-5">
  <div>
    <h3 class="text-lg font-semibold tracking-[-0.02em] text-foreground">General</h3>
    <p class="mt-1 text-sm text-muted-foreground">Personalize the interface and everyday chat behavior.</p>
  </div>

  <section class="rounded-2xl bg-[var(--muted)]">
    <div class="px-4 pb-1 pt-3.5">
      <h4 class="text-sm font-semibold text-foreground">Profile</h4>
    </div>
    <div class="px-4">
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
    </div>
  </section>

  <section class="rounded-2xl bg-[var(--muted)]">
    <div class="px-4 pb-1 pt-3.5">
      <h4 class="text-sm font-semibold text-foreground">Chat behavior</h4>
    </div>
    <div class="px-4">
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
    </div>
  </section>

  <section class="rounded-2xl bg-[var(--muted)]">
    <div class="px-4 pb-1 pt-3.5">
      <h4 class="text-sm font-semibold text-foreground">Appearance</h4>
    </div>
    <div class="px-4">
      <Field
        horizontal
        class="py-4"
        label="Color theme"
        description="Choose a light or dark interface."
      >
        <SegmentedControl
          label="Color theme"
          value={themeStore.current}
          options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
          onchange={(value) => themeStore.set(value as 'light' | 'dark')}
        />
      </Field>
    </div>
  </section>

  <section class="rounded-2xl bg-[var(--muted)] p-4">
    <h4 class="text-sm font-semibold text-foreground">{$t('generalSettings.huggingFaceAccess')}</h4>
    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{$t('generalSettings.huggingFaceDesc')}</p>
    <div class="mt-4">
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
  </section>
</div>
