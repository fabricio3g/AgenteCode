<svelte:options runes={true} />

<!--
  Voice: reading replies aloud and dictation.

  Read aloud runs on this computer through the bundled audio.cpp server (with
  Kokoro or Supertonic as the voice model), on a cloud service, or on the
  system's own voices. The page follows that order: whether to read aloud,
  where, the engine and its models, the voice, then how it sounds.

  Dictation runs on whisper.cpp here or on a cloud service.
-->

<script lang="ts">
  import UiRange from '$lib/components/ui/Range.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { LoaderCircle, Play, Square } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { listen } from '$lib/services/bridge';
  import { Button, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import { probeMicrophone, watchMicrophones, type MicState } from '$lib/features/chat/composer/mic-probe';
  import SpeechModelPicker from '$lib/features/chat/composer/SpeechModelPicker.svelte';
  import { listSpeechModels, removeSpeechModel, setupSpeech, useSpeechModel, type SpeechModel } from '$lib/features/chat/composer/speech-models';
  import SettingsPage from '../SettingsPage.svelte';
  import SettingsRow from '../SettingsRow.svelte';
  import SettingsSection from '../SettingsSection.svelte';
  import SpeechServiceSettings from '../voice/SpeechServiceSettings.svelte';
  import VoiceAssignmentEditor from '../voice/VoiceAssignmentEditor.svelte';
  import VoiceEngineSettings from '../voice/VoiceEngineSettings.svelte';
  import VoiceModelList from '../voice/VoiceModelList.svelte';
  import ClonedVoices from '../voice/ClonedVoices.svelte';
  import VoicePicker from '../voice/VoicePicker.svelte';

  let { voiceMode = $bindable('tts') }: { voiceMode?: 'tts' | 'stt' } = $props();

  const tts = $derived(appStore.config.tts ?? {});
  const stt = $derived(appStore.config.stt ?? {});
  const outputOn = $derived(tts.enable_voice_output ?? true);
  const local = $derived(!tts.backend_mode || tts.backend_mode === 'local');

  onMount(() => {
    void speechEngine.refresh();
  });

  // ── How it sounds ────────────────────────────────────────────────────
  let speed = $state(Number(appStore.config.tts?.speed ?? 1));
  let volume = $state(Math.round(Number(appStore.config.tts?.volume ?? 1) * 100));
  let sampling = $state(false);

  async function playSample() {
    if (sampling) {
      ttsStore.stop();
      sampling = false;
      return;
    }
    sampling = true;
    try {
      await ttsStore.speak(`voice-sample-${Date.now()}`, $t('voice.previewText'), appStore.config);
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      sampling = false;
    }
  }

  // ── Dictation ────────────────────────────────────────────────────────
  const STT_LANGUAGES = ['auto', 'en', 'es', 'pt', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'ru', 'nl', 'pl', 'tr', 'ar', 'hi'];
  const languageNames = $derived.by(() => {
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([$locale || 'en'], { type: 'language' }); } catch { /* old runtime */ }
    return (code: string) => (code === 'auto' ? $t('voice.autoDetect') : names?.of(code) ?? code);
  });

  let audioInputDevices = $state<MediaDeviceInfo[]>([]);
  let micState = $state<MicState | 'checking'>('checking');

  async function loadAudioInputDevices() {
    const probe = await probeMicrophone();
    micState = probe.state;
    audioInputDevices = probe.devices;
  }

  // Plugging a microphone in (or out) updates the row without a reload.
  $effect(() => watchMicrophones(() => void loadAudioInputDevices()));

  let speechModels = $state<SpeechModel[]>([]);
  let speechBusy = $state('');
  let speechProgress = $state(0);

  async function loadSpeechModels() {
    speechModels = await listSpeechModels().catch(() => []);
  }

  /** Download installs the engine too, and makes the model the one in use. */
  async function downloadSpeech(quality: string) {
    speechBusy = quality;
    speechProgress = 0;
    const off = await listen<{ phase: string; progress: number }>('voice-setup-progress', (event) => {
      speechProgress = event.phase === 'model' ? event.progress : event.phase === 'done' ? 100 : 0;
    });
    try {
      await setupSpeech(quality);
      await loadSpeechModels();
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      off();
      speechBusy = '';
    }
  }

  async function chooseSpeech(quality: string) {
    speechModels = await useSpeechModel(quality).catch((error) => { toastStore.error(String(error?.message || error)); return speechModels; });
  }

  async function deleteSpeech(quality: string) {
    const accepted = await confirmStore.ask({
      title: $t('voice.tier.removeTitle'),
      message: $t('voice.tier.removeMessage'),
      confirmLabel: $t('voice.tier.remove'),
      danger: true
    });
    if (accepted) speechModels = await removeSpeechModel(quality);
  }

  $effect(() => {
    if (voiceMode !== 'stt') return;
    if (micState === 'checking') void loadAudioInputDevices();
    if (!speechModels.length) void loadSpeechModels();
  });
</script>

