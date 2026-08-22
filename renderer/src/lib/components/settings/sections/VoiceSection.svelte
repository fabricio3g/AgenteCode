<svelte:options runes={true} />

<!--
  Voice settings: local TTS (Kokoro) and STT (whisper.cpp) in one section.
  Extracted verbatim from the old ModelHubModal monolith; owns its catalog
  loading, downloads, runtime management, and mic selection.
-->

<script lang="ts">
  import { Ban, Check, Download, FolderInput, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { fetchModelCatalog } from '$lib/services/search';
  import { startDownloadHf, cancelDownloadJob } from '$lib/services/downloads';
  import { getModelsDirPath } from '$lib/services/models';
  import { pathExists } from '$lib/services/files';
  import { isElectron } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { unloadTts } from '$lib/services/tts';
  import {
    deleteWhisperRuntime,
    listWhisperRuntimes,
    pickWhisperRuntimeFile,
    unloadWhisper,
    type WhisperRuntime
  } from '$lib/services/stt';
  import { loadAppConfig, saveAppConfig } from '$lib/utils/storage';
  import VoiceLanguageSelector from '../VoiceLanguageSelector.svelte';
  import { SegmentedControl, Select } from '$lib/components/ui';

  let { voiceMode = $bindable('tts') }: { voiceMode?: 'tts' | 'stt' } = $props();

  let voiceModels = $state<Record<string, any>>({});
  let whisperModels = $state<Record<string, any>>({});
  let whisperRuntimes = $state<WhisperRuntime[]>([]);
  let whisperRuntimesLoading = $state(false);
  let voiceCatalogLoading = $state(false);
  let ttsVoice = $state(appStore.config.tts?.voice || '');
  let downloadingVoice = $state<string | null>(null);
  let downloadingWhisper = $state<string | null>(null);

  const VOICE_TTS_FALLBACK_CATALOG: Record<string, any> = {
    kokoro_v11: {
      label: 'Kokoro v1.1 Multi-language (High Quality)', description: '103 voices, 9 languages, improved quality. Recommended.',
      repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main',
      dir: 'kokoro-multi-lang-v1_1', engine: 'kokoro', size_mb: 170,
      model_file: 'model.int8.onnx', tokens_file: 'tokens.txt',
      voices_file: 'voices.bin', lexicon_file: 'lexicon-us-en.txt',
      files: ['model.int8.onnx', 'voices.bin', 'tokens.txt',
              'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'lexicon-zh.txt',
              'date-zh.fst', 'number-zh.fst', 'phone-zh.fst',
              'dict/hmm_model.utf8', 'dict/idf.utf8', 'dict/jieba.dict.utf8',
              'dict/stop_words.utf8', 'dict/user.dict.utf8'],
      voices: [
        'af_maple', 'af_sol', 'bf_vale',
        'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007', 'zf_008',
        'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024',
        'zf_026', 'zf_027', 'zf_032', 'zf_036', 'zf_038', 'zf_039',
        'zf_040', 'zf_042', 'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048',
        'zf_049', 'zf_051', 'zf_059', 'zf_060', 'zf_067', 'zf_070', 'zf_071',
        'zf_072', 'zf_073', 'zf_074', 'zf_075', 'zf_076', 'zf_077', 'zf_078',
        'zf_079', 'zf_083', 'zf_084', 'zf_085', 'zf_086', 'zf_087', 'zf_088',
        'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099',
        'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015',
        'zm_016', 'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033',
        'zm_034', 'zm_035', 'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052',
        'zm_053', 'zm_054', 'zm_055', 'zm_056', 'zm_057', 'zm_058', 'zm_061',
        'zm_062', 'zm_063', 'zm_064', 'zm_065', 'zm_066', 'zm_068', 'zm_069',
        'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091', 'zm_095', 'zm_096',
        'zm_097', 'zm_098', 'zm_100',
      ],
    },
    kokoro_82m_v1: {
      label: 'Kokoro Multi-lang v1.0', description: '53 voices across 9 languages (EN, JP, ZH, ES, FR, HI, IT, PT)',
      repo: 'csukuangfj/kokoro-int8-multi-lang-v1_0', branch: 'main',
      dir: 'kokoro-multi-lang-v1_0', engine: 'kokoro', size_mb: 160,
      model_file: 'model.int8.onnx', tokens_file: 'tokens.txt',
      voices_file: 'voices.bin', lexicon_file: 'lexicon-us-en.txt',
      files: ['model.int8.onnx', 'voices.bin', 'tokens.txt',
              'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'lexicon-zh.txt',
              'date-zh.fst', 'number-zh.fst', 'phone-zh.fst',
              'dict/hmm_model.utf8', 'dict/idf.utf8', 'dict/jieba.dict.utf8',
              'dict/stop_words.utf8', 'dict/user.dict.utf8'],
      voices: [
        'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
        'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
        'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
        'am_michael', 'am_onyx', 'am_puck', 'am_santa',
        'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
        'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
        'ef_dora', 'em_alex', 'ff_siwis',
        'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
        'if_sara', 'im_nicola',
        'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
        'pf_dora', 'pm_alex', 'pm_santa',
        'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
        'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
      ],
    },
  };

  const VOICE_WHISPER_FALLBACK_CATALOG: Record<string, any> = {
    tiny_q5: {
      label: 'Tiny (Q5_1)', description: 'Fastest, 99 languages',
      repo: 'ggerganov/whisper.cpp',
      dir: 'whisper-ggml',
      files: ['ggml-tiny-q5_1.bin'],
      size_mb: 32, speed: 'Fastest', quality: 'Basic',
    },
    base_q5: {
      label: 'Base (Q5_1)', description: 'Fast, 99 languages',
      repo: 'ggerganov/whisper.cpp',
      dir: 'whisper-ggml',
      files: ['ggml-base-q5_1.bin'],
      size_mb: 62, speed: 'Fast', quality: 'Good',
    },
    small_q5: {
      label: 'Small (Q5_1)', description: 'Balanced, 99 languages',
      repo: 'ggerganov/whisper.cpp',
      dir: 'whisper-ggml',
      files: ['ggml-small-q5_1.bin'],
      size_mb: 206, speed: 'Medium', quality: 'Better',
    },
    medium_q5: {
      label: 'Medium (Q5_0) — Recommended', description: 'Best balance, 99 languages',
      repo: 'ggerganov/whisper.cpp',
      dir: 'whisper-ggml',
      files: ['ggml-medium-q5_0.bin'],
      size_mb: 539, speed: 'Slower', quality: 'Best',
    },
    large_v3_q5: {
      label: 'Large v3 (Q5_0)', description: 'Highest accuracy, 99 languages',
      repo: 'ggerganov/whisper.cpp',
      dir: 'whisper-ggml',
      files: ['ggml-large-v3-q5_0.bin'],
      size_mb: 1100, speed: 'Slowest', quality: 'Best+',
    },
  };

  function normalizeSizeMb(meta: any): number | undefined {
    const direct = Number(meta?.size_mb);
    if (Number.isFinite(direct) && direct > 0) return Math.round(direct);

    const mb = Number(meta?.sizeMB);
    if (Number.isFinite(mb) && mb > 0) return Math.round(mb);

    const bytes = Number(meta?.size_bytes ?? meta?.bytes ?? meta?.size);
    if (Number.isFinite(bytes) && bytes > 1024 * 1024) return Math.round(bytes / (1024 * 1024));

    const human = String(meta?.size_human || meta?.sizeHuman || '').trim();
    if (human) {
      const match = human.match(/([\d.]+)\s*(KB|MB|GB)/i);
      if (match) {
        const value = Number(match[1]);
        const unit = match[2].toUpperCase();
        if (Number.isFinite(value) && value > 0) {
          if (unit === 'KB') return Math.max(1, Math.round(value / 1024));
          if (unit === 'MB') return Math.round(value);
          if (unit === 'GB') return Math.round(value * 1024);
        }
      }
    }

    return undefined;
  }

  async function loadVoiceModelCatalog() {
    voiceCatalogLoading = true;
    try {
      const catalog = await fetchModelCatalog() as any;
      const remoteTts = catalog?.tts || {};
      const remoteWhisper = catalog?.whisper || {};
      const modelsDir = isElectron() ? await getModelsDirPath() : '';
      const selectedTts = appStore.config.tts?.model_variant || '';
      const selectedWhisper = appStore.config.stt?.whisper_quality || '';

      const ttsCatalog: Record<string, any> = {};
      const ttsKeys = Array.from(new Set([
        ...Object.keys(VOICE_TTS_FALLBACK_CATALOG),
        ...Object.keys(remoteTts || {})
      ]));
      for (const key of ttsKeys) {
        const fallback: any = VOICE_TTS_FALLBACK_CATALOG[key] || {};
        const remoteMeta: any = (remoteTts?.[key] || {}) as object;
        const meta: any = { ...fallback, ...remoteMeta };
        const repoId = String(meta.repo_id || meta.repo || '');
        const dir = String(meta.dir || key);
        const size_mb = normalizeSizeMb(meta) ?? normalizeSizeMb(fallback);
        const files: string[] = Array.isArray(meta.files) && meta.files.length
          ? meta.files.map((f: unknown) => String(f))
          : [String(meta.model_file || 'model.onnx'), String(meta.voices_file || 'voices.bin'), String(meta.tokens_file || 'tokens.txt')];
        let downloaded = false;
        if (modelsDir && isElectron()) {
          const checks = await Promise.all(files.map((f) => pathExists(`${modelsDir}/${dir}/${f}`)));
          downloaded = checks.every(Boolean);
        }
        const is_active = downloaded && key === selectedTts;
        const primaryFile = files[0];
        ttsCatalog[key] = {
          ...meta, repo_id: repoId, dir, files,
          size_mb,
          model_path: `${modelsDir}/${dir}/${primaryFile}`,
          voices_path: `${modelsDir}/${dir}/${meta.voices_file || 'voices.bin'}`,
          tokens_path: `${modelsDir}/${dir}/${meta.tokens_file || 'tokens.txt'}`,
          lexicon_path: `${modelsDir}/${dir}/${meta.lexicon_file || 'lexicon.txt'}`,
          dict_dir: `${modelsDir}/${dir}/${meta.dict_dir || 'dict'}`,
          data_dir: `${modelsDir}/${dir}/${meta.data_dir || 'espeak-ng-data'}`,
          downloaded, is_active,
        };
      }
      voiceModels = ttsCatalog;

      const whisperCatalog: Record<string, any> = {};
      const whisperKeys = Array.from(new Set([
        ...Object.keys(VOICE_WHISPER_FALLBACK_CATALOG),
        ...Object.keys(remoteWhisper || {})
      ]));
      for (const key of whisperKeys) {
        const fallback: any = VOICE_WHISPER_FALLBACK_CATALOG[key] || {};
        const remoteMeta: any = (remoteWhisper?.[key] || {}) as object;
        const meta: any = { ...fallback, ...remoteMeta };
        const repoId = String(meta.repo_id || meta.repo || `csukuangfj/sherpa-onnx-whisper-${key}.en`);
        const dir = String(meta.dir || `sherpa-onnx-whisper-${key}.en`);
        const files: string[] = Array.isArray(meta.files) && meta.files.length
          ? meta.files.map((f: unknown) => String(f))
          : [`${key}.en-encoder.int8.onnx`, `${key}.en-decoder.int8.onnx`, `${key}.en-tokens.txt`];
        const size_mb = normalizeSizeMb(meta) ?? normalizeSizeMb(fallback);
        let downloaded = false;
        if (modelsDir && isElectron()) {
          const checks = await Promise.all(files.map((f) => pathExists(`${modelsDir}/whisper/${dir}/${f}`)));
          downloaded = checks.every(Boolean);
        }
        whisperCatalog[key] = {
          ...meta, repo_id: repoId, dir, files, size_mb, downloaded,
          is_active: downloaded && key === selectedWhisper,
        };
      }
      whisperModels = whisperCatalog;
    } catch (err) {
      console.warn('load voice catalog failed, using fallback:', err);
      voiceModels = { ...VOICE_TTS_FALLBACK_CATALOG };
      whisperModels = { ...VOICE_WHISPER_FALLBACK_CATALOG };
    } finally {
      voiceCatalogLoading = false;
    }
  }

  async function setWhisperQuality(quality: string) {
    const current = await loadAppConfig();
    await saveAppConfig({ ...current, stt: { ...(current.stt || {}), whisper_quality: quality } });
  }

  async function loadWhisperRuntimeList() {
    whisperRuntimesLoading = true;
    try {
      whisperRuntimes = await listWhisperRuntimes();
    } catch (err) {
      console.warn('load whisper runtimes failed:', err);
      whisperRuntimes = [];
    } finally {
      whisperRuntimesLoading = false;
    }
  }

  async function selectCustomWhisperRuntime() {
    try {
      const runtimePath = await pickWhisperRuntimeFile();
      if (!runtimePath) return;
      const current = await loadAppConfig();
      await saveAppConfig({ ...current, stt: { ...(current.stt || {}), runtime_path: runtimePath } });
      await loadWhisperRuntimeList();
      toastStore.success('Custom whisper.cpp runtime selected');
    } catch (err) {
      toastStore.error(`Failed to select runtime: ${(err as Error)?.message || err}`);
    }
  }

  async function useWhisperRuntime(runtime: WhisperRuntime) {
    try {
      const current = await loadAppConfig();
      await saveAppConfig({ ...current, stt: { ...(current.stt || {}), runtime_path: runtime.path } });
      await loadWhisperRuntimeList();
      toastStore.success(`Using whisper.cpp ${runtime.variant} runtime`);
    } catch (err) {
      toastStore.error(`Failed to select runtime: ${(err as Error)?.message || err}`);
    }
  }

  async function removeWhisperRuntime(runtime: WhisperRuntime) {
    try {
      await deleteWhisperRuntime(runtime.path);
      await loadWhisperRuntimeList();
      toastStore.success('Whisper runtime removed');
    } catch (err) {
      toastStore.error(`Failed to remove runtime: ${(err as Error)?.message || err}`);
    }
  }

  const primaryVoiceEntry = $derived.by(() => {
    const entries = Object.entries(voiceModels);
    return entries.find(([, item]: [string, any]) => item.is_active)
      || entries.find(([key]) => key === 'kokoro_v11')
      || entries[0]
      || null;
  });

  async function activateVoiceModel(key: string, item: any) {
    try {
      await appStore.updateTtsSettings({
        engine: item.engine,
        model_path: item.model_path || '',
        voices_path: item.voices_path || '',
        tokens_path: item.tokens_path || '',
        lexicon_path: item.lexicon_path || '',
        dict_dir: item.dict_dir || '',
        data_dir: item.data_dir || '',
        model_variant: key
      });
      ttsVoice = item.voices?.[0] || ttsVoice;
      if (ttsVoice) await appStore.updateTtsSettings({ voice: ttsVoice });
      toastStore.success(`Using ${item.label || key}`);
      await loadVoiceModelCatalog();
    } catch (err) {
      toastStore.error(`Failed to activate: ${(err as Error)?.message || err}`);
    }
  }

  async function downloadVoiceModel(key: string, item: any, clearErrors = false) {
    if (!item.repo_id) {
      toastStore.error('No repo ID');
      return;
    }
    if (clearErrors) {
      const errorJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && j.status === 'error');
      for (const job of errorJobs) await downloadsStore.removeJob(job.id);
    }
    try {
      downloadingVoice = key;
      const dir = await getModelsDirPath();
      for (const file of item.files || []) {
        await startDownloadHf({ repo_id: item.repo_id, file, models_dir: dir, dest_rel: `${item.dir}/${file}` });
      }
      downloadsStore.startPolling();
      await downloadsStore.refresh();
      toastStore.success(`Downloading ${item.label || key}...`);
    } catch (err) {
      toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
    } finally {
      downloadingVoice = null;
    }
  }

  async function cancelVoiceDownloads(item: any) {
    const activeJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && (j.status === 'starting' || j.status === 'running'));
    for (const job of activeJobs) await cancelDownloadJob(job.id);
    downloadingVoice = null;
    await downloadsStore.refresh();
  }

  // ── Microphone device selector ──
  let audioInputDevices = $state<MediaDeviceInfo[]>([]);
  let selectedMicId = $state(appStore.config.stt?.audio_input_device_id ?? '');
  let micPermission = $state<'unknown' | 'granted' | 'denied'>('unknown');

  async function loadAudioInputDevices() {
    try {
      // Request permission so we get device labels
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      micPermission = 'granted';
    } catch {
      micPermission = 'denied';
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      audioInputDevices = all.filter(d => d.kind === 'audioinput');
    } catch { /* no devices */ }
  }

  async function saveMicDevice(deviceId: string) {
    selectedMicId = deviceId;
    const current = await loadAppConfig();
    await saveAppConfig({ ...current, stt: { ...(current.stt ?? {}), audio_input_device_id: deviceId } });
  }

  $effect(() => {
    void voiceMode;
    if (Object.keys(voiceModels).length === 0) {
      void loadVoiceModelCatalog();
    }
  });

  $effect(() => {
    if (voiceMode === 'stt' && audioInputDevices.length === 0 && micPermission !== 'denied') {
      void loadAudioInputDevices();
    }
  });

  $effect(() => {
    if (voiceMode === 'stt' && !whisperRuntimesLoading && whisperRuntimes.length === 0) {
      void loadWhisperRuntimeList();
    }
  });
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
  <div class="flex-1 overflow-y-auto bg-background">
    <div class="mx-auto max-w-[760px] space-y-4 p-5 sm:p-6">
      <header class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold tracking-[-0.02em] text-foreground">Voice</h2>
          <p class="mt-1 text-sm text-muted-foreground">Configure local speech output and transcription.</p>
        </div>
        <SegmentedControl
          id="voice-settings"
          label="Voice settings"
          variant="tabs"
          value={voiceMode}
          options={[{ value: 'tts', label: 'Text to speech' }, { value: 'stt', label: 'Speech to text' }]}
          onchange={(value) => (voiceMode = value as 'tts' | 'stt')}
        />
      </header>

      {#if voiceMode === 'tts'}
        {#if voiceCatalogLoading}
          <div class="flex items-center justify-center py-16">
            <div class="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--text-muted)]"></div>
          </div>
        {:else if !primaryVoiceEntry}
          <div class="rounded-xl bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
            No voice models available
          </div>
        {:else}
          {@const key = primaryVoiceEntry[0]}
          {@const item = primaryVoiceEntry[1]}
          {@const activeJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && (j.status === 'starting' || j.status === 'running'))}
          {@const errorJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && j.status === 'error')}
          {@const isDownloading = activeJobs.length > 0 || downloadingVoice === key}
          {@const hasError = errorJobs.length > 0 && activeJobs.length === 0}
          {@const doneJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && j.status === 'done')}
          {@const totalFiles = Array.isArray(item.files) ? item.files.length : 0}

          <div class="rounded-xl bg-[var(--surface)] p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold text-[var(--text)]">{item.label || 'Kokoro Voice'}</h3>
                <p class="mt-0.5 text-xs text-[var(--text-tertiary)]">Kokoro{item.size_mb ? ` · ${item.size_mb} MB` : ''}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                {#if isDownloading}
                  <button type="button" class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => cancelVoiceDownloads(item)}>
                    <Ban class="inline h-3 w-3" />
                    Cancel
                  </button>
                {:else if hasError}
                  <button type="button" class="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90" onclick={() => downloadVoiceModel(key, item, true)}>
                    <RotateCcw class="h-3 w-3" />
                    Retry
                  </button>
                {:else if item.downloaded && !item.is_active}
                  <button type="button" class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90" onclick={() => activateVoiceModel(key, item)}>
                    Use
                  </button>
                {:else if item.is_active}
                  <button type="button" class="rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => unloadTts()}>
                    Unload
                  </button>
                {:else}
                  <button type="button" class="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={downloadingVoice === key} onclick={() => downloadVoiceModel(key, item)}>
                    <Download class="h-3 w-3" />
                    Download
                  </button>
                {/if}
              </div>
            </div>

            <div class="space-y-1">
              <div class="flex justify-between gap-3 text-sm">
                <span class="text-[var(--text-secondary)]">Name</span>
                <span class="text-[var(--text)]">{item.label || key}</span>
              </div>
              <div class="flex justify-between gap-3 text-sm">
                <span class="text-[var(--text-secondary)]">Status</span>
                <span class="text-[var(--text)]">
                  {#if item.is_active}
                    Active
                  {:else if item.downloaded}
                    Ready
                  {:else}
                    Not installed
                  {/if}
                </span>
              </div>
              <div class="flex justify-between gap-3 text-sm">
                <span class="text-[var(--text-secondary)]">Size</span>
                <span class="text-[var(--text)]">{item.size_mb ? `${item.size_mb} MB` : '—'}</span>
              </div>
              {#if isDownloading}
                <div class="flex justify-between gap-3 pt-1">
                  <span class="text-sm text-[var(--text-secondary)]">Progress</span>
                  <div class="flex items-center gap-2">
                    <div class="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--surface-active)]">
                      <div class="h-full rounded-full bg-[var(--primary)] transition-all" style="width: {activeJobs[0]?.progress || 8}%"></div>
                    </div>
                    <span class="text-xs tabular-nums text-[var(--text-muted)]">{activeJobs[0]?.progress.toFixed(0) || 0}%</span>
                  </div>
                </div>
              {/if}
            </div>

            {#if doneJobs.length > 0 && doneJobs.length >= totalFiles && !item.downloaded}
              <div class="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)]">
                <span class="inline-flex items-center gap-1.5">
                  <Check class="h-3.5 w-3.5" />
                  Download complete
                </span>
                <button type="button" class="rounded-full px-2 py-1 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => loadVoiceModelCatalog()}>
                  Refresh
                </button>
              </div>
            {/if}

            {#if item.is_active && Array.isArray(item.voices) && item.voices.length > 0}
              <div class="border-t border-[var(--border)] pt-3">
                <div class="mb-2 flex justify-between gap-3">
                  <span class="text-sm font-medium text-[var(--text)]">Voice</span>
                  <span class="text-sm text-[var(--text-secondary)]">{ttsVoice}</span>
                </div>
                <VoiceLanguageSelector
                  selectedVoice={ttsVoice}
                  onSelect={async (voice) => {
                    ttsVoice = voice;
                    await appStore.updateTtsSettings({ voice });
                    toastStore.success(`Voice set to ${voice}`);
                  }}
                />
              </div>
            {/if}
          </div>
        {/if}
      {:else}
        <!-- Microphone -->
        <div class="rounded-xl bg-[var(--surface)] p-4 space-y-3">
          <h3 class="text-sm font-semibold text-[var(--text)]">Microphone</h3>
          {#if micPermission === 'denied'}
            <div class="space-y-2">
              <div class="flex justify-between gap-3 text-sm">
                <span class="text-[var(--text-secondary)]">Permission</span>
                <span class="text-[var(--text)]">Denied</span>
              </div>
              <p class="text-xs text-[var(--text-secondary)]">
                Microphone access was denied. Grant permission in your browser/system settings to select a device.
              </p>
            </div>
          {:else if audioInputDevices.length === 0}
            <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--text-muted)]"></div>
              Detecting audio devices…
            </div>
          {:else}
            <div class="flex flex-col gap-1.5">
              <label for="mic-select" class="text-xs text-[var(--text-muted)]">Select the microphone for voice input</label>
              <Select
                id="mic-select"
                class="w-full"
                value={selectedMicId}
                options={[
                  { value: '', label: 'System default' },
                  ...audioInputDevices.map((device) => ({
                    value: device.deviceId,
                    label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
                  })),
                ]}
                onchange={(value) => void saveMicDevice(value)}
              />
              {#if selectedMicId && selectedMicId !== ''}
                <p class="text-[11px] text-[var(--text-muted)]">
                  Selected device will be used for speech recognition in this session.
                </p>
              {/if}
            </div>
          {/if}
        </div>

        <!-- whisper.cpp runtime -->
        <div class="rounded-xl bg-[var(--surface)] p-4 space-y-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-[var(--text)]">whisper.cpp runtime</h3>
              <p class="mt-0.5 text-xs text-[var(--text-muted)]">Auto-detects CUDA, Vulkan, or CPU from installed runtimes.</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                onclick={loadWhisperRuntimeList}
              >
                <RefreshCw class="inline h-3 w-3" />
                Refresh
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                onclick={selectCustomWhisperRuntime}
              >
                <FolderInput class="inline h-3 w-3" />
                Custom build
              </button>
            </div>
          </div>

          {#if whisperRuntimesLoading}
            <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
              Scanning runtimes...
            </div>
          {:else if whisperRuntimes.length === 0}
            <p class="text-xs text-[var(--text-muted)]">
              No managed whisper.cpp runtime is installed yet. Bundled builds will appear here when present in <code>resources/bin</code>; use Custom build to select an existing <code>whisper-cli</code> binary.
            </p>
          {:else}
            <div class="space-y-2">
              {#each whisperRuntimes as runtime (runtime.path)}
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium text-[var(--text)]">{runtime.variant}</span>
                      {#if runtime.is_active}
                        <span class="rounded-full bg-[var(--primary)] px-2 py-0.5 text-[10px] font-bold text-[var(--primary-fg)]">Active</span>
                      {/if}
                    </div>
                    <p class="truncate text-[11px] text-[var(--text-muted)]" title={runtime.path}>{runtime.path}</p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    {#if !runtime.is_active}
                      <button
                        type="button"
                        class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                        onclick={() => useWhisperRuntime(runtime)}
                      >Use</button>
                    {/if}
                    <button
                      type="button"
                      class="rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                      onclick={() => removeWhisperRuntime(runtime)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Models -->
        {#if voiceCatalogLoading}
          <div class="flex items-center justify-center py-16">
            <div class="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--text-muted)]"></div>
          </div>
        {:else}
          <div class="rounded-xl bg-[var(--surface)] p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--text)]">Models</h3>
            <div class="space-y-3">
              {#each Object.entries(whisperModels) as [key, item] (key)}
                {@const sizeLabel = item.size_mb ? `${item.size_mb} MB` : (item.size_human || item.sizeHuman || '')}
                {@const whisperFiles = Array.isArray(item.files) ? item.files : []}
                {@const activeJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && (j.status === 'starting' || j.status === 'running'))}
                {@const errorJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && j.status === 'error')}
                {@const isDownloading = activeJobs.length > 0 || downloadingWhisper === key}
                {@const hasError = errorJobs.length > 0 && activeJobs.length === 0}

                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-semibold text-[var(--text)]">{item.label || key}</span>
                      {#if item.is_active}
                        <span class="rounded-full bg-[var(--primary)] px-2 py-0.5 text-[10px] font-bold text-primary-fg">Active</span>
                      {/if}
                    </div>
                    <p class="mt-0.5 text-xs text-[var(--text-tertiary)]">{item.description}</p>
                    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-muted)]">
                      {#if sizeLabel}<span>{sizeLabel}</span>{/if}
                      {#if sizeLabel && item.speed}<span>·</span>{/if}
                      {#if item.speed}<span>{item.speed}</span>{/if}
                      {#if item.speed && item.quality}<span>·</span>{/if}
                      {#if item.quality}<span>{item.quality}</span>{/if}
                    </div>
                    {#if isDownloading && activeJobs[0]}
                      <div class="mt-2 flex items-center gap-2">
                        <div class="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--surface-active)]">
                          <div class="h-full rounded-full bg-[var(--primary)] transition-all animate-pulse" style="width: {activeJobs[0].progress}%"></div>
                        </div>
                        <span class="text-[10px] text-[var(--text-muted)]">Downloading {activeJobs.length}/{whisperFiles.length}</span>
                      </div>
                    {/if}
                  </div>

                  <div class="flex shrink-0 items-center gap-2">
                    {#if isDownloading}
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                        onclick={async () => {
                          for (const j of activeJobs) { await cancelDownloadJob(j.id); }
                          downloadingWhisper = null;
                          await downloadsStore.refresh();
                        }}
                      >
                        <Ban class="h-3 w-3" />
                        Cancel
                      </button>
                    {:else if hasError}
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                        onclick={async () => {
                          try {
                            for (const j of errorJobs) { await downloadsStore.removeJob(j.id); }
                            downloadingWhisper = key;
                            const modelsDir = await getModelsDirPath();
                            const dir = item.dir || key;
                            for (const file of whisperFiles) {
                              await startDownloadHf({ repo_id: item.repo_id, file, models_dir: modelsDir, dest_rel: `whisper/${dir}/${file}` });
                            }
                            downloadsStore.startPolling();
                            await downloadsStore.refresh();
                          } catch (err) {
                            toastStore.error(`Retry failed: ${(err as Error)?.message || err}`);
                          } finally { downloadingWhisper = null; }
                        }}
                      >
                        <RotateCcw class="h-3 w-3" />
                        Retry
                      </button>
                    {:else if item.downloaded && !item.is_active}
                      <button
                        type="button"
                        class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                        onclick={async () => {
                          try {
                            await setWhisperQuality(key);
                            await loadVoiceModelCatalog();
                            toastStore.success(`Whisper ${item.label} activated`);
                          } catch (err) {
                            toastStore.error(`Failed to activate: ${(err as Error)?.message || err}`);
                          }
                        }}
                      >
                        Use
                      </button>
                    {:else if item.is_active}
                      <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                        onclick={async () => {
                          try {
                            await unloadWhisper();
                            const current = await loadAppConfig();
                            await saveAppConfig({ ...current, stt: { ...(current.stt || {}), whisper_quality: '' } });
                            await loadVoiceModelCatalog();
                            toastStore.success('Whisper model unloaded');
                          } catch (err) {
                            toastStore.error(`Failed to unload: ${(err as Error)?.message || err}`);
                          }
                        }}
                      >
                        Unload
                      </button>
                    {:else if !item.downloaded}
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                        disabled={downloadingWhisper === key}
                        onclick={async () => {
                          try {
                            downloadingWhisper = key;
                            const modelsDir = await getModelsDirPath();
                            const dir = item.dir || key;
                            for (const file of whisperFiles) {
                              await startDownloadHf({ repo_id: item.repo_id, file, models_dir: modelsDir, dest_rel: `whisper/${dir}/${file}` });
                            }
                            downloadsStore.startPolling();
                            await downloadsStore.refresh();
                            toastStore.success(`Downloading ${item.label || key}…`);
                          } catch (err) {
                            console.error('Whisper download error:', err);
                            toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
                          } finally { downloadingWhisper = null; }
                        }}
                      >
                        <Download class="h-3 w-3" />
                        Download
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
