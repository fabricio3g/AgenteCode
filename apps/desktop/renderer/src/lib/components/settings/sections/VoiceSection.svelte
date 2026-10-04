<svelte:options runes={true} />

<!--
  Voice: speaking replies aloud (Kokoro) and dictation (whisper.cpp).
  Each tab puts the everyday choices first (on/off, voice, speed, language,
  microphone) and the model downloads below them.
-->

<script lang="ts">
  import SpeakVoicePicker from '../voice/SpeakVoicePicker.svelte';
  import SpeechServiceSettings from '../voice/SpeechServiceSettings.svelte';
  import VoiceAssignmentEditor from '../voice/VoiceAssignmentEditor.svelte';
  import { locale, t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Check, Download, FolderInput, LoaderCircle, Play, RefreshCw, RotateCcw, Square, Trash2, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { startDownloadHf, cancelDownloadJob } from '$lib/services/downloads';
  import { getModelsDirPath } from '$lib/services/models';
  import { unloadTts } from '$lib/services/tts';
  import { deleteWhisperRuntime, listWhisperRuntimes, pickWhisperRuntimeFile, unloadWhisper, type WhisperRuntime } from '$lib/services/stt';
  import { Badge, Button, Disclosure, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import { listen } from '$lib/services/bridge';
  import { probeMicrophone, watchMicrophones, type MicState } from '$lib/features/chat/composer/mic-probe';
  import SpeechModelPicker from '$lib/features/chat/composer/SpeechModelPicker.svelte';
  import { listSpeechModels, removeSpeechModel, setupSpeech, useSpeechModel, type SpeechModel } from '$lib/features/chat/composer/speech-models';
  import SettingsPage from '../SettingsPage.svelte';
  import SettingsRow from '../SettingsRow.svelte';
  import SettingsSection from '../SettingsSection.svelte';
  import { loadVoiceCatalog, type VoiceModelEntry } from '../voice-catalog';

  let { voiceMode = $bindable('tts') }: { voiceMode?: 'tts' | 'stt' } = $props();

  const tts = $derived(appStore.config.tts ?? {});
  const stt = $derived(appStore.config.stt ?? {});

  // ── Catalog ──────────────────────────────────────────────────────────
  let ttsModels = $state<VoiceModelEntry[]>([]);
  let sttModels = $state<VoiceModelEntry[]>([]);
  let catalogLoading = $state(false);
  let catalogLoaded = $state(false);

  async function reloadCatalog() {
    catalogLoading = true;
    try {
      const catalog = await loadVoiceCatalog({ tts: tts.model_variant, stt: stt.whisper_quality });
      ttsModels = catalog.tts;
      sttModels = catalog.stt;
    } finally {
      catalogLoading = false;
      catalogLoaded = true;
    }
  }

  $effect(() => {
    if (!catalogLoaded && !catalogLoading) void reloadCatalog();
  });

  const activeTts = $derived(ttsModels.find((entry) => entry.is_active) ?? null);
  const activeStt = $derived(sttModels.find((entry) => entry.is_active) ?? null);

  function describe(entry: VoiceModelEntry): string {
    const id = `voice.modelDesc.${entry.key}`;
    const text = get(t)(id);
    return text === id ? entry.description : text;
  }

  // ── Downloads ────────────────────────────────────────────────────────
  let starting = $state<string | null>(null);

  function jobsFor(entry: VoiceModelEntry) {
    return downloadsStore.jobs.filter((job) => job.repo_id === entry.repo_id && entry.files.includes(job.file));
  }

  function downloadState(entry: VoiceModelEntry) {
    const jobs = jobsFor(entry);
    const active = jobs.filter((job) => job.status === 'starting' || job.status === 'running');
    const failed = jobs.filter((job) => job.status === 'error');
    const done = jobs.filter((job) => job.status === 'done').length;
    const progress = entry.files.length
      ? Math.round((jobs.reduce((sum, job) => sum + (job.status === 'done' ? 100 : Number(job.progress || 0)), 0)) / entry.files.length)
      : 0;
    return {
      downloading: active.length > 0 || starting === entry.key,
      failed: failed.length > 0 && active.length === 0,
      finished: !entry.downloaded && done >= entry.files.length && entry.files.length > 0,
      progress,
      active,
      failedJobs: failed
    };
  }

  // A finished download only shows as installed after the files are checked;
  // check once per finished model so a failed check cannot loop.
  const checkedAfterDownload = new Set<string>();
  $effect(() => {
    const finished = [...ttsModels, ...sttModels].filter((entry) => downloadState(entry).finished && !checkedAfterDownload.has(entry.key));
    if (!finished.length || catalogLoading) return;
    for (const entry of finished) checkedAfterDownload.add(entry.key);
    void reloadCatalog();
  });

  async function download(entry: VoiceModelEntry) {
    if (!entry.repo_id) return;
    starting = entry.key;
    try {
      for (const job of downloadState(entry).failedJobs) await downloadsStore.removeJob(job.id);
      const modelsDir = await getModelsDirPath();
      for (const file of entry.files) {
        await startDownloadHf({ repo_id: entry.repo_id, file, models_dir: modelsDir, dest_rel: `${entry.destPrefix}${entry.dir}/${file}` });
      }
      downloadsStore.startPolling();
      await downloadsStore.refresh();
    } catch (err) {
      toastStore.error($t('voice.downloadFailed', { values: { reason: (err as Error)?.message || String(err) } }));
    } finally {
      starting = null;
    }
  }

  async function cancel(entry: VoiceModelEntry) {
    for (const job of downloadState(entry).active) await cancelDownloadJob(job.id);
    await downloadsStore.refresh();
  }

  async function activate(entry: VoiceModelEntry) {
    try {
      if (entry.kind === 'tts') {
        const voice = entry.voices?.includes(tts.voice || '') ? tts.voice : entry.voices?.[0];
        await appStore.updateTtsSettings({
          engine: entry.engine as 'kokoro' | undefined,
          model_path: entry.model_path || '',
          voices_path: entry.voices_path || '',
          tokens_path: entry.tokens_path || '',
          lexicon_path: entry.lexicon_path || '',
          dict_dir: entry.dict_dir || '',
          data_dir: entry.data_dir || '',
          model_variant: entry.key,
          ...(voice ? { voice } : {})
        });
      } else {
        await appStore.updateSttSettings({ whisper_quality: entry.key });
      }
      toastStore.success($t('voice.nowUsing', { values: { name: entry.label } }));
      await reloadCatalog();
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    }
  }

  async function unload(entry: VoiceModelEntry) {
    try {
      if (entry.kind === 'tts') {
        await unloadTts();
      } else {
        await unloadWhisper();
        await appStore.updateSttSettings({ whisper_quality: '' });
        await reloadCatalog();
      }
      toastStore.success($t('voice.unloaded'));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    }
  }

  // ── Speech output ────────────────────────────────────────────────────
  let speed = $state(Number(appStore.config.tts?.speed ?? 1));
  let volume = $state(Math.round(Number(appStore.config.tts?.volume ?? 1) * 100));
  const outputOn = $derived(tts.enable_voice_output ?? true);
  let previewing = $state(false);

  async function preview() {
    if (previewing) {
      ttsStore.stop();
      previewing = false;
      return;
    }
    previewing = true;
    try {
      await ttsStore.speak(`voice-preview-${Date.now()}`, $t('voice.previewText'), appStore.config);
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      previewing = false;
    }
  }

  // ── Speech input ─────────────────────────────────────────────────────
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

  // ── Dictation models (Fast · Balanced · Best) ─────────────────────────
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
      await loadWhisperRuntimeList();
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      off();
      speechBusy = '';
    }
  }

  async function chooseSpeech(quality: string) {
    speechModels = await useSpeechModel(quality).catch((err) => { toastStore.error(String(err?.message || err)); return speechModels; });
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

  let whisperRuntimes = $state<WhisperRuntime[]>([]);
  let whisperRuntimesLoading = $state(false);
  let whisperRuntimesLoaded = $state(false);

  async function loadWhisperRuntimeList() {
    whisperRuntimesLoading = true;
    try {
      whisperRuntimes = await listWhisperRuntimes();
    } catch {
      whisperRuntimes = [];
    } finally {
      whisperRuntimesLoading = false;
      whisperRuntimesLoaded = true;
    }
  }

  async function useWhisperRuntime(path: string) {
    await appStore.updateSttSettings({ runtime_path: path });
    await loadWhisperRuntimeList();
  }

  async function chooseCustomRuntime() {
    const path = await pickWhisperRuntimeFile().catch(() => null);
    if (path) await useWhisperRuntime(path);
  }

  async function removeWhisperRuntime(runtime: WhisperRuntime) {
    const accepted = await confirmStore.ask({
      title: $t('voice.deleteRuntimeTitle', { values: { name: runtime.variant } }),
      message: $t('voice.deleteRuntimeMessage'),
      confirmLabel: $t('voice.delete'),
      danger: true
    });
    if (!accepted) return;
    await deleteWhisperRuntime(runtime.path);
    await loadWhisperRuntimeList();
  }

  $effect(() => {
    if (voiceMode !== 'stt') return;
    if (micState === 'checking') void loadAudioInputDevices();
    if (!whisperRuntimesLoaded && !whisperRuntimesLoading) void loadWhisperRuntimeList();
    if (!speechModels.length) void loadSpeechModels();
  });
</script>

{#snippet modelRow(entry: VoiceModelEntry)}
  {@const state = downloadState(entry)}
  <div class="py-3">
    <div class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
          {entry.label}
          {#if entry.is_active}<Badge tone="success">{$t('voice.inUse')}</Badge>
          {:else if entry.recommended && !entry.downloaded}<Badge>{$t('voice.recommended')}</Badge>{/if}
        </p>
        <p class="text-xs text-muted-foreground">
          {[describe(entry), entry.size_mb ? (entry.size_mb >= 1024 ? `${(entry.size_mb / 1024).toFixed(1)} GB` : `${entry.size_mb} MB`) : ''].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if state.downloading}
          <Button variant="ghost" size="sm" onclick={() => void cancel(entry)}><X /> {$t('voice.cancel')}</Button>
        {:else if state.failed}
          <Button variant="outline" size="sm" onclick={() => void download(entry)}><RotateCcw /> {$t('voice.retry')}</Button>
        {:else if entry.is_active}
          <Button variant="ghost" size="sm" onclick={() => void unload(entry)}>{$t('voice.unload')}</Button>
        {:else if entry.downloaded}
          <Button variant="outline" size="sm" onclick={() => void activate(entry)}>{$t('voice.use')}</Button>
        {:else}
          <Button variant={entry.recommended ? 'default' : 'outline'} size="sm" onclick={() => void download(entry)} disabled={!entry.repo_id}>
            <Download /> {$t('voice.download')}
          </Button>
        {/if}
      </div>
    </div>
    {#if state.downloading}
      <div class="mt-2 flex items-center gap-2">
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
          <div class="h-full rounded-full bg-primary transition-[width]" style="width:{Math.max(4, state.progress)}%"></div>
        </div>
        <span class="w-10 text-right text-[12px] tabular-nums text-muted-foreground">{state.progress}%</span>
      </div>
    {:else if state.failed}
      <p class="mt-1.5 text-xs text-error">{$t('voice.downloadError')}</p>
    {/if}
  </div>
{/snippet}

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
      {#if !tts.backend_mode || tts.backend_mode === 'local'}<SpeakVoicePicker />{/if}
      <div class="px-4 py-3 sm:px-5"><VoiceAssignmentEditor label={$t('roleplay.voice.narrator')} value={tts.narrator} previewText={$t('roleplay.voice.narratorPreview')} onchange={(narrator) => void appStore.updateTtsSettings({ narrator: narrator ?? undefined })} /></div>

      <SettingsRow label={$t('voice.speed')} control="auto">
        <div class="flex w-56 items-center gap-3">
          <input type="range" min="0.5" max="2" step="0.05" bind:value={speed} onchange={() => void appStore.updateTtsSettings({ speed })} class="flex-1 accent-[var(--primary)]" aria-label={$t('voice.speed')} />
          <span class="w-10 text-right text-xs tabular-nums text-muted-foreground">{speed.toFixed(2)}×</span>
        </div>
      </SettingsRow>

      <SettingsRow label={$t('voice.volume')} control="auto">
        <div class="flex w-56 items-center gap-3">
          <input type="range" min="0" max="100" step="5" bind:value={volume} onchange={() => void appStore.updateTtsSettings({ volume: volume / 100 })} class="flex-1 accent-[var(--primary)]" aria-label={$t('voice.volume')} />
          <span class="w-10 text-right text-xs tabular-nums text-muted-foreground">{volume}%</span>
        </div>
      </SettingsRow>
    </SettingsSection>

  {:else}
    <SettingsSection title={$t('voice.dictation')}>
      <SpeechServiceSettings kind="stt" />
      <SettingsRow label={$t('voice.language')} description={$t('voice.languageHint')} control="auto">
        <Select
          class="w-56"
          value={stt.language || 'auto'}
          options={STT_LANGUAGES.map((code) => ({ value: code, label: languageNames(code) }))}
          onchange={(value) => void appStore.updateSttSettings({ language: value })}
          aria-label={$t('voice.language')}
        />
      </SettingsRow>

      <SettingsRow label={$t('voice.microphone')} description={micState === 'blocked' ? $t('voice.micDeniedHint') : micState === 'none' ? $t('voice.micNoneHint') : micState === 'busy' ? $t('voice.micBusyHint') : ''} control="auto">
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
            class="w-56"
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

    {#if stt.provider !== 'api'}<SettingsSection title={$t('voice.sttModels')} description={$t('voice.tier.sectionHint')}>
      <div class="px-4 py-3 sm:px-5">
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

    <Disclosure title={$t('voice.advancedEngine')} description={$t('voice.whisperRuntimeHint')} class="border border-[var(--border)] bg-[var(--card)]">
    <SettingsSection title={$t('voice.whisperRuntime')}>
      {#snippet actions()}
        <Button variant="ghost" size="sm" onclick={() => void chooseCustomRuntime()}><FolderInput /> {$t('voice.customBuild')}</Button>
      {/snippet}
      {#if whisperRuntimesLoading && !whisperRuntimes.length}
        <p class="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground sm:px-5"><LoaderCircle class="size-4 animate-spin" /> {$t('voice.scanning')}</p>
      {:else if !whisperRuntimes.length}
        <p class="px-4 py-3 text-xs text-muted-foreground sm:px-5">{$t('voice.noWhisperRuntime')}</p>
      {:else}
        {#each whisperRuntimes as runtime (runtime.path)}
          <div class="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <span class="flex size-4 shrink-0 items-center justify-center rounded-full border {runtime.is_active ? 'border-primary bg-primary text-primary-fg' : 'border-border'}">
              {#if runtime.is_active}<Check class="size-2.5" />{/if}
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-foreground">{runtime.variant}</p>
              <p class="truncate text-[12px] text-muted-foreground" title={runtime.path}>{runtime.path}</p>
            </div>
            {#if runtime.is_active}
              <Badge tone="success">{$t('voice.inUse')}</Badge>
            {:else}
              <Button variant="outline" size="sm" onclick={() => void useWhisperRuntime(runtime.path)}>{$t('voice.use')}</Button>
            {/if}
            <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-error" onclick={() => void removeWhisperRuntime(runtime)} aria-label={$t('voice.deleteRuntimeTitle', { values: { name: runtime.variant } })}>
              <Trash2 />
            </Button>
          </div>
        {/each}
      {/if}
    </SettingsSection>
    </Disclosure>
    {/if}
  {/if}
</SettingsPage>
