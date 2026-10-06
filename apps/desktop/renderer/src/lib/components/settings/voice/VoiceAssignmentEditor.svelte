<svelte:options runes={true} />
<script lang="ts">
  import { Button, Input, Select } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import type { VoiceAssignment } from '$shared/speech';
  import { voiceConfig } from '$lib/features/roleplay/roleplay-voice';
  import { t } from 'svelte-i18n';

  let { value, onchange, label: labelProp, previewText: previewProp }: { value?: VoiceAssignment | null; onchange: (value: VoiceAssignment | null) => void; label?: string; previewText?: string } = $props();
  const label = $derived(labelProp ?? $t('speech.voice'));
  const previewText = $derived(previewProp ?? $t('speech.previewText'));
  const route = $derived(value?.backend === 'api' ? `api:${value.provider ?? appStore.config.tts?.api_provider ?? ''}` : value?.backend ?? 'inherit');
  const options = $derived([{ value: 'inherit', label: $t('speech.defaultVoiceOption') }, { value: 'local', label: $t('speech.localVoice') }, { value: 'browser', label: $t('speech.systemVoice') },
    ...Object.keys(appStore.config.tts?.providers ?? {}).map((id) => ({ value: `api:${id}`, label: id === 'compatible' ? $t('speech.compatible') : id }))]);
  // Installed models first (they can speak now), else the whole catalog.
  const localModels = $derived(speechEngine.models.filter((model) => speechEngine.status?.installed.includes(model.id) && !model.needsReference));
  const localModel = $derived(speechEngine.find(value?.model) ?? localModels[0] ?? speechEngine.models[0]);
  let apiOptions = $state<Array<{ value: string; label: string }>>([]);
  let loading = $state(false);
  $effect(() => {
    const provider = value?.provider;
    if (value?.backend !== 'api' || !provider) { apiOptions = []; return; }
    let cancelled = false;
    loading = true;
    void invoke<Array<{ id: string; name: string }>>('list_speech_voices', { provider }).then((voices) => {
      if (!cancelled) apiOptions = voices.map((voice) => ({ value: voice.id, label: voice.name }));
    }).catch(() => { if (!cancelled) apiOptions = []; }).finally(() => { if (!cancelled) loading = false; });
    return () => { cancelled = true; };
  });
  function patch(patch: Partial<VoiceAssignment>) { onchange({ ...value, ...patch }); }
  async function preview() {
    try { await ttsStore.speak(`voice-assignment-preview:${label}`, previewText, voiceConfig(appStore.config, value)); }
    catch (error) { toastStore.error(error instanceof Error ? error.message : String(error)); }
  }
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-center gap-3">
    <span class="text-sm font-medium text-muted-foreground">{label}</span>
    <Select aria-label={$t('speech.source', { values: { label } })} value={route} {options} onchange={(route) => onchange(route === 'inherit' ? null : route.startsWith('api:') ? { backend: 'api', provider: route.slice(4) } : { backend: route as 'local' | 'browser' })} />
    <Button variant="ghost" size="sm" onclick={() => void preview()}>{$t('speech.preview')}</Button>
  </div>
  {#if value}
    <div class="grid gap-3 sm:grid-cols-2">
      {#if value.backend === 'local'}
        <Select aria-label={$t('speech.modelOf', { values: { label } })} value={localModel.id} options={(localModels.length ? localModels : speechEngine.models).map((model) => ({ value: model.id, label: model.title }))} onchange={(model) => patch({ model, voice: undefined })} />
        <Select aria-label={label} value={value.voice ?? ''} placeholder={$t('speech.chooseVoice')} options={localModel.voices.map((voice) => ({ value: voice.id, label: voice.label }))} onchange={(voice) => patch({ voice, model: localModel.id })} />
      {:else if value.backend === 'api'}
        {#if apiOptions.length}<Select aria-label={label} value={value.voice ?? ''} placeholder={$t('speech.providerDefault')} options={[{ value: '', label: $t('speech.providerDefault') }, ...apiOptions]} onchange={(voice) => patch({ voice })} />{/if}
        <label class="text-xs text-muted-foreground">{$t('speech.voiceId')} {loading ? $t('speech.loadingVoices') : ''}<Input class="mt-1" value={value.voice ?? ''} placeholder={$t('speech.providerDefault')} oninput={(event) => patch({ voice: event.currentTarget.value })} /></label>
      {:else}<label class="text-xs text-muted-foreground">{$t('speech.systemVoiceName')}<Input class="mt-1" value={value.voice ?? ''} placeholder={$t('speech.systemDefault')} oninput={(event) => patch({ voice: event.currentTarget.value })} /></label>{/if}
      <label class="text-xs text-muted-foreground">{$t('speech.speed')}<Input class="mt-1" type="number" min="0.5" max="2" step="0.05" value={value.speed ?? 1} oninput={(event) => patch({ speed: Number(event.currentTarget.value) || 1 })} /></label>
      <label class="text-xs text-muted-foreground">{$t('speech.language')}<Input class="mt-1" value={value.language ?? ''} placeholder={$t('speech.languagePlaceholder')} oninput={(event) => patch({ language: event.currentTarget.value })} /></label>
    </div>
  {/if}
</div>
