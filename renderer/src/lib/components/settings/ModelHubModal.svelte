<svelte:options runes={true} />

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import {
    Box, Check, Compass, Download, FolderOpen,
    HardDrive, RefreshCw, RotateCcw, Search, Trash2, X, Zap,
    Server, ChevronRight, Volume2, Mic, Cpu, Settings, Ban, FolderInput, LoaderCircle,
  } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { fetchModelCatalog, hfRepoGguf, searchHfModels } from '$lib/services/search';
  import { startDownloadHf, cancelDownloadJob } from '$lib/services/downloads';
  import { deleteLocalModel, getModelsDirPath, importLocalModel } from '$lib/services/models';
  import { openModelsFolder, getInstalledRuntimes, pathExists, pickModelFile } from '$lib/services/files';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isTauri, invoke } from '$lib/services/tauri';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { unloadTts } from '$lib/services/tts';
  import { deleteWhisperRuntime, listWhisperRuntimes, pickWhisperRuntimeFile, unloadWhisper, type WhisperRuntime } from '$lib/services/stt';
  import { loadAppConfig, saveAppConfig } from '$lib/utils/storage';
  import { resolveModelHubSection } from '$lib/utils/model-hub-routing';
  import VoiceLanguageSelector from './VoiceLanguageSelector.svelte';
  import LocalRuntimePanel from './LocalRuntimePanel.svelte';
  import UnifiedSettingsPanel from './UnifiedSettingsPanel.svelte';

  type NavSection = 'models' | 'explore' | 'general' | 'search' | 'hardware' | 'voices' | 'whisper' | 'runtime' | 'providers';
  let activeSection = $state<NavSection>('models');
  let hasRuntime = $state<boolean | null>(null);

  const modelNavItems = $derived([
    { id: 'models' as NavSection, label: 'Models', description: 'Local library', icon: Box, active: false },
    { id: 'explore' as NavSection, label: 'Explore', description: 'Find downloads', icon: Compass, active: false },
  ]);

  const settingsNavItems = $derived([
    { id: 'general' as NavSection, label: 'General', description: 'Profile and chat behavior', icon: Settings, active: false },
    { id: 'search' as NavSection, label: 'Search', description: 'Web search providers', icon: Search, active: false },
    { id: 'hardware' as NavSection, label: 'Hardware', description: 'System resources', icon: HardDrive, active: false },
    { id: 'providers' as NavSection, label: 'API', description: 'Provider setup', icon: Server, active: Boolean(appStore.activeProvider?.has_api_key) },
    { id: 'runtime' as NavSection, label: 'Runtime', description: 'Local engine', icon: Cpu, active: hasRuntime },
    { id: 'voices' as NavSection, label: 'Voices', description: 'Text to speech', icon: Volume2, active: false },
    { id: 'whisper' as NavSection, label: 'Whisper', description: 'Speech to text', icon: Mic, active: false },
  ]);

  const isModelSection = $derived(activeSection === 'models' || activeSection === 'explore');
  const currentNavItems = $derived(isModelSection ? modelNavItems : settingsNavItems);
  const activeNavItem = $derived([...modelNavItems, ...settingsNavItems].find((item) => item.id === activeSection) || currentNavItems[0]);
  const shellTitle = $derived(isModelSection ? 'Models' : 'Settings');
  const navAriaLabel = $derived(isModelSection ? 'Models sections' : 'Settings sections');

  let searchQuery = $state('');
  let sortBy = $state<'date' | 'downloads' | 'likes'>('likes');
  let unloading = $state(false);

  let exploreQuery = $state('');
  let hfSort = $state('likes');
  let searchResults = $state<any[]>([]);
  let searching = $state(false);
  let showDownloadedOnly = $state(false);
  let showAllLocalModels = $state(false);
  const LOCAL_MODEL_LIMIT = 6;
  let expandedCardIds = $state<Record<string, boolean>>({});
  let repoFilesMap = $state<Record<string, any[]>>({});
  const visibleModels = $derived.by(() => {
    let list = installedModels;
    return showAllLocalModels ? list : list.slice(0, LOCAL_MODEL_LIMIT);
  });

  let voiceModels = $state<Record<string, any>>({});
  let whisperModels = $state<Record<string, any>>({});
  let whisperRuntimes = $state<WhisperRuntime[]>([]);
  let whisperRuntimesLoading = $state(false);
  let voiceCatalogLoading = $state(false);
  let ttsVoice = $state(appStore.config.tts?.voice || '');

  // Provider configuration state
  let providerName = $state(appStore.activeProviderName || 'openai');
  let providerBaseUrl = $state(appStore.activeProvider?.base_url || 'https://api.openai.com/v1');
  let providerApiKey = $state('');
  let providerModel = $state(appStore.activeProvider?.model || '');
  let providerTemperature = $state<number>(Number(appStore.activeProvider?.temperature ?? 0.7));
  let providerTopP = $state<number>(Number(appStore.activeProvider?.top_p ?? 0.95));
  let providerMaxTokens = $state(String(appStore.activeProvider?.max_tokens ?? ''));
  let providerSystemPrompt = $state(appStore.activeProvider?.system_prompt || appStore.config.llm?.system_prompt || '');
  let providerApiModels = $state<string[]>([]);
  let fetchingProviderModels = $state(false);
  let modelSearchQuery = $state('');
  let modelDropdownOpen = $state(false);
  const filteredProviderModels = $derived(
    modelSearchQuery
      ? providerApiModels.filter(m => m.toLowerCase().includes(modelSearchQuery.toLowerCase()))
      : providerApiModels
  );
  let savingProvider = $state(false);
  let testingProviderConnection = $state(false);
  let providerConnectionStatus = $state<'idle' | 'ok' | 'fail'>('idle');

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
        'zf_026', 'zf_027', 'zf_028', 'zf_032', 'zf_036', 'zf_038', 'zf_039',
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

  async function loadVoiceModelCatalog() {
    voiceCatalogLoading = true;
    try {
      const catalog = await fetchModelCatalog() as any;
      const remoteTts = catalog?.tts || {};
      const remoteWhisper = catalog?.whisper || {};
      const modelsDir = isTauri() ? await getModelsDirPath() : '';
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
        if (modelsDir && isTauri()) {
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
        if (modelsDir && isTauri()) {
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

  const downloadedVoiceCount = $derived(Object.values(voiceModels).filter((m: any) => m.downloaded).length);
  const downloadedWhisperCount = $derived(Object.values(whisperModels).filter((m: any) => m.downloaded).length);
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

  const refreshedJobIds = new Set<string>();

  $effect(() => {
    const doneJobs = downloadsStore.jobs.filter((j) => j.status === 'done');
    let needsRefresh = false;
    for (const job of doneJobs) {
      if (!refreshedJobIds.has(job.id)) {
        refreshedJobIds.add(job.id);
        needsRefresh = true;
      }
    }
    if (needsRefresh) {
      void modelsStore.refreshStatus();
      void appStore.refreshModels();
    }
  });

  const installedModels = $derived.by(() => {
    const filter = searchQuery.trim().toLowerCase();
    const items = [...modelsStore.availableModels].map((m) => ({
      ...m,
      details: [m.architecture, m.quantization_name, m.size_label, m.size_gb ? `${Number(m.size_gb).toFixed(1)} GB` : ''].filter(Boolean).join(' · ')
    }));
    const filtered = !filter
      ? items
      : items.filter((m) =>
          `${m.name} ${m.id} ${m.architecture || ''} ${m.quantization_name || ''}`.toLowerCase().includes(filter)
        );
    if (sortBy === 'downloads') return filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (sortBy === 'likes') return filtered.sort((a, b) => Number(b.size_gb || 0) - Number(a.size_gb || 0));
    return filtered.sort((a, b) => Number(b.modified || 0) - Number(a.modified || 0));
  });

  function isLoaded(model: any): boolean {
    if (!appStore.localModelActive) return false;
    const activePath = (appStore.localModelActive.path || '').toLowerCase();
    const activeName = (appStore.localModelActive.name || '').toLowerCase();
    return [model.id, model.name, model.path]
      .filter(Boolean)
      .map((v: string) => String(v).toLowerCase())
      .some((v) => (activePath && (v === activePath || activePath.includes(v) || v.includes(activePath))) || v === activeName || activeName.includes(v) || v.includes(activeName));
  }

  function vramFit(model: { size_gb?: number }): 'vram' | 'partial' | 'ram' | 'unknown' {
    const sizeGb = Number(model.size_gb || 0);
    if (!sizeGb || !hardwareStore.info) return 'unknown';
    return hardwareStore.modelVramFit(sizeGb);
  }

  function toolSupported(model: { chat_template_uses_tools?: boolean }) {
    return model.chat_template_uses_tools === true;
  }

  async function unloadModel() {
    if (unloading) return;
    unloading = true;
    try {
      await appStore.stopLocalModel();
      toastStore.success('Model unloaded successfully');
    } catch (error) {
      console.error('Failed to unload model:', error);
      toastStore.error('Failed to unload model. Please try again.');
    } finally {
      unloading = false;
    }
  }

  async function removeModel(path: string) {
    try {
      await deleteLocalModel(path);
      await Promise.all([modelsStore.refreshIndex(), appStore.refreshModels()]);
      toastStore.success('Model deleted');
    } catch (error) {
      console.error('Failed to delete model:', error);
      toastStore.error('Failed to delete model');
    }
  }

  let importingModel = $state(false);
  async function handleImportLocalModel() {
    if (importingModel) return;
    importingModel = true;
    try {
      const filePath = await pickModelFile();
      if (!filePath) return;
      await importLocalModel(filePath, false);
      await Promise.all([modelsStore.refreshIndex(), appStore.refreshModels()]);
      toastStore.success('Model imported successfully');
    } catch (error) {
      toastStore.error(`Import failed: ${(error as Error)?.message || error}`);
    } finally {
      importingModel = false;
    }
  }

  const CURATED_MODELS: Array<{
    id: string;
    label: string;
    description: string;
    repo_id: string;
    size_label: string;
    architecture: string;
    has_vision: boolean;
    has_tools: boolean;
    variants: Array<{ filename: string; size_human: string; quant: string; recommended?: boolean }>;
    vision_files: Array<{ filename: string; size_human: string; description: string }>;
  }> = [
    {
      id: 'qwen3.5-0.8b',
      label: 'Qwen3.5 0.8B',
      description: 'Ultra-lightweight, fast responses, great for low-RAM devices',
      repo_id: 'unsloth/Qwen3.5-0.8B-GGUF',
      size_label: '0.8B',
      architecture: 'Qwen3',
      has_vision: true,
      has_tools: true,
      variants: [
        { filename: 'Qwen3.5-0.8B-Q4_K_M.gguf', size_human: '~0.6 GB', quant: 'Q4_K_M', recommended: true },
        { filename: 'Qwen3.5-0.8B-Q5_K_M.gguf', size_human: '~0.7 GB', quant: 'Q5_K_M' },
        { filename: 'Qwen3.5-0.8B-Q8_0.gguf', size_human: '~0.9 GB', quant: 'Q8_0' },
        { filename: 'Qwen3.5-0.8B-BF16.gguf', size_human: '~1.6 GB', quant: 'BF16' },
      ],
      vision_files: [
        { filename: 'mmproj-BF16.gguf', size_human: '922 MB', description: 'BF16 vision encoder (best quality)' },
        { filename: 'mmproj-F16.gguf', size_human: '918 MB', description: 'F16 vision encoder' },
        { filename: 'mmproj-F32.gguf', size_human: '~1.8 GB', description: 'F32 vision encoder (highest precision)' },
      ],
    },
    {
      id: 'qwen3.5-2b',
      label: 'Qwen3.5 2B',
      description: 'Balanced model for everyday tasks with vision support',
      repo_id: 'unsloth/Qwen3.5-2B-GGUF',
      size_label: '2B',
      architecture: 'Qwen3',
      has_vision: true,
      has_tools: true,
      variants: [
        { filename: 'Qwen3.5-2B-Q4_K_M.gguf', size_human: '~1.5 GB', quant: 'Q4_K_M', recommended: true },
        { filename: 'Qwen3.5-2B-Q5_K_M.gguf', size_human: '~1.7 GB', quant: 'Q5_K_M' },
        { filename: 'Qwen3.5-2B-Q6_K.gguf', size_human: '~2.0 GB', quant: 'Q6_K' },
        { filename: 'Qwen3.5-2B-Q8_0.gguf', size_human: '~2.5 GB', quant: 'Q8_0' },
        { filename: 'Qwen3.5-2B-BF16.gguf', size_human: '~4.2 GB', quant: 'BF16' },
      ],
      vision_files: [
        { filename: 'mmproj-BF16.gguf', size_human: '922 MB', description: 'BF16 vision encoder (best quality)' },
        { filename: 'mmproj-F16.gguf', size_human: '918 MB', description: 'F16 vision encoder' },
        { filename: 'mmproj-F32.gguf', size_human: '~1.8 GB', description: 'F32 vision encoder' },
      ],
    },
    {
      id: 'qwen3.5-4b',
      label: 'Qwen3.5 4B',
      description: 'Strong reasoning and coding, great mid-range model',
      repo_id: 'unsloth/Qwen3.5-4B-GGUF',
      size_label: '4B',
      architecture: 'Qwen3',
      has_vision: true,
      has_tools: true,
      variants: [
        { filename: 'Qwen3.5-4B-Q4_K_M.gguf', size_human: '~2.8 GB', quant: 'Q4_K_M', recommended: true },
        { filename: 'Qwen3.5-4B-Q5_K_M.gguf', size_human: '~3.3 GB', quant: 'Q5_K_M' },
        { filename: 'Qwen3.5-4B-Q6_K.gguf', size_human: '~3.8 GB', quant: 'Q6_K' },
        { filename: 'Qwen3.5-4B-Q8_0.gguf', size_human: '~4.8 GB', quant: 'Q8_0' },
        { filename: 'Qwen3.5-4B-BF16.gguf', size_human: '~8.6 GB', quant: 'BF16' },
      ],
      vision_files: [
        { filename: 'mmproj-BF16.gguf', size_human: '922 MB', description: 'BF16 vision encoder (best quality)' },
        { filename: 'mmproj-F16.gguf', size_human: '918 MB', description: 'F16 vision encoder' },
        { filename: 'mmproj-F32.gguf', size_human: '~1.8 GB', description: 'F32 vision encoder' },
      ],
    },
    {
      id: 'qwen3.5-9b',
      label: 'Qwen3.5 9B',
      description: 'Top-tier quality for complex reasoning, coding, and analysis',
      repo_id: 'unsloth/Qwen3.5-9B-GGUF',
      size_label: '9B',
      architecture: 'Qwen3',
      has_vision: true,
      has_tools: true,
      variants: [
        { filename: 'Qwen3.5-9B-Q4_K_M.gguf', size_human: '5.68 GB', quant: 'Q4_K_M', recommended: true },
        { filename: 'Qwen3.5-9B-Q4_K_S.gguf', size_human: '5.39 GB', quant: 'Q4_K_S' },
        { filename: 'Qwen3.5-9B-Q5_K_M.gguf', size_human: '6.58 GB', quant: 'Q5_K_M' },
        { filename: 'Qwen3.5-9B-Q5_K_S.gguf', size_human: '6.36 GB', quant: 'Q5_K_S' },
        { filename: 'Qwen3.5-9B-Q6_K.gguf', size_human: '7.46 GB', quant: 'Q6_K' },
        { filename: 'Qwen3.5-9B-Q8_0.gguf', size_human: '9.53 GB', quant: 'Q8_0' },
        { filename: 'Qwen3.5-9B-BF16.gguf', size_human: '17.9 GB', quant: 'BF16' },
      ],
      vision_files: [
        { filename: 'mmproj-BF16.gguf', size_human: '922 MB', description: 'BF16 vision encoder (best quality)' },
        { filename: 'mmproj-F16.gguf', size_human: '918 MB', description: 'F16 vision encoder' },
        { filename: 'mmproj-F32.gguf', size_human: '~1.8 GB', description: 'F32 vision encoder' },
      ],
    },
  ];

  let selectedCurated = $state<typeof CURATED_MODELS[0] | null>(null);
  let selectedVariant = $state<string>('');
  let selectedVisionFile = $state<string>('');
  let downloadingCuratedMain = $state(false);
  let downloadingCuratedVision = $state(false);

  async function performSearch() {
    exploreQuery = searchQuery.trim();
    searching = true;
    try { searchResults = await searchHfModels(exploreQuery, hfSort, 24) as any[]; }
    catch { searchResults = []; }
    finally { searching = false; }
  }

  let busyId = $state<string | null>(null);
  let downloadingVoice = $state<string | null>(null);
  let downloadingWhisper = $state<string | null>(null);

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
    if (activeSection === 'whisper' && audioInputDevices.length === 0 && micPermission !== 'denied') {
      void loadAudioInputDevices();
    }
  });

  async function downloadRepoFile(repoId: string, file: string) {
    if (!isTauri()) return;
    busyId = `${repoId}/${file}`;
    try {
      const modelsDir = await getModelsDirPath();
      await startDownloadHf({ repo_id: repoId, file, models_dir: modelsDir, dest_rel: `${repoId.replace('/', '_')}/${file}` });
      downloadsStore.startPolling();
      await downloadsStore.refresh();
    } catch (err) {
      console.error('Download failed:', err);
      toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
    } finally { busyId = null; }
  }

  async function downloadCuratedModel() {
    if (!selectedCurated || !selectedVariant) return;
    downloadingCuratedMain = true;
    try {
      const modelsDir = await getModelsDirPath();
      await startDownloadHf({
        repo_id: selectedCurated.repo_id,
        file: selectedVariant,
        models_dir: modelsDir,
        dest_rel: `${selectedCurated.repo_id.replace('/', '_')}/${selectedVariant}`,
      });
      downloadsStore.startPolling();
      await downloadsStore.refresh();
      toastStore.success(`Downloading ${selectedVariant}…`);
    } catch (err) {
      toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
    } finally { downloadingCuratedMain = false; }
  }

  async function downloadCuratedVision() {
    if (!selectedCurated || !selectedVisionFile) return;
    downloadingCuratedVision = true;
    try {
      const modelsDir = await getModelsDirPath();
      await startDownloadHf({
        repo_id: selectedCurated.repo_id,
        file: selectedVisionFile,
        models_dir: modelsDir,
        dest_rel: `${selectedCurated.repo_id.replace('/', '_')}/${selectedVisionFile}`,
      });
      downloadsStore.startPolling();
      await downloadsStore.refresh();
      toastStore.success(`Downloading vision model ${selectedVisionFile}…`);
    } catch (err) {
      toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
    } finally { downloadingCuratedVision = false; }
  }

  function findDownloadedModel(filename: string) {
    return modelsStore.availableModels.find((m) => m.path?.endsWith(filename) || m.name === filename);
  }

  function repoIdFor(item: any): string {
    return String(item?.repo_id || item?.id || item?.modelId || '').trim();
  }

  function modelTitleFor(item: any, kind: 'curated' | 'hf'): string {
    const repoId = repoIdFor(item);
    if (kind === 'curated') return repoId.split('/').pop() || item?.label || 'Model';
    return item?.label || repoId.split('/').pop() || repoId || 'Model';
  }

  function authorFor(item: any): string {
    return item?.author || repoIdFor(item).split('/')[0] || 'Hugging Face';
  }

  function formatCompactCount(value: unknown): string {
    const count = Number(value || 0);
    if (!Number.isFinite(count) || count <= 0) return '';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
    return String(count);
  }

  function fileNameFor(file: any): string {
    return String(file?.filename || file?.name || file?.rfilename || '').trim();
  }

  function fileListFromPayload(payload: any): any[] {
    if (Array.isArray(payload?.gguf_files)) return payload.gguf_files;
    if (Array.isArray(payload?.files)) return payload.files;
    return [];
  }

  function isDownloadDone(job: any): boolean {
    return job?.status === 'done' || job?.status === 'completed';
  }

  function isDownloadActive(job: any): boolean {
    return job?.status === 'starting' || job?.status === 'running';
  }

  async function loadRepoFiles(repoId: string): Promise<any[]> {
    if (!repoId) return [];
    if (repoFilesMap[repoId]) return repoFilesMap[repoId];
    const payload = await hfRepoGguf(repoId) as any;
    const files = fileListFromPayload(payload);
    repoFilesMap = { ...repoFilesMap, [repoId]: files };
    return files;
  }

  async function toggleModelVariants(item: any, kind: 'curated' | 'hf', id: string) {
    const expanded = !!expandedCardIds[id];
    if (!expanded && kind === 'hf') await loadRepoFiles(repoIdFor(item));
    expandedCardIds = { ...expandedCardIds, [id]: !expanded };
  }

  async function downloadFirstRepoFile(repoId: string) {
    const files = await loadRepoFiles(repoId);
    const file = fileNameFor(files[0]);
    if (!file) {
      toastStore.error('No GGUF files found for this Hugging Face repo.');
      return;
    }
    await downloadRepoFile(repoId, file);
  }

  async function downloadCuratedVariant(item: typeof CURATED_MODELS[0], filename: string) {
    selectedCurated = item;
    selectedVariant = filename;
    await downloadCuratedModel();
  }

  function recommendedFileFor(item: typeof CURATED_MODELS[0]): string {
    return item.variants.find((variant) => variant.recommended)?.filename || item.variants[0]?.filename || '';
  }

  async function downloadCuratedVisionFile(item: typeof CURATED_MODELS[0], filename: string) {
    selectedCurated = item;
    selectedVisionFile = filename;
    await downloadCuratedVision();
  }

  function formatBytes(bytes: number) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

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

  function close() {
    appStore.modelManagerOpen = false;
  }

  function resolveSection(section: string): NavSection {
    return resolveModelHubSection(section) as NavSection;
  }

  onMount(() => {
    downloadsStore.startPolling();
    void performSearch();
    void getInstalledRuntimes().then(r => { hasRuntime = (r.runtimes?.length ?? 0) > 0; }).catch(() => {});
    const preselect = appStore.modelManagerOpenModelId;
    if (preselect) {
      appStore.modelManagerOpenModelId = null;
      const model = CURATED_MODELS.find(m => m.id === preselect);
      if (model) {
        activeSection = 'models';
        selectedCurated = model;
        selectedVariant = model.variants.find(v => v.recommended)?.filename || model.variants[0]?.filename || '';
        selectedVisionFile = model.vision_files[0]?.filename || '';
        expandedCardIds = { [model.id]: true };
      }
    }
    const openSection = appStore.modelManagerOpenSection;
    if (openSection) {
      appStore.modelManagerOpenSection = null;
      activeSection = resolveSection(openSection);
    }
  });

  $effect(() => {
    const openSection = appStore.modelManagerOpenSection;
    if (!openSection) return;
    appStore.modelManagerOpenSection = null;
    activeSection = resolveSection(openSection);
  });

  $effect(() => {
    if ((activeSection === 'voices' || activeSection === 'whisper') && Object.keys(voiceModels).length === 0) {
      void loadVoiceModelCatalog();
    }
  });

  $effect(() => {
    if (activeSection === 'whisper' && !whisperRuntimesLoading && whisperRuntimes.length === 0) {
      void loadWhisperRuntimeList();
    }
  });

  // ── Provider configuration helpers ──
  const PROVIDER_URLS: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    anthropic: 'https://api.anthropic.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    gemini: 'https://generativelanguage.googleapis.com',
    mistral: 'https://api.mistral.ai/v1',
    together: 'https://api.together.xyz/v1',
    deepseek: 'https://api.deepseek.com/v1',
    cohere: 'https://api.cohere.ai/v1',
    perplexity: 'https://api.perplexity.ai',
    lmstudio: 'http://localhost:1234/v1',
    ollama: 'http://localhost:11434/v1',
  };

  $effect(() => {
    if (activeSection !== 'providers') return;
    if (untrack(() => savingProvider)) return;
    const saved = appStore.config.llm?.providers?.[providerName];
    if (saved?.base_url) {
      providerBaseUrl = saved.base_url;
    } else if (providerName in PROVIDER_URLS) {
      providerBaseUrl = PROVIDER_URLS[providerName];
    }
    // The config from the main process is redacted: api_key is stripped and
    // has_api_key is set instead.  When has_api_key is true we must NOT clear
    // the local field — show a placeholder so the user knows a key exists.
    if (saved?.api_key) {
      providerApiKey = saved.api_key;
    } else if (saved?.has_api_key) {
      providerApiKey = providerApiKey || '••••••••';
    } else {
      providerApiKey = '';
    }
    providerModel = saved?.model || '';
    providerTemperature = Number(saved?.temperature ?? 0.7);
    providerTopP = Number(saved?.top_p ?? 0.95);
    providerMaxTokens = String(saved?.max_tokens || '');
    // Reset model search state when provider changes
    providerApiModels = [];
    modelSearchQuery = '';
    modelDropdownOpen = false;
  });

  async function fetchProviderModels() {
    fetchingProviderModels = true;
    providerApiModels = [];
    try {
      const keyToSend = (providerApiKey && providerApiKey !== '••••••••') ? String(providerApiKey) : undefined;
      const models = await invoke<string[]>('fetch_provider_models', { baseUrl: providerBaseUrl, apiKey: keyToSend, providerName });
      providerApiModels = models ?? [];
      if (!providerApiModels.length) toastStore.info('No models returned from provider.');
    } catch (err) {
      toastStore.error('Could not fetch models: ' + ((err as Error)?.message || String(err)));
    } finally {
      fetchingProviderModels = false;
    }
  }

  async function testProviderConnection() {
    testingProviderConnection = true;
    providerConnectionStatus = 'idle';
    try {
      const keyToSend = (providerApiKey && providerApiKey !== '••••••••') ? String(providerApiKey) : undefined;
      await invoke('fetch_provider_models', { baseUrl: providerBaseUrl, apiKey: keyToSend, providerName });
      providerConnectionStatus = 'ok';
      toastStore.success('Connected successfully');
    } catch (err) {
      providerConnectionStatus = 'fail';
      toastStore.error('Connection failed: ' + ((err as Error)?.message || String(err)));
    } finally {
      testingProviderConnection = false;
    }
  }

  async function saveProviderConfig() {
    // Capture form values BEFORE any operations that might trigger reactive effects.
    // The $effect that syncs from appStore.config will reset providerApiKey to the
    // saved value (empty string if no key exists) when setBackendMode changes config.
    const capturedKey = providerApiKey;
    const capturedProvider = providerName;
    const capturedBaseUrl = providerBaseUrl;
    const capturedModel = providerModel;
    const capturedTemperature = providerTemperature;
    const capturedMaxTokens = providerMaxTokens;
    const capturedTopP = providerTopP;
    const capturedSystemPrompt = providerSystemPrompt;

    savingProvider = true;
    try {
      await appStore.setBackendMode('api');
      await appStore.updateProvider({
        provider: capturedProvider,
        base_url: capturedBaseUrl,
        api_key: (capturedKey && capturedKey !== '••••••••') ? capturedKey : undefined,
        model: capturedModel,
        temperature: capturedTemperature,
        max_tokens: capturedMaxTokens ? parseInt(capturedMaxTokens) : undefined,
        top_p: capturedTopP,
        system_prompt: capturedSystemPrompt || undefined,
      });
      toastStore.success('Provider configuration saved');
    } catch (err) {
      toastStore.error('Failed to save: ' + ((err as Error)?.message || String(err)));
    } finally {
      savingProvider = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div
  role="presentation"
  class="aui-modal-backdrop z-[63] overflow-hidden"
  transition:motionFade={{ duration: 200 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-manager-title"
    tabindex="-1"
    class="aui-modal-surface mx-2 my-2 h-[min(820px,calc(100vh-4rem))] w-[min(1180px,calc(100%-2rem))] max-w-none"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <!-- Top bar -->
    <div class="aui-modal-header !py-2">
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="aui-icon-button size-8"
          onclick={() => { close(); appStore.downloadsOpen = true; }}
          title="Downloads"
        >
          <Download class="size-3.5" />
        </button>
        {#if isModelSection}
          <button
            type="button"
            class="aui-icon-button size-8"
            onclick={() => openModelsFolder()}
            title="Open folder"
          >
            <FolderOpen class="size-3.5" />
          </button>
          <button
            type="button"
            disabled={importingModel}
            class="aui-icon-button size-8 disabled:opacity-50"
            onclick={() => { void handleImportLocalModel(); }}
            title="Import model"
          >
            {#if importingModel}
              <LoaderCircle class="size-3.5 animate-spin" />
            {:else}
              <FolderInput class="size-3.5" />
            {/if}
          </button>
        {/if}
      </div>

      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="aui-icon-button size-8 hover:text-[var(--error)]"
          onclick={close}
          aria-label="Close"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
      {#if !isModelSection}
      <aside class="flex shrink-0 flex-col gap-3 border-b border-border/60 p-3 sm:border-b-0 sm:border-r sm:border-border/60 {isModelSection ? 'sm:w-60 bg-muted/30' : 'sm:w-52 bg-background'}">
        <nav class="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible" aria-label={navAriaLabel}>
          {#each currentNavItems as item}
            <button
              type="button"
              class={`flex items-center gap-2 rounded-md px-2.5 transition sm:min-w-0 border-0 shadow-none
                ${isModelSection ? 'min-w-40 py-2 text-sm font-medium' : 'py-1.5 text-[13px] font-medium'}
                ${activeSection === item.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              onclick={() => (activeSection = item.id)}
            >
              {#if isModelSection}
                <item.icon class="h-4 w-4 shrink-0 text-current" />
              {/if}
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5 truncate">
                  <span class="truncate">{item.label}</span>
                  {#if item.active}
                    <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]"></span>
                  {/if}
                </span>
              </span>
            </button>
          {/each}
        </nav>
      </aside>
      {/if}

      <main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
        {#snippet installedCard(model: any)}
          {@const loaded = isLoaded(model)}
          {@const selected = appStore.selectedLocalModelPath === model.path}
          {@const fit = vramFit(model)}
          {@const tools = toolSupported(model)}
          {@const title = model.name}
          {@const size = model.size_gb ? `${Number(model.size_gb).toFixed(1)} GB` : ''}
          {@const memoryWarning = fit === 'partial'}
          {@const params = model.size_label || ''}
          {@const context = model.context_length ? `${Math.round(model.context_length / 1024)}K` : ''}
          <article class="group aui-card-quiet px-4 py-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h3 class="truncate text-[15px] font-semibold leading-5 text-[var(--text)]" title={title}>{title}</h3>
                <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                  <span>Local</span>
                    {#if params}<span class="inline-flex items-center gap-1 text-[var(--text-muted)]"><Cpu class="h-3 w-3" /> {params} params</span>{/if}
                    {#if context}<span class="inline-flex items-center gap-1 text-[var(--text-muted)]"><Zap class="h-3 w-3" /> {context} context</span>{/if}
                    {#if size}<span class="inline-flex items-center gap-1 text-[var(--text-muted)]"><HardDrive class="h-3 w-3" /> {size}</span>{/if}
                  </p>
                </div>
                {#if memoryWarning}
                  <span class="shrink-0 rounded-md border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--warning)]">Not enough memory</span>
                {:else if loaded}
                  <span class="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--success)]/30 bg-[var(--success-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--success)]"><span class="h-1.5 w-1.5 rounded-full bg-[var(--success)] animate-pulse"></span> Running</span>
                {/if}
              </div>
            <div class="mt-3 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                {#if model.architecture}<span class="rounded-md border border-orange-500/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-400">{model.architecture}</span>{/if}
                {#if model.quantization_name}<span class="rounded-md border border-orange-500/50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-400">{model.quantization_name}</span>{/if}
                {#if model.hasMmproj}<span class="rounded-md border border-orange-500/50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-400">Vision</span>{/if}
                {#if tools}<span class="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">Tools</span>{/if}
                {#if fit === 'vram'}<span class="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">GPU</span>{:else if fit === 'ram'}<span class="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">CPU</span>{/if}
              </div>
              <div class="flex shrink-0 items-center gap-2">
                {#if size}<span class="text-xs text-[var(--text-muted)]">{size}</span>{/if}
                {#if loaded}
                  <button type="button" class="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition hover:bg-[var(--surface-hover)] disabled:opacity-50" onclick={unloadModel} disabled={unloading}>{unloading ? 'Unloading…' : 'Unload'}</button>
                {:else}
                  <button type="button" class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" onclick={() => appStore.openLocalModelLoadDialog(model)}>Load</button>
                {/if}
                {#if !selected && !loaded}
                  <button type="button" class="rounded-full px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => appStore.updateLocalModel({ id: model.id, name: model.name, path: model.path, source: 'local', details: model.details })}>Select</button>
                {/if}
                <button type="button" class="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]" onclick={() => model.path && removeModel(model.path)} title="Delete model" aria-label="Delete {model.name}"><Trash2 class="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </article>
        {/snippet}

        {#snippet exploreCard(item: any, kind: any)}
          {@const repoId = repoIdFor(item)}
          {@const id = kind === 'curated' ? item.id : repoId}
          {@const title = modelTitleFor(item, kind)}
          {@const author = authorFor(item)}
          {@const size = kind === 'curated' ? (item.variants.find((v: any) => v.recommended)?.size_human || item.variants[0]?.size_human || '?') : (item.largest_gguf_human || '')}
          {@const expanded = !!expandedCardIds[id]}
          {@const isVision = item.has_vision || /vision|vl|mmproj/i.test(repoId)}
          {@const files = kind === 'hf' ? (repoFilesMap[repoId] || item.gguf_files || item.files || []) : []}
          {@const downloads = formatCompactCount(item.downloads)}
          {@const likes = formatCompactCount(item.likes)}
          <article class="group aui-card-quiet px-4 py-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="truncate text-[15px] font-semibold leading-5 text-[var(--text)]" title={title}>{title}</h3>
                <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                  <span>By {author}</span>
                    {#if downloads}<span class="inline-flex items-center gap-1 text-[var(--text-muted)]"><Download class="h-3 w-3" /> {downloads}</span>{/if}
                    {#if likes}<span class="text-[var(--text-muted)]">{likes} likes</span>{/if}
                    {#if item.size_label}<span class="text-[var(--text-muted)]">{item.size_label} params</span>{/if}
                    {#if item.context_length}<span class="text-[var(--text-muted)]">{Math.round(item.context_length / 1024)}K context</span>{/if}
                    {#if kind === 'hf' && item.gguf_files_count}<span class="text-[var(--text-muted)]">{item.gguf_files_count} variants</span>{/if}
                  </p>
                </div>

                {#if kind === 'curated'}
                  <span class="shrink-0 rounded-md border border-[var(--success)]/30 bg-[var(--success-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--success)]">Recommended</span>
                {/if}
              </div>

            <div class="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="rounded-md border border-orange-500/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-400">GGUF</span>
                {#if isVision}<span class="rounded-md border border-orange-500/50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-400">Vision</span>{/if}
                {#if item.has_tools}<span class="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">Tools</span>{/if}
              </div>

              <div class="flex shrink-0 items-center gap-3">
                <button type="button" class="inline-flex items-center gap-1 text-xs font-semibold text-[var(--text)] transition hover:text-[var(--primary)]" onclick={() => toggleModelVariants(item, kind, id)}>
                  {expanded ? 'Hide variants' : 'Show variants'}
                  <ChevronRight class="h-3.5 w-3.5 transition {expanded ? 'rotate-90' : ''}" />
                </button>
                {#if size}<span class="text-xs text-[var(--text-muted)]">{size}</span>{/if}
                {#if kind === 'curated'}
                  <button type="button" class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={downloadingCuratedMain || !recommendedFileFor(item)} onclick={() => downloadCuratedVariant(item, recommendedFileFor(item))}>Download</button>
                {:else}
                  <button type="button" class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={!repoId || busyId?.startsWith(repoId)} onclick={() => downloadFirstRepoFile(repoId)}>Download</button>
                {/if}
              </div>
            </div>

            {#if expanded}
              <div class="mt-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]">
                {#if kind === 'curated'}
                  {#each item.variants as v, index (v.filename)}
                    {@const job = downloadsStore.jobFor(item.repo_id, v.filename)}
                    {@const downloaded = findDownloadedModel(v.filename)}
                    <div class="flex items-center justify-between gap-3 px-3 py-2 {index > 0 ? 'border-t border-[var(--border)]' : ''}">
                      <div class="min-w-0 flex items-center gap-2">
                        <span class="w-14 shrink-0 text-xs font-semibold text-[var(--text)]">{v.quant}</span>
                        <span class="truncate text-xs text-[var(--text-muted)]">{v.filename}</span>
                        {#if v.recommended}<span class="rounded-md bg-[var(--success-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--success)]">Recommended</span>{/if}
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
                        <span class="text-xs text-[var(--text-muted)]">{v.size_human}</span>
                        {#if downloaded || isDownloadDone(job)}
                          <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={!downloaded} onclick={() => downloaded && appStore.openLocalModelLoadDialog(downloaded)}>Load</button>
                        {:else if isDownloadActive(job)}
                          <span class="text-[10px] text-[var(--text-muted)]">Downloading…</span>
                        {:else if job && (job.status === 'error' || job.status === 'cancelled')}
                          <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)]" onclick={() => downloadsStore.retryJob(job.id)}>Retry</button>
                        {:else}
                          <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={downloadingCuratedMain} onclick={() => downloadCuratedVariant(item, v.filename)}>Download</button>
                        {/if}
                      </div>
                    </div>
                  {/each}

                  {#if item.vision_files?.length}
                    {#each item.vision_files as vf (vf.filename)}
                      {@const vjob = downloadsStore.jobFor(item.repo_id, vf.filename)}
                      {@const vdownloaded = findDownloadedModel(vf.filename)}
                      <div class="flex items-center justify-between gap-3 border-t border-[var(--border)] px-3 py-2">
                        <div class="min-w-0">
                          <p class="truncate text-xs font-medium text-[var(--text)]">{vf.filename}</p>
                          <p class="truncate text-[11px] text-[var(--text-muted)]">{vf.description}</p>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                          <span class="text-xs text-[var(--text-muted)]">{vf.size_human}</span>
                          {#if vdownloaded || isDownloadDone(vjob)}
                            <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={!vdownloaded} onclick={() => vdownloaded && appStore.openLocalModelLoadDialog(vdownloaded)}>Load</button>
                          {:else if isDownloadActive(vjob)}
                            <span class="text-[10px] text-[var(--text-muted)]">Downloading…</span>
                          {:else}
                            <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={downloadingCuratedVision} onclick={() => downloadCuratedVisionFile(item, vf.filename)}>Download</button>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  {/if}
                {:else if kind === 'hf'}
                  {#if files.length === 0}
                    <div class="px-3 py-3 text-xs text-[var(--text-muted)]">No GGUF variants found for this repo.</div>
                  {:else}
                    {#each files as file, index (fileNameFor(file))}
                      {@const filename = fileNameFor(file)}
                      {@const job = downloadsStore.jobFor(repoId, filename)}
                      {@const downloaded = findDownloadedModel(filename)}
                      <div class="flex items-center justify-between gap-3 px-3 py-2 {index > 0 ? 'border-t border-[var(--border)]' : ''}">
                        <span class="min-w-0 truncate text-xs font-medium text-[var(--text)]">{filename}</span>
                        <div class="flex shrink-0 items-center gap-2">
                          <span class="min-w-16 text-right text-xs text-[var(--text-muted)]">{file.size_human || 'Size unavailable'}</span>
                          {#if downloaded || isDownloadDone(job)}
                            <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={!downloaded} onclick={() => downloaded && appStore.openLocalModelLoadDialog(downloaded)}>Load</button>
                          {:else if isDownloadActive(job)}
                            <div class="flex items-center gap-2">
                              <div class="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--surface-active)]"><div class="h-full rounded-full bg-[var(--primary)] transition-all" style="width: {job?.progress ?? 0}%"></div></div>
                              <button type="button" class="rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={async () => { if (job) { await cancelDownloadJob(job.id); await downloadsStore.refresh(); } }} aria-label="Cancel download"><Ban class="h-3.5 w-3.5" /></button>
                            </div>
                          {:else if job && (job.status === 'error' || job.status === 'cancelled')}
                            <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)]" onclick={() => downloadsStore.retryJob(job.id)}>Retry</button>
                          {:else}
                            <button type="button" class="rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={busyId === `${repoId}/${filename}`} onclick={() => downloadRepoFile(repoId, filename)}>Download</button>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  {/if}
                {/if}
              </div>
            {/if}
          </article>
        {/snippet}
        {#if activeSection === 'models' || activeSection === 'explore'}
          <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--background)] px-5">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <Search class="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <input
                bind:value={searchQuery}
                type="text"
                class="h-10 min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
                placeholder="Search for models on Hugging Face..."
                onkeydown={(e) => { if (e.key === 'Enter') void performSearch(); }}
                autocomplete="off"
                spellcheck="false"
              />
              {#if searchQuery}
                <button type="button" class="rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => { searchQuery = ''; void performSearch(); }} aria-label="Clear search">
                  <X class="h-3.5 w-3.5" />
                </button>
              {/if}
            </div>

            <select
              value={sortBy}
              onchange={(e) => { sortBy = (e.currentTarget as HTMLSelectElement).value as typeof sortBy; hfSort = sortBy === 'date' ? 'lastModified' : sortBy; void performSearch(); }}
              class="h-9 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] outline-none transition hover:bg-[var(--surface-hover)]"
              aria-label="Sort models"
            >
              <option value="likes">Most liked</option>
              <option value="downloads">Downloads</option>
              <option value="date">Newest</option>
            </select>

            <label class="relative inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
              <input type="checkbox" bind:checked={showDownloadedOnly} class="peer sr-only" />
              <span class="h-4 w-7 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)]"></span>
              <span class="absolute left-0.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--text-muted)] transition peer-checked:translate-x-3.5 peer-checked:bg-[var(--primary-fg)]"></span>
              Downloaded
            </label>
          </header>

          <div class="flex-1 overflow-y-auto bg-[var(--background)]">
            <div class="mx-auto max-w-[928px] px-4 py-6 sm:px-5">
              {#if showDownloadedOnly}
                <section>
                  <h3 class="mb-3 text-sm font-semibold text-[var(--text-secondary)]">Downloaded</h3>
                  {#if visibleModels.length === 0}
                    <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
                      <p class="text-sm font-semibold text-[var(--text)]">No downloaded models</p>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">Turn off Downloaded to browse Hugging Face models.</p>
                    </div>
                  {:else}
                    <div class="space-y-2">
                      {#each visibleModels as model (model.id)}
                        {@render installedCard(model)}
                      {/each}
                    </div>
                    {#if !showAllLocalModels && installedModels.length > LOCAL_MODEL_LIMIT}
                      <button type="button" class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2 text-xs font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => (showAllLocalModels = true)}>
                        View all {installedModels.length} models
                      </button>
                    {/if}
                  {/if}
                </section>
              {:else}
                {#if visibleModels.length > 0}
                  <section>
                    <h3 class="mb-3 text-sm font-semibold text-[var(--text-secondary)]">Downloaded</h3>
                    <div class="space-y-2">
                      {#each visibleModels as model (model.id)}
                        {@render installedCard(model)}
                      {/each}
                    </div>
                    {#if !showAllLocalModels && installedModels.length > LOCAL_MODEL_LIMIT}
                      <button type="button" class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2 text-xs font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => (showAllLocalModels = true)}>
                        View all {installedModels.length} models
                      </button>
                    {/if}
                  </section>
                {/if}

                {#if searchQuery.trim().length === 0 && CURATED_MODELS.length > 0}
                  <section class={visibleModels.length > 0 ? 'mt-5 border-t border-[var(--border)] pt-5' : ''}>
                    <h3 class="mb-3 text-sm font-semibold text-[var(--text-secondary)]">Recommended</h3>
                    <div class="space-y-2">
                      {#each CURATED_MODELS as model (model.id)}
                        {@render exploreCard(model, 'curated')}
                      {/each}
                    </div>
                  </section>
                {/if}

                <section class="mt-5 border-t border-[var(--border)] pt-5">
                  <h3 class="mb-3 text-sm font-semibold text-[var(--text-secondary)]">{exploreQuery ? `Results for "${exploreQuery}"` : 'All Models'}</h3>
                  {#if searching}
                    <div class="flex items-center justify-center py-16">
                      <LoaderCircle class="h-5 w-5 animate-spin text-[var(--text-muted)]" />
                    </div>
                  {:else if searchResults.length > 0}
                    <div class="space-y-2">
                      {#each searchResults as result (result.repo_id || result.id || result.modelId)}
                        {@render exploreCard(result, 'hf')}
                      {/each}
                    </div>
                  {:else}
                    <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
                      <p class="text-sm font-semibold text-[var(--text)]">No models found</p>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">Try another Hugging Face search.</p>
                    </div>
                  {/if}
                </section>
              {/if}
            </div>
          </div>

        {:else if activeSection === 'voices'}
          <div class="flex-1 overflow-y-auto p-5 space-y-4">
            <header>
              <h2 class="text-base font-semibold text-[var(--text)]">Voice</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Local text-to-speech for reading responses aloud</p>
            </header>

            {#if voiceCatalogLoading}
              <div class="flex items-center justify-center py-16">
                <div class="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--text-muted)]"></div>
              </div>
            {:else if !primaryVoiceEntry}
              <div class="rounded-lg bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
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

              <div class="rounded-lg bg-[var(--surface)] p-4 space-y-3">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-semibold text-[var(--text)]">{item.label || 'Kokoro Voice'}</h3>
                    <p class="mt-0.5 text-xs text-[var(--text-tertiary)]">Kokoro{item.size_mb ? ` · ${item.size_mb} MB` : ''}</p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    {#if isDownloading}
                      <button type="button" class="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => cancelVoiceDownloads(item)}>
                        <Ban class="inline h-3 w-3" />
                        Cancel
                      </button>
                    {:else if hasError}
                      <button type="button" class="inline-flex items-center gap-1 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90" onclick={() => downloadVoiceModel(key, item, true)}>
                        <RotateCcw class="h-3 w-3" />
                        Retry
                      </button>
                    {:else if item.downloaded && !item.is_active}
                      <button type="button" class="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90" onclick={() => activateVoiceModel(key, item)}>
                        Use
                      </button>
                    {:else if item.is_active}
                      <button type="button" class="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => unloadTts()}>
                        Unload
                      </button>
                    {:else}
                      <button type="button" class="inline-flex items-center gap-1 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50" disabled={downloadingVoice === key} onclick={() => downloadVoiceModel(key, item)}>
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
                  <div class="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs text-[var(--text-secondary)]">
                    <span class="inline-flex items-center gap-1.5">
                      <Check class="h-3.5 w-3.5" />
                      Download complete
                    </span>
                    <button type="button" class="rounded-md px-2 py-1 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={() => loadVoiceModelCatalog()}>
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
          </div>

        {:else if activeSection === 'whisper'}
          <div class="flex-1 overflow-y-auto p-5 space-y-4">
            <header>
              <h2 class="text-base font-semibold text-[var(--text)]">Whisper Speech-to-Text</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Models for transcribing audio input</p>
            </header>

            <!-- Microphone -->
            <div class="rounded-lg bg-[var(--surface)] p-4 space-y-3">
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
                  <select
                    id="mic-select"
                    class="mic-select w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] transition focus:border-[var(--border-hover)] focus:outline-none"
                    value={selectedMicId}
                    onchange={(e) => void saveMicDevice((e.currentTarget as HTMLSelectElement).value)}
                  >
                    <option value="">System default</option>
                    {#each audioInputDevices as device}
                      <option value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 8)}`}</option>
                    {/each}
                  </select>
                  {#if selectedMicId && selectedMicId !== ''}
                    <p class="text-[11px] text-[var(--text-muted)]">
                      Selected device will be used for speech recognition in this session.
                    </p>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- whisper.cpp runtime -->
            <div class="rounded-lg bg-[var(--surface)] p-4 space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold text-[var(--text)]">whisper.cpp runtime</h3>
                  <p class="mt-0.5 text-xs text-[var(--text-muted)]">Auto-detects CUDA, Vulkan, or CPU from installed runtimes.</p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    onclick={loadWhisperRuntimeList}
                  >
                    <RefreshCw class="inline h-3 w-3" />
                    Refresh
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
                            class="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                            onclick={() => useWhisperRuntime(runtime)}
                          >Use</button>
                        {/if}
                        <button
                          type="button"
                          class="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
              <div class="rounded-lg bg-[var(--surface)] p-4 space-y-3">
                <h3 class="text-sm font-semibold text-[var(--text)]">Models</h3>
                <div class="space-y-3">
                  {#each Object.entries(whisperModels) as [key, item] (key)}
                    {@const sizeLabel = item.size_mb ? `${item.size_mb} MB` : (item.size_human || item.sizeHuman || '')}
                    {@const whisperFiles = Array.isArray(item.files) ? item.files : []}
                    {@const activeJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && (j.status === 'starting' || j.status === 'running'))}
                    {@const errorJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && j.status === 'error')}
                    {@const isDownloading = activeJobs.length > 0 || downloadingWhisper === key}
                    {@const hasError = errorJobs.length > 0 && activeJobs.length === 0}
                    {@const doneJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && j.status === 'done')}

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
                            <span class="text-[10px] text-[var(--text-muted)]">Downloading {doneJobs.length + activeJobs.length}/{whisperFiles.length}</span>
                          </div>
                        {/if}
                      </div>

                      <div class="flex shrink-0 items-center gap-2">
                        {#if isDownloading}
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
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
                            class="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
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
                            class="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
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
          </div>

        {:else if activeSection === 'general'}
          <UnifiedSettingsPanel activeTab="General" />
        {:else if activeSection === 'search'}
          <UnifiedSettingsPanel activeTab="Search" />
        {:else if activeSection === 'hardware'}
          <UnifiedSettingsPanel activeTab="Hardware" />
        {:else if activeSection === 'runtime'}
          <LocalRuntimePanel />
        {:else if activeSection === 'providers'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold text-[var(--text)]">API Providers</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Configure cloud or self-hosted LLM providers</p>
            </header>

            {#if appStore.backendMode !== 'api'}
              <div class="mb-4 rounded-md border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                You are currently in <strong>Local</strong> mode. Saving a provider here will switch to <strong>Cloud</strong> mode.
              </div>
            {/if}

            <div class="space-y-5">
              <!-- Provider selector -->
              <label class="block space-y-1.5 text-sm">
                <span class="font-medium text-[var(--text-secondary)]">Provider</span>
                <select class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]" bind:value={providerName}>
                  <optgroup label="Cloud">
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter (multi-provider)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="groq">Groq</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="mistral">Mistral AI</option>
                    <option value="together">Together AI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="cohere">Cohere</option>
                    <option value="perplexity">Perplexity</option>
                  </optgroup>
                  <optgroup label="Local / Self-hosted">
                    <option value="lmstudio">LM Studio</option>
                    <option value="ollama">Ollama</option>
                    <option value="custom">Custom / Other</option>
                  </optgroup>
                </select>
              </label>

              <!-- Base URL -->
              <label class="block space-y-1.5 text-sm">
                <span class="font-medium text-[var(--text-secondary)]">Base URL</span>
                <input class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]" bind:value={providerBaseUrl} placeholder="https://api.openai.com/v1" />
              </label>

              <!-- API Key -->
              <div class="space-y-1.5 text-sm">
                <div class="flex items-center justify-between">
                  <span class="font-medium text-[var(--text-secondary)]">API Key</span>
                  {#if appStore.config.llm?.providers?.[providerName]?.has_api_key}
                    <span class="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]">
                      <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span> Saved
                    </span>
                  {/if}
                </div>
                <input
                  class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
                  bind:value={providerApiKey}
                  placeholder={appStore.config.llm?.providers?.[providerName]?.has_api_key ? '••••••••• (leave blank to keep)' : 'Enter API key…'}
                  type="password"
                  onfocus={() => { if (providerApiKey === '••••••••') providerApiKey = ''; }}
                />
              </div>

              <!-- Model with fetch button -->
              <div class="space-y-1.5 text-sm">
                <span class="font-medium text-[var(--text-secondary)]">Model</span>
                <div class="flex gap-2">
                  {#if providerApiModels.length}
                    <!-- Searchable model selector -->
                    <div class="relative flex-1">
                      <input
                        class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
                        value={modelDropdownOpen ? modelSearchQuery : (providerModel || '')}
                        placeholder="Search models…"
                        onfocus={() => { modelDropdownOpen = true; modelSearchQuery = ''; }}
                        onblur={() => { modelDropdownOpen = false; }}
                        oninput={(e) => { modelSearchQuery = e.currentTarget.value; modelDropdownOpen = true; }}
                        onkeydown={(e) => {
                          if (e.key === 'Escape') { modelDropdownOpen = false; e.currentTarget.blur(); }
                          if (e.key === 'Enter' && filteredProviderModels.length > 0) {
                            providerModel = filteredProviderModels[0];
                            modelDropdownOpen = false;
                            modelSearchQuery = '';
                            e.currentTarget.blur();
                          }
                        }}
                      />
                      {#if modelDropdownOpen}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg"
                          onmousedown={(e) => e.preventDefault()}>
                          {#if filteredProviderModels.length === 0}
                            <div class="px-4 py-3 text-xs text-[var(--text-muted)]">No models match "{modelSearchQuery}"</div>
                          {:else}
                            {#each filteredProviderModels as m (m)}
                              <button
                                type="button"
                                class="flex w-full items-center px-4 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] {m === providerModel ? 'text-[var(--primary)] font-medium' : 'text-[var(--text)]'}"
                                onclick={() => {
                                  providerModel = m;
                                  modelDropdownOpen = false;
                                  modelSearchQuery = '';
                                }}
                              >
                                {m}
                              </button>
                            {/each}
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {:else}
                    <input class="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]" bind:value={providerModel} placeholder="No model" />
                  {/if}
                  <button
                    class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                    onclick={fetchProviderModels}
                    disabled={fetchingProviderModels}
                    title="Fetch available models from provider"
                  >
                    {#if fetchingProviderModels}
                      <LoaderCircle class="h-4 w-4 animate-spin" />
                    {:else}
                      <RefreshCw class="h-3.5 w-3.5" />
                    {/if}
                    Fetch
                  </button>
                </div>
              </div>

              <!-- System Prompt -->
              <label class="block space-y-1.5 text-sm">
                <span class="font-medium text-[var(--text-secondary)]">System prompt</span>
                <textarea
                  class="h-20 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
                  bind:value={providerSystemPrompt}
                  placeholder="You are a helpful assistant…"
                ></textarea>
              </label>

              <!-- Generation params -->
              <div class="space-y-4 text-sm">
                <div class="space-y-1.5">
                  <div class="flex items-center justify-between">
                    <span class="font-medium text-[var(--text-secondary)]">Temperature</span>
                    <span class="tabular-nums text-xs font-semibold text-[var(--text-muted)] w-8 text-right">{providerTemperature.toFixed(2)}</span>
                  </div>
                  <input type="range" min="0" max="2" step="0.05" bind:value={providerTemperature}
                    class="w-full h-1.5 rounded-full cursor-pointer accent-[var(--primary)]" />
                  <div class="flex justify-between text-[10px] text-[var(--text-muted)]">
                    <span>Precise</span><span>Creative</span>
                  </div>
                </div>
                <div class="space-y-1.5">
                  <div class="flex items-center justify-between">
                    <span class="font-medium text-[var(--text-secondary)]">Top-P</span>
                    <span class="tabular-nums text-xs font-semibold text-[var(--text-muted)] w-8 text-right">{providerTopP.toFixed(2)}</span>
                  </div>
                  <input type="range" min="0" max="1" step="0.05" bind:value={providerTopP}
                    class="w-full h-1.5 rounded-full cursor-pointer accent-[var(--primary)]" />
                </div>
                <label class="block space-y-1.5">
                  <span class="font-medium text-[var(--text-secondary)]">Max tokens</span>
                  <input
                    class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
                    bind:value={providerMaxTokens}
                    inputmode="numeric"
                    placeholder="2048 (leave blank for provider default)"
                  />
                </label>
              </div>

              <!-- Actions -->
              <div class="flex items-center gap-3 pt-2 border-t border-[var(--border)]">
                <button
                  class="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                  onclick={saveProviderConfig}
                  disabled={savingProvider}
                >
                  {savingProvider ? 'Saving…' : 'Save Provider'}
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                  onclick={testProviderConnection}
                  disabled={testingProviderConnection}
                >
                  {#if testingProviderConnection}
                    <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                    Testing…
                  {:else}
                    Test connection
                  {/if}
                </button>
                {#if providerConnectionStatus !== 'idle'}
                  <span class={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${providerConnectionStatus === 'ok' ? 'bg-[var(--surface-hover)] text-[var(--text)]' : 'bg-[var(--surface-hover)] text-[var(--text)]'}`}>
                    {providerConnectionStatus === 'ok' ? '● Connected' : '● Failed'}
                  </span>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </main>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-surface {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-xl);
  }

  .mic-select option {
    background: var(--surface);
    color: var(--text);
  }

  .modal-surface :global(button) {
    position: relative;
    overflow: hidden;
  }

  .modal-surface :global(article.scroll-animate) {
    overflow: hidden;
    border-radius: var(--radius-lg) !important;
    background: var(--surface) !important;
    box-shadow: none;
  }

</style>
