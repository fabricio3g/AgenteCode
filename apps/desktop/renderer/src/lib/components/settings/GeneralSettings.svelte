<svelte:options runes={true} />

<script lang="ts">
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
  import { Button, Input, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import SettingsRow from './SettingsRow.svelte';
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
  /** Saved on blur or Enter, never per keystroke: each save writes config.json. */
  let editorValue = $state(appStore.editorCommand);

  function saveEditor() {
    if (editorValue.trim() !== appStore.editorCommand) void appStore.setEditorCommand(editorValue);
  }

  function setLocale(code: string) {
    setUiLocale(code);
  }
</script>

<div class="space-y-5 sm:space-y-6">
  <SettingsSection title={$t('generalSettings.profile')}>
    <SettingsRow
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
    </SettingsRow>

    <SettingsRow
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
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.chatBehavior')}>
    <SettingsRow
      label={$t('generalSettings.showAssistantText')}
      description={$t('generalSettings.showAssistantTextDesc')}
      control="auto"
    >
      <Switch bind:checked={showAssistantText} label={$t('generalSettings.showAssistantText')} />
    </SettingsRow>

    <SettingsRow
      label={$t('generalSettings.enableThinking')}
      description={$t('generalSettings.enableThinkingDesc')}
      control="auto"
    >
      <Switch bind:checked={enableThinking} label={$t('generalSettings.enableThinking')} />
    </SettingsRow>

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

  <SettingsSection title={$t('generalSettings.appearance')}>
    <SettingsRow
      label={$t('generalSettings.theme')}
      description={$t('generalSettings.themeDesc')}
      control="auto"
    >
      <SegmentedControl
        label={$t('generalSettings.theme')}
        value={themeStore.current}
        options={[{ value: 'light', label: $t('generalSettings.light') }, { value: 'dark', label: $t('generalSettings.dark') }]}
        onchange={(value) => themeStore.set(value as 'light' | 'dark')}
      />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.editor')}>
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
  </SettingsSection>

  <SettingsSection title={$t('generalSettings.huggingFaceAccess')} description={$t('generalSettings.huggingFaceDesc')}>
    <SettingsRow label={$t('generalSettings.accessToken')} htmlFor="hf-access-token">
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
    </SettingsRow>
  </SettingsSection>
</div>
