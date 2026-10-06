<svelte:options runes={true} />

<!--
  Where speech runs: on this computer, through a cloud service, or (reading
  aloud only) the voices built into the system. A cloud service gets its
  endpoint, key and model here, as ordinary settings rows.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Input, Select, SegmentedControl } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { SPEECH_DEFAULTS, type SpeechProviderConfig } from '$shared/speech';
  import SettingsRow from '../SettingsRow.svelte';

  let { kind }: { kind: 'tts' | 'stt' } = $props();

  const settings = $derived(appStore.config[kind]);
  const mode = $derived(kind === 'tts'
    ? appStore.config.tts?.backend_mode ?? 'local'
    : appStore.config.stt?.provider === 'api' ? 'api' : 'local');
  let selected = $state(untrack(() => appStore.config[kind]?.api_provider || 'openai'));
  let draft = $state<SpeechProviderConfig>(untrack(() => loadDraft(selected)));
  let saving = $state(false);
  const keySaved = $derived(!!settings?.providers?.[selected]?.has_api_key);

  function loadDraft(id: string): SpeechProviderConfig {
    const defaults = { ...SPEECH_DEFAULTS[id] };
    if (kind === 'stt' && defaults.type === 'openai') { defaults.model = 'whisper-1'; delete defaults.voice; }
    return { ...defaults, ...appStore.config[kind]?.providers?.[id], api_key: '' };
  }

  async function setMode(next: string) {
    if (kind === 'tts') await appStore.updateTtsSettings({ backend_mode: next as 'local' | 'api' | 'browser' });
    else await appStore.updateSttSettings({ provider: next as 'local' | 'api' });
  }

  async function save() {
    saving = true;
    try {
      const providers = { ...settings?.providers, [selected]: { ...draft, base_url: draft.base_url.trim(), model: draft.model.trim() } };
      if (kind === 'tts') await appStore.updateTtsSettings({ backend_mode: 'api', api_provider: selected, providers });
      else await appStore.updateSttSettings({ provider: 'api', api_provider: selected, providers });
      draft.api_key = '';
      toastStore.success($t('speech.saved'));
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
    }
  }
</script>

<SettingsRow
  label={$t('speech.runsOn')}
  description={mode === 'local' ? $t('speech.localHint') : mode === 'api' ? $t('speech.apiHint') : $t('speech.systemHint')}
  control="auto"
>
  <SegmentedControl
    label={kind === 'tts' ? $t('speech.outputBackend') : $t('speech.inputBackend')}
    value={mode}
    options={[
      { value: 'local', label: $t('speech.local') },
      { value: 'api', label: $t('speech.api') },
      ...(kind === 'tts' ? [{ value: 'browser', label: $t('speech.system') }] : [])
    ]}
    onchange={(value) => void setMode(value)}
  />
</SettingsRow>

{#if mode === 'api'}
  <SettingsRow label={$t('speech.service')}>
    <Select
      class="w-full"
      aria-label={$t('speech.service')}
      value={selected}
      options={[
        { value: 'openai', label: 'OpenAI' },
        { value: 'compatible', label: $t('speech.compatible') },
        kind === 'tts' ? { value: 'elevenlabs', label: 'ElevenLabs' } : { value: 'deepgram', label: 'Deepgram' }
      ]}
      onchange={(value) => { selected = value; draft = loadDraft(value); }}
    />
  </SettingsRow>
  <SettingsRow label={$t('speech.endpoint')} htmlFor="speech-{kind}-endpoint" control="lg">
    <Input id="speech-{kind}-endpoint" bind:value={draft.base_url} placeholder="https://service.example/v1" spellcheck="false" />
  </SettingsRow>
  <SettingsRow label={$t('speech.apiKey')} htmlFor="speech-{kind}-key" description={keySaved ? $t('speech.keySaved') : ''} control="lg">
    <Input id="speech-{kind}-key" type="password" autocomplete="off" bind:value={draft.api_key} placeholder={keySaved ? '••••••••' : 'sk-…'} />
  </SettingsRow>
  <SettingsRow label={$t('speech.model')} htmlFor="speech-{kind}-model" control="lg">
    <Input id="speech-{kind}-model" bind:value={draft.model} spellcheck="false" />
  </SettingsRow>
  {#if kind === 'tts'}
    <SettingsRow label={$t('speech.defaultVoice')} htmlFor="speech-tts-voice" control="lg">
      <Input id="speech-tts-voice" value={draft.voice ?? ''} oninput={(event: Event) => (draft.voice = (event.currentTarget as HTMLInputElement).value)} />
    </SettingsRow>
  {/if}
  <div class="flex justify-end px-4 py-2.5">
    <Button size="sm" loading={saving} disabled={!draft.base_url.trim() || !draft.model.trim()} onclick={() => void save()}>{$t('speech.save')}</Button>
  </div>
{/if}