<SettingsPage title={$t('voice.title')} description={$t('voice.description')}>
  {#snippet actions()}
    <SegmentedControl
      id="voice-settings"
      label={$t('voice.title')}
      variant="tabs"
      value={voiceMode}
      options={[{ value: 'tts', label: $t('voice.tabSpeak') }, { value: 'stt', label: $t('voice.tabListen') }]}
      onchange={(value) => (voiceMode = value as 'tts' | 'stt')}
    />
  {/snippet}

  {#if voiceMode === 'tts'}
    <SettingsSection title={$t('voice.readAloud')}>
      <SettingsRow label={$t('voice.enableOutput')} description={$t('voice.enableOutputHint')} control="auto">
        <Switch label={$t('voice.enableOutput')} checked={outputOn} onchange={(on) => void appStore.updateTtsSettings({ enable_voice_output: on })} />
      </SettingsRow>
      <SettingsRow label={$t('voice.autoPlay')} description={$t('voice.autoPlayHint')} control="auto">
        <Switch label={$t('voice.autoPlay')} checked={!!tts.auto_play_voice} disabled={!outputOn} onchange={(on) => void appStore.updateTtsSettings({ auto_play_voice: on })} />
      </SettingsRow>
      <SpeechServiceSettings kind="tts" />
    </SettingsSection>

    {#if local}
      <SettingsSection title={$t('voice.engine.title')} description={$t('voice.engine.hint')}>
        <VoiceEngineSettings />
      </SettingsSection>

      <SettingsSection title={$t('voice.engine.modelsTitle')} description={$t('voice.engine.modelsHint')}>
        <VoiceModelList />
      </SettingsSection>

      {#if speechEngine.models.some((model) => model.canClone)}
        <SettingsSection title={$t('voice.clone.title')} description={$t('voice.clone.hint')}>
          <ClonedVoices />
        </SettingsSection>
      {/if}

      {#if speechEngine.active}
        <SettingsSection title={$t('voice.voice')}>
          <VoicePicker />
        </SettingsSection>
      {/if}
    {/if}

    <SettingsSection title={$t('voice.sound')}>
      {#snippet actions()}
        <Button variant="outline" size="sm" onclick={() => void playSample()}>
          {#if sampling}<Square /> {$t('voice.stopPreview')}{:else}<Play /> {$t('voice.playSample')}{/if}
        </Button>
      {/snippet}
      <SettingsRow label={$t('voice.speed')}>
        <div class="flex items-center gap-3">
          <UiRange  min="0.5" max="2" step="0.05" bind:value={speed} onchange={() => void appStore.updateTtsSettings({ speed })} class={uiClass("flex-1 accent-[var(--foreground)]")} aria-label={$t('voice.speed')} />
          <span class="w-11 text-right text-xs tabular-nums text-muted-foreground">{speed.toFixed(2)}×</span>
        </div>
      </SettingsRow>
      <SettingsRow label={$t('voice.volume')}>
        <div class="flex items-center gap-3">
          <UiRange  min="0" max="100" step="5" bind:value={volume} onchange={() => void appStore.updateTtsSettings({ volume: volume / 100 })} class={uiClass("flex-1 accent-[var(--foreground)]")} aria-label={$t('voice.volume')} />
          <span class="w-11 text-right text-xs tabular-nums text-muted-foreground">{volume}%</span>
        </div>
      </SettingsRow>
      <div class="px-4 py-3">
        <VoiceAssignmentEditor label={$t('roleplay.voice.narrator')} value={tts.narrator} previewText={$t('roleplay.voice.narratorPreview')} onchange={(narrator) => void appStore.updateTtsSettings({ narrator: narrator ?? undefined })} />
      </div>
    </SettingsSection>
  {:else}
    <SettingsSection title={$t('voice.dictation')}>
      <SpeechServiceSettings kind="stt" />
      <SettingsRow label={$t('voice.language')} description={$t('voice.languageHint')}>
        <Select
          class="w-full"
          value={stt.language || 'auto'}
          options={STT_LANGUAGES.map((code) => ({ value: code, label: languageNames(code) }))}
          onchange={(value) => void appStore.updateSttSettings({ language: value })}
          aria-label={$t('voice.language')}
        />
      </SettingsRow>

      <SettingsRow label={$t('voice.microphone')} description={micState === 'blocked' ? $t('voice.micDeniedHint') : micState === 'none' ? $t('voice.micNoneHint') : micState === 'busy' ? $t('voice.micBusyHint') : ''}>
        {#if micState === 'blocked'}
          <span class="text-xs text-error">{$t('voice.micDenied')}</span>
        {:else if micState === 'none' || micState === 'unsupported'}
          <span class="text-xs text-muted-foreground">{$t('voice.micNone')}</span>
        {:else if micState === 'busy'}
          <span class="text-xs text-warning">{$t('voice.micBusy')}</span>
        {:else if micState === 'checking'}
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" /> {$t('voice.detectingMics')}</span>
        {:else}
          <Select
            class="w-full"
            value={stt.audio_input_device_id ?? ''}
            options={[
              { value: '', label: $t('voice.systemDefault') },
              ...audioInputDevices.map((device) => ({ value: device.deviceId, label: device.label || $t('voice.micN', { values: { id: device.deviceId.slice(0, 6) } }) }))
            ]}
            onchange={(value) => void appStore.updateSttSettings({ audio_input_device_id: value })}
            aria-label={$t('voice.microphone')}
          />
        {/if}
      </SettingsRow>
    </SettingsSection>

    {#if stt.provider !== 'api'}
      <SettingsSection title={$t('voice.sttModels')} description={$t('voice.tier.sectionHint')}>
        <div class="px-4 py-3">
          {#if speechModels.length}
            <SpeechModelPicker
              models={speechModels}
              mode="manage"
              busy={speechBusy}
              progress={speechProgress}
              ondownload={(quality) => void downloadSpeech(quality)}
              onuse={(quality) => void chooseSpeech(quality)}
              onremove={(quality) => void deleteSpeech(quality)}
            />
          {:else}
            <p class="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" /> {$t('voice.loading')}</p>
          {/if}
        </div>
      </SettingsSection>

    {/if}
  {/if}
</SettingsPage>
