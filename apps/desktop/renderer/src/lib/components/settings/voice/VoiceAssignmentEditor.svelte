<svelte:options runes={true} />
<script lang="ts">
  import { Button, Select } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { VOICE_MODELS } from '$shared/voice-models';
  import type { VoiceAssignment } from '$shared/speech';
  import { voiceConfig } from '$lib/features/roleplay/roleplay-voice';

  let { value, onchange, label = 'Voice', previewText = 'Hello. It is good to hear from you.' }: { value?: VoiceAssignment | null; onchange: (value: VoiceAssignment | null) => void; label?: string; previewText?: string } = $props();
  const route = $derived(value?.backend === 'api' ? `api:${value.provider ?? appStore.config.tts?.api_provider ?? ''}` : value?.backend ?? 'inherit');
  const options = $derived([{ value: 'inherit', label: 'Default voice' }, { value: 'local', label: 'Local voice' }, { value: 'browser', label: 'System voice' },
    ...Object.keys(appStore.config.tts?.providers ?? {}).map((id) => ({ value: `api:${id}`, label: id === 'compatible' ? 'Compatible API' : id }))]);
  const localModel = $derived(VOICE_MODELS.find((model) => model.id === value?.model) ?? VOICE_MODELS[0]);
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
    <Select aria-label={`${label} source`} value={route} {options} onchange={(route) => onchange(route === 'inherit' ? null : route.startsWith('api:') ? { backend: 'api', provider: route.slice(4) } : { backend: route as 'local' | 'browser' })} />
    <Button variant="ghost" size="sm" onclick={() => void preview()}>Preview</Button>
  </div>
  {#if value}
    <div class="grid gap-3 sm:grid-cols-2">
      {#if value.backend === 'local'}
        <Select aria-label={`${label} model`} value={localModel.id} options={VOICE_MODELS.map((model) => ({ value: model.id, label: model.title }))} onchange={(model) => patch({ model, voice: undefined })} />
        <Select aria-label={`${label} selection`} value={value.voice ?? ''} placeholder="Choose voice" options={localModel.voices.map((voice) => ({ value: voice.id, label: voice.label }))} onchange={(voice) => patch({ voice, model: localModel.id })} />
      {:else if value.backend === 'api'}
        {#if apiOptions.length}<Select aria-label={`${label} selection`} value={value.voice ?? ''} placeholder="Provider default" options={[{ value: '', label: 'Provider default' }, ...apiOptions]} onchange={(voice) => patch({ voice })} />{/if}
        <label class="text-xs text-muted-foreground">Voice ID {loading ? '· loading voices' : ''}<input class="aui-input mt-1" value={value.voice ?? ''} placeholder="Provider default" oninput={(event) => patch({ voice: event.currentTarget.value })} /></label>
      {:else}<label class="text-xs text-muted-foreground">System voice name<input class="aui-input mt-1" value={value.voice ?? ''} placeholder="System default" oninput={(event) => patch({ voice: event.currentTarget.value })} /></label>{/if}
      <label class="text-xs text-muted-foreground">Speed<input class="aui-input mt-1" type="number" min="0.5" max="2" step="0.05" value={value.speed ?? 1} oninput={(event) => patch({ speed: Number(event.currentTarget.value) || 1 })} /></label>
      <label class="text-xs text-muted-foreground">Language<input class="aui-input mt-1" value={value.language ?? ''} placeholder="Default · e.g. en" oninput={(event) => patch({ language: event.currentTarget.value })} /></label>
    </div>
  {/if}
</div>
