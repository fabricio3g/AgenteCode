<svelte:options runes={true} />
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Select, SegmentedControl } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { SPEECH_DEFAULTS, type SpeechProviderConfig } from '$shared/speech';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { t } from 'svelte-i18n';
  let { kind }: { kind: 'tts' | 'stt' } = $props();
  const settings = $derived(appStore.config[kind]);
  const mode = $derived(kind === 'tts' ? appStore.config.tts?.backend_mode ?? 'local' : appStore.config.stt?.provider === 'api' ? 'api' : 'local');
  let selected = $state(untrack(() => appStore.config[kind]?.api_provider || 'openai'));
  let draft = $state<SpeechProviderConfig>(untrack(() => loadDraft(selected)));
  let saving = $state(false);
  function loadDraft(id: string): SpeechProviderConfig {
    const defaults = { ...SPEECH_DEFAULTS[id] };
    if (kind === 'stt' && defaults.type === 'openai') { defaults.model = 'whisper-1'; delete defaults.voice; }
    return { ...defaults, ...appStore.config[kind]?.providers?.[id], api_key: '' };
  }
  async function backend(mode: string) {
    if (kind === 'tts') await appStore.updateTtsSettings({ backend_mode: mode as 'local' | 'api' | 'browser' });
    else await appStore.updateSttSettings({ provider: mode as 'local' | 'api' });
  }
  async function save() {
    saving = true;
    try {
      const providers = { ...settings?.providers, [selected]: { ...draft, base_url: draft.base_url.trim(), model: draft.model.trim() } };
      if (kind === 'tts') await appStore.updateTtsSettings({ backend_mode: 'api', api_provider: selected, providers });
      else await appStore.updateSttSettings({ provider: 'api', api_provider: selected, providers });
      draft.api_key = '';
      toastStore.success($t('speech.saved'));
    } catch (error) { toastStore.error(error instanceof Error ? error.message : String(error)); }
    finally { saving = false; }
  }
</script>

<div class="space-y-4 px-4 py-3.5 sm:px-5">
  <SegmentedControl label={kind === 'tts' ? $t('speech.outputBackend') : $t('speech.inputBackend')} value={mode} options={[{ value: 'local', label: $t('speech.local') }, { value: 'api', label: $t('speech.api') }, ...(kind === 'tts' ? [{ value: 'browser', label: $t('speech.system') }] : [])]} onchange={(value) => void backend(value)} />
  {#if mode === 'api'}
    <Select aria-label={$t('speech.service')} value={selected} options={[{ value: 'openai', label: 'OpenAI' }, { value: 'compatible', label: $t('speech.compatible') }, kind === 'tts' ? { value: 'elevenlabs', label: 'ElevenLabs' } : { value: 'deepgram', label: 'Deepgram' }]} onchange={(value) => { selected = value; draft = loadDraft(value); }} />
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-muted-foreground sm:col-span-2">{$t('speech.endpoint')}<input class="ui-input mt-1" bind:value={draft.base_url} placeholder="https://service.example/v1" /></label>
      <label class="text-xs text-muted-foreground">{$t('speech.apiKey')}<input class="ui-input mt-1" type="password" autocomplete="off" bind:value={draft.api_key} placeholder={settings?.providers?.[selected]?.has_api_key ? $t('speech.keySaved') : $t('speech.apiKey')} /></label>
      <label class="text-xs text-muted-foreground">{$t('speech.model')}<input class="ui-input mt-1" bind:value={draft.model} /></label>
      {#if kind === 'tts'}<label class="text-xs text-muted-foreground">{$t('speech.defaultVoice')}<input class="ui-input mt-1" value={draft.voice ?? ''} oninput={(event) => draft.voice = event.currentTarget.value} /></label>{/if}
    </div>
    <Button size="sm" disabled={saving || !draft.base_url.trim() || !draft.model.trim()} onclick={() => void save()}>{saving ? $t('speech.saving') : $t('speech.save')}</Button>
  {/if}
</div>
