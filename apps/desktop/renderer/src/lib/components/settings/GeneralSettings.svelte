<svelte:options runes={true} />

<script lang="ts">
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import type { ColorMode } from '$shared/appearance';
  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
  import { Button, Input, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  const languages = SUPPORTED_UI_LANGUAGES;

  let {
    enableThinking = $bindable(),
    hfToken = $bindable(),
    onsaveHfToken,
  }: {
    enableThinking: boolean;
    hfToken: string;
    onsaveHfToken: () => void;
  } = $props();

  let nameValue = $state(appStore.userName);
  /** Saved on blur or Enter, never per keystroke: each save writes config.json. */
  let editorValue = $state(appStore.editorCommand);

  function saveEditor() {
    if (editorValue.trim() !== appStore.editorCommand) void appStore.setEditorCommand(editorValue);
  }

  function setLocale(code: string) {
    setUiLocale(code);
  }
</script>

<div class="flex flex-col gap-7">

  <SettingsSection title={$t('generalSettings.profile')}>
    <SettingsRow
      label={$t('generalSettings.yourName')}
      htmlFor="profile-name"
    >
      <Input
        id="profile-name"
        type="text"
        bind:value={nameValue}
        oninput={() => appStore.setUserName(nameValue)}
        placeholder={$t('generalSettings.enterYourName')}
      />
    </SettingsRow>

    <SettingsRow
      label={$t('generalSettings.language')}
      htmlFor="interface-language"
    >
      <Select
        id="interface-language"
        value={normalizeLocaleCode($locale)}
        options={languages.map((lang) => ({ value: lang.code, label: lang.label }))}
        onchange={setLocale}
      />
    </SettingsRow>

    <SettingsRow
      label={$t('generalSettings.theme')}
      control="auto"
    >
      <SegmentedControl
        label={$t('generalSettings.theme')}
        value={appearanceStore.prefs.mode}
        options={[
          { value: 'system', label: $t('appearance.modeSystem') },
          { value: 'light', label: $t('generalSettings.light') },
          { value: 'dark', label: $t('generalSettings.dark') }
        ]}
        onchange={(value) => appearanceStore.setMode(value as ColorMode)}
      />
    </SettingsRow>
  </SettingsSection>

  <!-- Off by default: the two opt-in spaces appear in the sidebar's row only
       once a switch here turns them on. -->
  <SettingsSection title={$t('generalSettings.spaces')}>
    <SettingsRow
      label={$t('generalSettings.roleplay')}
      description={$t('generalSettings.roleplayDesc')}
      control="auto"
    >
      <Switch
        checked={appStore.roleplayEnabled}
        label={$t('generalSettings.roleplay')}
        onchange={(checked) => void appStore.setRoleplayEnabled(checked)}
      />
    </SettingsRow>

  </SettingsSection>

  <SettingsSection title={$t('generalSettings.chatBehavior')}>
    <SettingsRow
      label={$t('generalSettings.enableThinking')}
      description={$t('generalSettings.enableThinkingDesc')}
      control="auto"
    >
      <Switch bind:checked={enableThinking} label={$t('generalSettings.enableThinking')} />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.setup')}>
    <SettingsRow
      label={$t('generalSettings.editorCommand')}
      description={$t('generalSettings.editorDesc')}
      htmlFor="editor-command"
    >
      <Input
        id="editor-command"
        type="text"
        bind:value={editorValue}
        placeholder={$t('generalSettings.editorPlaceholder')}
        onblur={saveEditor}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            saveEditor();
          }
        }}
      />
    </SettingsRow>

    <SettingsRow label={$t('generalSettings.huggingFaceAccess')} htmlFor="hf-access-token">
      <div class="flex flex-col gap-2 sm:flex-row">
        <Input
          id="hf-access-token"
          type="password"
          bind:value={hfToken}
          placeholder="hf_..."
          class="min-w-0 flex-1"
        />
        <Button variant="outline" onclick={onsaveHfToken}>{$t('generalSettings.save')}</Button>
      </div>
    </SettingsRow>

    <SettingsRow label={$t('generalSettings.setupWizard')} description={$t('onboarding.setupHint')} control="auto">
      <Button variant="outline" size="sm" onclick={() => { appStore.onboardingOpen = true; }}>{$t('onboarding.reopenSetup')}</Button>
    </SettingsRow>
  </SettingsSection>
</div>
