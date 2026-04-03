<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import {
    AlertTriangle, Box, Check, Compass, Download, Eye, FolderOpen,
    HardDrive, Key, MemoryStick, Play, RefreshCw, RotateCcw, Search, Square, Trash2, Wrench, X, Zap,
    Server, ChevronRight, Volume2, Mic, Cpu, Settings, ExternalLink, Ban, Activity, Puzzle, FolderInput, LoaderCircle
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
  import { unloadWhisper } from '$lib/services/stt';
  import { loadAppConfig, saveAppConfig } from '$lib/utils/storage';
  import SearchBar from './SearchBar.svelte';
  import SearchSettings from './SearchSettings.svelte';

  type NavSection = 'models' | 'explore' | 'voices' | 'whisper' | 'runtime' | 'search' | 'extensions' | 'providers';
  let activeSection = $state<NavSection>('models');

  let modelSearch = $state('');
  let sortBy = $state<'date' | 'name' | 'size'>('date');
  let unloading = $state(false);
  let hasRuntime = $state<boolean | null>(null);

  let exploreQuery = $state('');
  let hfSort = $state('trending');
  let searchResults = $state<any[]>([]);
  let searching = $state(false);
  let selectedRepo = $state<any | null>(null);
  let repoFiles = $state<any[]>([]);
  let recommended = $state<any[]>([]);
  let recommendedLoading = $state(false);
  let hfToken = $state('');
  let showTokenInput = $state(false);
  let exploreSubTab = $state<'search' | 'recommended'>('recommended');

  let voiceModels = $state<Record<string, any>>({});
  let whisperModels = $state<Record<string, any>>({});
  let voiceCatalogLoading = $state(false);
  let ttsVoice = $state(appStore.config.tts?.voice || '');

  // Search settings state
  let searchProvider = $state(appStore.config.search?.provider || 'auto');
  let searchMaxResults = $state(String(appStore.config.search?.max_results ?? 6));
  let searchApiKey = $state('');
  let searchEngineId = $state(appStore.config.search?.providers?.google_cse?.engine_id || '');
  let searchBaseUrl = $state(appStore.config.search?.providers?.searxng?.base_url || '');
  let searchModel = $state(appStore.config.search?.providers?.perplexity?.model || 'sonar');
  let savingSearch = $state(false);

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
    kitten_nano_v02: {
      label: 'Kitten Nano EN v0.2', description: 'Fast, lightweight English TTS',
      repo: 'csukuangfj/kitten-nano-en-v0_2-fp16', branch: 'main',
      dir: 'kitten-nano-en-v0_2-fp16', engine: 'kitten', size_mb: 23,
      files: ['model.fp16.onnx', 'voices.bin', 'tokens.txt'],
      voices: ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'],
    },
    kitten_nano_v01: {
      label: 'Kitten Nano EN v0.1', description: 'Lightweight English TTS',
      repo: 'csukuangfj/kitten-nano-en-v0_1-fp16', branch: 'main',
      dir: 'kitten-nano-en-v0_1-fp16', engine: 'kitten', size_mb: 23,
      files: ['model.fp16.onnx', 'voices.bin', 'tokens.txt'],
      voices: ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'],
    },
    kitten_mini_v01: {
      label: 'Kitten Mini EN v0.1', description: 'Higher quality English TTS',
      repo: 'csukuangfj/kitten-mini-en-v0_1-fp16', branch: 'main',
      dir: 'kitten-mini-en-v0_1-fp16', engine: 'kitten', size_mb: 158,
      files: ['model.fp16.onnx', 'voices.bin', 'tokens.txt'],
      voices: ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'],
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
    kokoro_v11: {
      label: 'Kokoro v1.1 Chinese + English', description: '103 voices, Chinese + English, improved quality',
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
  };

  const VOICE_WHISPER_FALLBACK_CATALOG: Record<string, any> = {
    tiny: {
      label: 'Tiny', description: 'Fastest, basic quality',
      repo: 'csukuangfj/sherpa-onnx-whisper-tiny.en',
      dir: 'sherpa-onnx-whisper-tiny.en',
      files: ['tiny.en-encoder.int8.onnx', 'tiny.en-decoder.int8.onnx', 'tiny.en-tokens.txt'],
      size_mb: 98, speed: 'Fastest', quality: 'Basic',
    },
    base: {
      label: 'Base', description: 'Fast with good accuracy',
      repo: 'csukuangfj/sherpa-onnx-whisper-base.en',
      dir: 'sherpa-onnx-whisper-base.en',
      files: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'],
      size_mb: 153, speed: 'Fast', quality: 'Good',
    },
    small: {
      label: 'Small', description: 'Balanced speed and quality',
      repo: 'csukuangfj/sherpa-onnx-whisper-small.en',
      dir: 'sherpa-onnx-whisper-small.en',
      files: ['small.en-encoder.int8.onnx', 'small.en-decoder.int8.onnx', 'small.en-tokens.txt'],
      size_mb: 400, speed: 'Medium', quality: 'Better',
    },
    medium: {
      label: 'Medium', description: 'Best quality, slower',
      repo: 'csukuangfj/sherpa-onnx-whisper-medium.en',
      dir: 'sherpa-onnx-whisper-medium.en',
      files: ['medium.en-encoder.int8.onnx', 'medium.en-decoder.int8.onnx', 'medium.en-tokens.txt'],
      size_mb: 770, speed: 'Slower', quality: 'Best',
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
      const rawTts = { ...VOICE_TTS_FALLBACK_CATALOG, ...remoteTts };
      for (const [key, fallback] of Object.entries(rawTts)) {
        const meta: any = { ...(fallback as object), ...((remoteTts[key] || {}) as object) };
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
      const rawWhisper = { ...VOICE_WHISPER_FALLBACK_CATALOG, ...remoteWhisper };
      for (const [key, fallback] of Object.entries(rawWhisper)) {
        const meta: any = { ...(fallback as object), ...((remoteWhisper[key] || {}) as object) };
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

  const downloadedVoiceCount = $derived(Object.values(voiceModels).filter((m: any) => m.downloaded).length);
  const downloadedWhisperCount = $derived(Object.values(whisperModels).filter((m: any) => m.downloaded).length);

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
      void modelsStore.refresh();
      void appStore.refreshModels();
    }
  });

  const installedModels = $derived.by(() => {
    const filter = modelSearch.trim().toLowerCase();
    const items = [...modelsStore.availableModels].map((m) => ({
      ...m,
      details: [m.architecture, m.quantization_name, m.size_label, m.size_gb ? `${Number(m.size_gb).toFixed(1)} GB` : ''].filter(Boolean).join(' · ')
    }));
    const filtered = !filter
      ? items
      : items.filter((m) =>
          `${m.name} ${m.id} ${m.architecture || ''} ${m.quantization_name || ''}`.toLowerCase().includes(filter)
        );
    if (sortBy === 'name') return filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (sortBy === 'size') return filtered.sort((a, b) => Number(b.size_gb || 0) - Number(a.size_gb || 0));
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
      await Promise.all([modelsStore.refresh(), appStore.refreshModels()]);
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
      await Promise.all([modelsStore.refresh(), appStore.refreshModels()]);
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

  async function loadRecommended() {
    recommendedLoading = true;
    try {
      const catalog = await fetchModelCatalog() as Record<string, any>;
      const llmEntries = Object.entries(catalog?.llm || {}).map(([id, v]) => ({ id, ...(v as Record<string, unknown>) }));
      if (llmEntries.length > 0) { recommended = llmEntries.slice(0, 16); return; }
      const hf = await searchHfModels('', 'trending', 20) as any[];
      recommended = (Array.isArray(hf) ? hf : []).map((r: any) => ({
        id: r.repo_id, label: r.repo_id?.split('/').pop() || r.repo_id, repo_id: r.repo_id,
        description: `${r.gguf_files_count ?? 0} GGUF variants`,
        downloads: r.downloads,
        likes: r.likes,
        largest_gguf_human: r.largest_gguf_human,
        gguf_files_count: r.gguf_files_count,
      }));
    } catch { recommended = []; }
    finally { recommendedLoading = false; }
  }

  async function performSearch() {
    if (!exploreQuery.trim()) return;
    searching = true; selectedRepo = null; repoFiles = [];
    try { searchResults = await searchHfModels(exploreQuery, hfSort, 24) as any[]; }
    catch { searchResults = []; }
    finally { searching = false; }
  }

  async function openRepo(repoId: string) {
    selectedRepo = searchResults.find((e) => e.repo_id === repoId) || { repo_id: repoId };
    const payload = await hfRepoGguf(repoId) as any;
    repoFiles = Array.isArray(payload?.gguf_files) ? payload.gguf_files : [];
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
      await startDownloadHf({ repo_id: repoId, file, models_dir: modelsDir, dest_rel: `${repoId.replace('/', '_')}/${file}`, hf_token: hfToken.trim() || undefined });
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
        hf_token: hfToken.trim() || undefined,
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
        hf_token: hfToken.trim() || undefined,
      });
      downloadsStore.startPolling();
      await downloadsStore.refresh();
      toastStore.success(`Downloading vision model ${selectedVisionFile}…`);
    } catch (err) {
      toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
    } finally { downloadingCuratedVision = false; }
  }

  async function openRecommendedRepo(item: any) {
    const repoId = item.repo_id || item.repo || item.id || '';
    activeSection = 'explore';
    exploreSubTab = 'search';
    exploreQuery = repoId;
    selectedRepo = { repo_id: repoId };
    repoFiles = [];
    searching = true;
    try {
      const payload = await hfRepoGguf(repoId) as any;
      repoFiles = Array.isArray(payload?.gguf_files) ? payload.gguf_files : [];
    } finally { searching = false; }
  }

  function findDownloadedModel(filename: string) {
    return modelsStore.availableModels.find((m) => m.path?.endsWith(filename) || m.name === filename);
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

  onMount(() => {
    downloadsStore.startPolling();
    void loadRecommended();
    void getInstalledRuntimes().then(r => { hasRuntime = (r.runtimes?.length ?? 0) > 0; }).catch(() => {});
    const preselect = appStore.modelManagerOpenModelId;
    if (preselect) {
      appStore.modelManagerOpenModelId = null;
      const model = CURATED_MODELS.find(m => m.id === preselect);
      if (model) {
        activeSection = 'explore';
        exploreSubTab = 'recommended';
        selectedCurated = model;
        selectedVariant = model.variants.find(v => v.recommended)?.filename || model.variants[0]?.filename || '';
        selectedVisionFile = model.vision_files[0]?.filename || '';
      }
    }
    const openSection = appStore.modelManagerOpenSection;
    if (openSection) {
      appStore.modelManagerOpenSection = null;
      activeSection = openSection as NavSection;
    }
  });

  $effect(() => {
    if ((activeSection === 'voices' || activeSection === 'whisper') && Object.keys(voiceModels).length === 0) {
      void loadVoiceModelCatalog();
    }
  });

  async function saveSearchSettings() {
    savingSearch = true;
    try {
      const providerSettings: Record<string, Record<string, string>> = {};
      if (searchApiKey) {
        if (searchProvider === 'google_cse') providerSettings.google_cse = { api_key: searchApiKey, engine_id: searchEngineId };
        else if (searchProvider === 'brave') providerSettings.brave = { api_key: searchApiKey };
        else if (searchProvider === 'serpapi') providerSettings.serpapi = { api_key: searchApiKey };
        else if (searchProvider === 'serper') providerSettings.serper = { api_key: searchApiKey };
        else if (searchProvider === 'tavily') providerSettings.tavily = { api_key: searchApiKey };
        else if (searchProvider === 'exa') providerSettings.exa = { api_key: searchApiKey };
        else if (searchProvider === 'jina') providerSettings.jina = { api_key: searchApiKey };
        else if (searchProvider === 'bing') providerSettings.bing = { api_key: searchApiKey, endpoint: searchBaseUrl || 'https://api.bing.microsoft.com/v7.0/search' };
        else if (searchProvider === 'perplexity') providerSettings.perplexity = { api_key: searchApiKey, model: searchModel };
        else if (searchProvider === 'youcom') providerSettings.youcom = { api_key: searchApiKey };
      }
      if (searchProvider === 'searxng' && searchBaseUrl) {
        providerSettings.searxng = { base_url: searchBaseUrl };
      }
      await appStore.updateSearchSettings({
        provider: searchProvider,
        max_results: searchMaxResults ? Number(searchMaxResults) : undefined,
        providers: providerSettings as any
      });
      toastStore.success('Search settings saved');
    } catch (e) {
      toastStore.error('Failed to save search settings');
    }
    savingSearch = false;
  }

  // ── Provider configuration helpers ──
  const PROVIDER_URLS: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    anthropic: 'https://api.anthropic.com/v1',
    groq: 'https://api.groq.com/openai/v1',
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
    // Do NOT reset form fields while a save is in progress — setBackendMode
    // triggers a config change which would wipe the user's unsaved key entry.
    if (savingProvider) return;
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
      const keyToSend = (providerApiKey && providerApiKey !== '••••••••') ? providerApiKey : undefined;
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
      const keyToSend = (providerApiKey && providerApiKey !== '••••••••') ? providerApiKey : undefined;
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
  class="modal-backdrop fixed inset-0 z-[63] flex items-center justify-center overflow-hidden bg-black/50"
  transition:fade={{ duration: 200 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="model-hub-title"
    tabindex="-1"
    class="modal-surface relative mx-4 flex max-h-[calc(100vh-4rem)] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <aside class="flex w-56 shrink-0 flex-col border-r border-[var(--border)]">
        <header class="flex h-14 items-center justify-between px-4 border-b border-[var(--border)]">
          <h1 id="model-hub-title" class="text-sm font-semibold text-[var(--text)]">Model Hub</h1>
          <button
            type="button"
            class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-white/5 dark:hover:text-neutral-300"
            onclick={close}
            aria-label="Close model hub"
          >
            <X class="h-4 w-4" />
          </button>
        </header>

        <nav class="flex-1 overflow-y-auto px-2 py-2 space-y-0.5" aria-label="Model hub navigation">
          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'models' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'models')}
            aria-current={activeSection === 'models' ? 'page' : undefined}
          >
            <HardDrive class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">My Models</span>
            {#if installedModels.length > 0}
              <span class="text-xs text-[var(--text-muted)] tabular-nums">{installedModels.length}</span>
            {/if}
          </button>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'providers' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'providers')}
            aria-current={activeSection === 'providers' ? 'page' : undefined}
          >
            <Key class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">API Providers</span>
            {#if appStore.activeProvider?.has_api_key}
              <span class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              </span>
            {/if}
          </button>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'explore' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'explore')}
            aria-current={activeSection === 'explore' ? 'page' : undefined}
          >
            <Compass class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Explore</span>
          </button>

          <div class="my-2 border-t border-[var(--border)]"></div>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'voices' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'voices')}
            aria-current={activeSection === 'voices' ? 'page' : undefined}
          >
            <Volume2 class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Voices</span>
            {#if downloadedVoiceCount > 0}
              <span class="text-xs text-[var(--text-muted)] tabular-nums">{downloadedVoiceCount}</span>
            {/if}
          </button>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'whisper' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'whisper')}
            aria-current={activeSection === 'whisper' ? 'page' : undefined}
          >
            <Mic class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Whisper</span>
            {#if downloadedWhisperCount > 0}
              <span class="text-xs text-[var(--text-muted)] tabular-nums">{downloadedWhisperCount}</span>
            {/if}
          </button>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'search' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'search')}
            aria-current={activeSection === 'search' ? 'page' : undefined}
          >
            <Search class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Search</span>
          </button>

          <div class="my-2 border-t border-[var(--border)]"></div>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white"
            onclick={() => { close(); appStore.downloadsOpen = true; }}
          >
            <Download class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Downloads</span>
            {#if downloadsStore.activeCount > 0}
              <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-hornero-500 px-1.5 text-[10px] font-semibold text-white">{downloadsStore.activeCount}</span>
            {:else if downloadsStore.jobs.length > 0}
              <span class="text-xs text-[var(--text-muted)] tabular-nums">{downloadsStore.jobs.length}</span>
            {/if}
          </button>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'runtime' ? 'bg-neutral-100 dark:bg-white/[0.06] text-[var(--text)]' : 'text-neutral-600 dark:text-neutral-400 hover:bg-[var(--surface-highlight)] hover:text-neutral-900 dark:hover:text-white'}"
            onclick={() => (activeSection = 'runtime')}
            aria-current={activeSection === 'runtime' ? 'page' : undefined}
          >
            <Server class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Runtime</span>
            {#if hasRuntime === true}
              <span class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              </span>
            {:else if hasRuntime === false}
              <span class="text-xs text-amber-500">Required</span>
            {/if}
          </button>

          <button
            type="button"
            class="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition {activeSection === 'extensions' ? 'bg-[var(--surface-highlight)] text-[var(--text)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]'}"
            onclick={() => (activeSection = 'extensions')}
            aria-current={activeSection === 'extensions' ? 'page' : undefined}
          >
            <Puzzle class="h-4 w-4 shrink-0 opacity-70" />
            <span class="flex-1 text-sm font-medium">Extensions</span>
            <span class="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
              style="background:color-mix(in srgb,var(--work-accent) 15%,transparent);color:var(--work-accent)">Soon</span>
          </button>
        </nav>

        <footer class="border-t border-[var(--border)] px-2 py-2 space-y-0.5">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)]"
            onclick={() => openModelsFolder()}
          >
            <FolderOpen class="h-3.5 w-3.5 shrink-0" />
            <span>Open models folder</span>
          </button>
          <button
            type="button"
            disabled={importingModel}
            class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
            onclick={() => { void handleImportLocalModel(); }}
          >
            {#if importingModel}
              <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin" />
            {:else}
              <FolderInput class="h-3.5 w-3.5 shrink-0" />
            {/if}
            <span>Import local GGUF…</span>
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)]"
            onclick={() => { void modelsStore.refresh(); void appStore.refreshModels(); }}
          >
            <RefreshCw class="h-3.5 w-3.5 shrink-0" />
            <span>Refresh</span>
          </button>
        </footer>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
        {#if activeSection === 'models'}
          <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-5">
            <div class="flex-1 max-w-md">
              <SearchBar bind:value={modelSearch} placeholder="Filter models..." />
            </div>
            <div class="flex items-center gap-1 rounded-lg bg-[var(--surface-highlight)] p-0.5">
              {#each (['date', 'name', 'size'] as const) as opt}
                <button
                  type="button"
                  class="rounded-md px-2.5 py-1 text-xs font-medium transition {sortBy === opt ? 'bg-white dark:bg-white/10 text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-neutral-700 dark:hover:text-neutral-200'}"
                  onclick={() => (sortBy = opt)}
                >
                  {opt === 'date' ? 'Recent' : opt === 'name' ? 'Name' : 'Size'}
                </button>
              {/each}
            </div>
          </header>

          {#if hasRuntime === false}
            <div class="mx-5 mt-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10" transition:fly={{ y: -10, duration: 200 }}>
              <AlertTriangle class="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p class="flex-1 text-sm text-amber-700 dark:text-amber-300">No runtime installed — models cannot be loaded.</p>
              <button
                type="button"
                class="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
                onclick={() => (activeSection = 'runtime')}
              >
                Install
              </button>
            </div>
          {/if}

          <!-- Active model status banner -->
          {#if appStore.localModelActive}
            {@const isLoading = appStore.localModelLoading}
            <div class="mx-5 mt-4 flex items-center gap-3 rounded-xl border px-4 py-3 {!isLoading ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/20 dark:bg-emerald-500/10' : 'border-amber-200 bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/10'}" transition:fly={{ y: -10, duration: 200 }}>
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg {!isLoading ? 'bg-emerald-500/20' : 'bg-amber-500/20'}">
                {#if isLoading}
                  <Activity class="h-4 w-4 text-amber-600 dark:text-amber-400 animate-pulse" />
                {:else}
                  <Activity class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                {/if}
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium {!isLoading ? 'text-emerald-800 dark:text-emerald-200' : 'text-amber-800 dark:text-amber-200'}">
                  {isLoading ? 'Loading model…' : 'Model running'}
                </p>
                <p class="truncate text-xs {!isLoading ? 'text-emerald-600/80 dark:text-emerald-400/70' : 'text-amber-600/80 dark:text-amber-400/70'}">
                  {appStore.localModelActive.name}
                  {#if appStore.localModelActive.hasMmproj}
                    {' '}· Vision
                  {/if}
                </p>
              </div>
              <button
                type="button"
                class="shrink-0 inline-flex items-center gap-1.5 rounded-lg border {!isLoading ? 'border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10' : 'border-[var(--border)] text-[var(--text-tertiary)]'} bg-white dark:bg-white/10 px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50"
                onclick={unloadModel}
                disabled={unloading || isLoading}
              >
                <Square class="h-3 w-3" />
                {unloading ? 'Unloading…' : 'Unload'}
              </button>
            </div>
          {/if}

          <div class="flex-1 overflow-y-auto p-5">
            {#if installedModels.length === 0}
              <div class="flex flex-col items-center justify-center py-20 text-center">
                <div class="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--surface-highlight)]">
                  <Box class="h-8 w-8 text-neutral-300 dark:text-neutral-600" />
                </div>
                <p class="text-base font-medium text-[var(--text-secondary)]">No local models</p>
                <p class="mt-1 text-sm text-[var(--text-muted)]">Browse Explore to download models</p>
                <button
                  type="button"
                  class="mt-5 inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-[var(--primary-fg)] transition hover:opacity-90"
                  onclick={() => (activeSection = 'explore')}
                >
                  <Compass class="h-4 w-4" />
                  Explore Models
                </button>
              </div>
            {:else}
              <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {#each installedModels as model (model.id)}
                  {@const loaded = isLoaded(model)}
                  {@const selected = appStore.selectedLocalModelPath === model.path}
                  {@const fit = vramFit(model)}
                  {@const tools = toolSupported(model)}
                  <article
                    class="group relative flex h-[180px] flex-col rounded-xl border bg-white p-4 transition-all duration-200 hover:shadow-lg dark:bg-[#161616] {loaded
                      ? 'border-emerald-200 dark:border-emerald-800/40 ring-1 ring-emerald-100 dark:ring-emerald-900/20'
                      : selected
                        ? 'border-neutral-300 dark:border-neutral-600 ring-1 ring-neutral-100 dark:ring-neutral-800'
                        : 'border-[var(--border)] hover:border-neutral-200 dark:hover:border-white/10'}"
                  >
                    <!-- Top: icon + name + badges -->
                    <div class="flex items-start gap-3 min-h-0">
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-highlight)] transition group-hover:bg-neutral-200 dark:group-hover:bg-white/[0.06]">
                        <Cpu class="h-5 w-5 text-[var(--text-muted)]" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <h3 class="text-sm font-semibold text-[var(--text)] truncate" title={model.name}>{model.name}</h3>
                        <div class="mt-1 flex flex-wrap items-center gap-1">
                          {#if loaded}
                            <span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                              <span class="h-1 w-1 rounded-full bg-emerald-500 animate-pulse"></span>
                              Running
                            </span>
                          {/if}
                          {#if selected && !loaded}
                            <span class="rounded-full bg-neutral-200 dark:bg-white/10 px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">Selected</span>
                          {/if}
                          {#if tools}
                            <span class="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">Tools</span>
                          {/if}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="rounded-lg p-1.5 text-neutral-300 dark:text-neutral-600 transition hover:bg-red-50 dark:hover:bg-red-900/10 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        onclick={() => model.path && removeModel(model.path)}
                        title="Delete model"
                        aria-label="Delete {model.name}"
                      >
                        <Trash2 class="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <!-- Middle: metadata badges -->
                    <div class="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
                      {#if model.architecture}
                        <span class="rounded bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{model.architecture}</span>
                      {/if}
                      {#if model.quantization_name}
                        <span class="rounded bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-tertiary)]">{model.quantization_name}</span>
                      {/if}
                      {#if model.size_gb}
                        <span class="rounded bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">{Number(model.size_gb).toFixed(1)} GB</span>
                      {/if}
                      {#if model.context_length}
                        <span class="rounded bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">{Math.round(model.context_length / 1024)}K</span>
                      {/if}
                      {#if fit === 'vram'}
                        <span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          <Zap class="h-2.5 w-2.5" />GPU
                        </span>
                      {:else if fit === 'partial'}
                        <span class="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          <AlertTriangle class="h-2.5 w-2.5" />Partial
                        </span>
                      {:else if fit === 'ram'}
                        <span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500 dark:text-red-400">
                          <MemoryStick class="h-2.5 w-2.5" />CPU
                        </span>
                      {/if}
                    </div>

                    <!-- Bottom: actions -->
                    <div class="mt-2 flex items-center gap-2">
                      {#if loaded}
                        <button
                          type="button"
                          class="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:border-red-200 hover:bg-red-50 dark:hover:border-red-800/40 dark:hover:bg-red-900/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                          onclick={unloadModel}
                          disabled={unloading}
                        >
                          <Square class="h-3.5 w-3.5" />
                          <span>{unloading ? 'Unloading...' : 'Unload'}</span>
                        </button>
                      {:else}
                        <button
                          type="button"
                          class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] py-2 text-xs font-medium text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                          onclick={() => appStore.openLocalModelLoadDialog(model)}
                        >
                          <Play class="h-3.5 w-3.5" />
                          <span>Load</span>
                        </button>
                      {/if}
                      {#if !selected && !loaded}
                        <button
                          type="button"
                          class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
                          onclick={() => appStore.updateLocalModel({ id: model.id, name: model.name, path: model.path, source: 'local', details: model.details })}
                        >
                          Select
                        </button>
                      {/if}
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </div>

        {:else if activeSection === 'explore'}
          <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-5">
            <div class="flex items-center rounded-lg bg-[var(--surface-highlight)] p-0.5">
              <button
                type="button"
                class="rounded-md px-3 py-1.5 text-xs font-medium transition {exploreSubTab === 'recommended' ? 'bg-white dark:bg-white/10 text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-neutral-700 dark:hover:text-neutral-200'}"
                onclick={() => (exploreSubTab = 'recommended')}
              >
                Recommended
              </button>
              <button
                type="button"
                class="rounded-md px-3 py-1.5 text-xs font-medium transition {exploreSubTab === 'search' ? 'bg-white dark:bg-white/10 text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-neutral-700 dark:hover:text-neutral-200'}"
                onclick={() => (exploreSubTab = 'search')}
              >
                Search
              </button>
            </div>

            {#if exploreSubTab === 'search'}
              <div class="flex-1 max-w-md">
                <SearchBar bind:value={exploreQuery} placeholder="Search Hugging Face..." />
              </div>
              <select bind:value={hfSort} class="rounded-lg border border-[var(--border)] bg-white dark:bg-white/[0.04] px-3 py-1.5 text-xs text-[var(--text-secondary)] outline-none">
                <option value="trending">Trending</option>
                <option value="downloads">Downloads</option>
                <option value="likes">Likes</option>
              </select>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition hover:opacity-90"
                onclick={performSearch}
              >
                <Search class="h-3.5 w-3.5" />
                Search
              </button>
              {#if !showTokenInput}
                <button
                  type="button"
                  class="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  onclick={() => (showTokenInput = true)}
                >
                  Token
                </button>
              {:else}
                <div class="flex items-center gap-1.5">
                  <Key class="h-3 w-3 text-neutral-400" />
                  <input
                    type="password"
                    bind:value={hfToken}
                    placeholder="hf_..."
                    class="w-28 rounded-lg border border-[var(--border)] bg-white dark:bg-white/[0.04] px-2 py-1 text-xs outline-none dark:text-white"
                  />
                  <button type="button" class="text-xs text-neutral-400 hover:text-red-500" onclick={() => { showTokenInput = false; hfToken = ''; }}>
                    <X class="h-3 w-3" />
                  </button>
                </div>
              {/if}
            {/if}
          </header>

          <div class="flex min-h-0 flex-1 overflow-hidden">
            {#if exploreSubTab === 'recommended'}
              <div class="flex min-h-0 flex-1 overflow-hidden">
                <!-- Left: model list -->
                <div class="w-72 shrink-0 overflow-y-auto border-r border-[var(--border)] p-3 flex flex-col gap-1.5">
                  <p class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Recommended Models</p>
                  {#each CURATED_MODELS as model (model.id)}
                    <button
                      type="button"
                      class="group flex w-full flex-col gap-1 rounded-xl border px-3 py-3 text-left transition {selectedCurated?.id === model.id ? 'border-[var(--border-strong)] bg-[var(--surface-highlight)]' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-highlight)]'}"
                      onclick={() => {
                        selectedCurated = model;
                        selectedVariant = model.variants.find(v => v.recommended)?.filename || model.variants[0]?.filename || '';
                        selectedVisionFile = model.vision_files[0]?.filename || '';
                      }}
                    >
                      <div class="flex items-center justify-between">
                        <span class="text-sm font-semibold text-[var(--text)]">{model.label}</span>
                        <span class="rounded-full bg-[var(--surface-highlight)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">{model.size_label}</span>
                      </div>
                      <p class="text-[11px] text-[var(--text-muted)] leading-relaxed">{model.description}</p>
                      <div class="mt-1 flex flex-wrap gap-1">
                        {#if model.has_vision}
                          <span class="rounded-full border border-[var(--border)] bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"><Eye class="inline h-3 w-3" /> Vision</span>
                        {/if}
                        {#if model.has_tools}
                          <span class="rounded-full border border-[var(--border)] bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]"><Wrench class="inline h-3 w-3" /> Tools</span>
                        {/if}
                      </div>
                    </button>
                  {/each}
                </div>

                <!-- Right: variant + vision selector -->
                <div class="flex-1 overflow-y-auto p-5">
                  {#if !selectedCurated}
                    <div class="flex h-full flex-col items-center justify-center text-center">
                      <Compass class="mb-3 h-10 w-10 text-[var(--text-muted)]" />
                      <p class="text-sm text-[var(--text-tertiary)]">Select a model</p>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">Choose from the recommended models on the left</p>
                    </div>
                  {:else}
                    <div class="space-y-6">
                      <!-- Header -->
                      <div>
                        <h2 class="text-base font-semibold text-[var(--text)]">{selectedCurated.label}</h2>
                        <p class="mt-0.5 text-sm text-[var(--text-secondary)]">{selectedCurated.description}</p>
                        <div class="mt-2 flex flex-wrap gap-1.5">
                          <span class="rounded-full bg-[var(--surface-highlight)] border border-[var(--border)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)]">{selectedCurated.architecture}</span>
                          {#if selectedCurated.has_vision}
                            <span class="rounded-full bg-[var(--surface-highlight)] border border-[var(--border)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)]">Vision</span>
                          {/if}
                          {#if selectedCurated.has_tools}
                            <span class="rounded-full border border-[var(--border)] bg-[var(--surface-highlight)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)]">Tool Calling</span>
                          {/if}
                        </div>
                      </div>

                      <!-- Variant picker -->
                      <div>
                        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Select Variant</h3>
                        <div class="space-y-1.5">
                          {#each selectedCurated.variants as v (v.filename)}
                            {@const job = downloadsStore.jobFor(selectedCurated.repo_id, v.filename)}
                            {@const downloaded = findDownloadedModel(v.filename)}
                            <button
                              type="button"
                              class="group flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition {selectedVariant === v.filename ? 'border-[var(--border-strong)] bg-[var(--surface-highlight)]' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-highlight)]'}"
                              onclick={() => (selectedVariant = v.filename)}
                            >
                              <div class="flex items-center gap-3 min-w-0">
                                <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 {selectedVariant === v.filename ? 'border-[var(--primary)]' : 'border-[var(--border-strong)]'}">
                                  {#if selectedVariant === v.filename}
                                    <div class="h-2.5 w-2.5 rounded-full bg-[var(--primary)]"></div>
                                  {/if}
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <span class="text-sm font-medium text-[var(--text)]">{v.quant}</span>
                                    {#if v.recommended}
                                      <span class="rounded-full bg-[var(--surface-highlight)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">Recommended</span>
                                    {/if}
                                  </div>
                                  <span class="text-xs text-[var(--text-muted)]">{v.filename}</span>
                                </div>
                              </div>
                              <div class="flex shrink-0 items-center gap-2">
                                <span class="text-xs text-[var(--text-tertiary)]">{v.size_human}</span>
                                {#if downloaded || (job && job.status === 'done')}
                                  <span class="rounded-full bg-[var(--surface-highlight)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]"><Check class="inline h-3 w-3" /> Downloaded</span>
                                {:else if job && (job.status === 'starting' || job.status === 'running')}
                                  <span class="text-[10px] text-[var(--text-muted)]">{downloadsStore.getJobSpeed(job.id) || 'Downloading…'}</span>
                                {/if}
                              </div>
                            </button>
                          {/each}
                        </div>
                      </div>

                      <!-- Vision model picker -->
                      <div>
                        <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Vision Model <span class="normal-case font-normal text-[var(--text-muted)]">(for image attachments)</span></h3>
                        <p class="mb-2 text-[11px] text-[var(--text-muted)]">Download alongside the main model to enable image understanding.</p>
                        <div class="space-y-1.5">
                          {#each selectedCurated.vision_files as vf (vf.filename)}
                            {@const vjob = downloadsStore.jobFor(selectedCurated.repo_id, vf.filename)}
                            {@const vdownloaded = findDownloadedModel(vf.filename)}
                            <button
                              type="button"
                              class="group flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition {selectedVisionFile === vf.filename ? 'border-[var(--border-strong)] bg-[var(--surface-highlight)]' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-highlight)]'}"
                              onclick={() => (selectedVisionFile = vf.filename)}
                            >
                              <div class="flex items-center gap-3 min-w-0">
                                <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 {selectedVisionFile === vf.filename ? 'border-[var(--primary)]' : 'border-[var(--border-strong)]'}">
                                  {#if selectedVisionFile === vf.filename}
                                    <div class="h-2.5 w-2.5 rounded-full bg-[var(--primary)]"></div>
                                  {/if}
                                </div>
                                <div>
                                  <span class="text-sm font-medium text-[var(--text)]">{vf.filename}</span>
                                  <p class="text-xs text-[var(--text-muted)]">{vf.description}</p>
                                </div>
                              </div>
                              <div class="flex shrink-0 items-center gap-2">
                                <span class="text-xs text-[var(--text-tertiary)]">{vf.size_human}</span>
                                {#if vdownloaded || (vjob && vjob.status === 'done')}
                                  <span class="rounded-full bg-[var(--surface-highlight)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]"><Check class="inline h-3 w-3" /> Downloaded</span>
                                {:else if vjob && (vjob.status === 'starting' || vjob.status === 'running')}
                                  <span class="text-[10px] text-[var(--text-muted)]">Downloading…</span>
                                {/if}
                              </div>
                            </button>
                          {/each}
                        </div>
                      </div>

                      <!-- Download actions -->
                      {#if isTauri()}
                        <div class="flex flex-wrap gap-3 pt-1">
                          {#if selectedVisionFile}
                            <button
                              type="button"
                              class="inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                              disabled={!selectedVariant || downloadingCuratedMain || downloadingCuratedVision}
                              onclick={() => {
                                if (selectedVariant) void downloadCuratedModel();
                                if (selectedVisionFile) void downloadCuratedVision();
                              }}
                            >
                              {#if downloadingCuratedMain || downloadingCuratedVision}
                                <div class="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary-fg)]/30 border-t-[var(--primary-fg)]"></div>
                              {:else}
                                <Download class="h-4 w-4" />
                              {/if}
                              Download Model + Vision
                            </button>
                          {:else}
                            <button
                              type="button"
                              class="inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                              disabled={!selectedVariant || downloadingCuratedMain}
                              onclick={downloadCuratedModel}
                            >
                              {#if downloadingCuratedMain}
                                <div class="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary-fg)]/30 border-t-[var(--primary-fg)]"></div>
                              {:else}
                                <Download class="h-4 w-4" />
                              {/if}
                              Download Model
                            </button>
                          {/if}
                          <button
                            type="button"
                            class="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-5 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
                            disabled={!selectedVariant || downloadingCuratedMain}
                            onclick={downloadCuratedModel}
                          >
                            <Download class="h-4 w-4" />
                            Model Only
                          </button>
                        </div>
                      {:else}
                        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                          Downloads are only available in the desktop app.
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>

            {:else}
              <div class="flex min-h-0 flex-1 overflow-hidden">
                <div class="w-72 shrink-0 overflow-y-auto border-r border-[var(--border)]">
                  <div class="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
                    <span class="text-xs text-[var(--text-muted)]">{searchResults.length} result{searchResults.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div class="p-2">
                    {#if searching}
                      <div class="flex items-center justify-center py-16">
                        <div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600 dark:border-white/10 dark:border-t-white/60"></div>
                      </div>
                    {:else if searchResults.length === 0}
                      <div class="flex flex-col items-center justify-center py-16 text-center">
                        <Search class="mb-3 h-8 w-8 text-neutral-200 dark:text-neutral-700" />
                        <p class="text-sm text-[var(--text-tertiary)]">Search models</p>
                        <p class="mt-0.5 text-xs text-[var(--text-muted)]">Try "llama", "qwen", "mistral"</p>
                      </div>
                    {:else}
                      <div class="space-y-1">
                        {#each searchResults as result (result.repo_id)}
                          <button
                            type="button"
                            class="w-full rounded-lg px-3 py-2.5 text-left transition {selectedRepo?.repo_id === result.repo_id ? 'bg-neutral-100 dark:bg-white/[0.06]' : 'hover:bg-[var(--surface-highlight)]'}"
                            onclick={() => openRepo(result.repo_id)}
                          >
                            <div class="text-xs font-medium text-[var(--text-secondary)] truncate">{result.repo_id}</div>
                            <div class="mt-0.5 text-[10px] text-[var(--text-muted)]">
                              {result.gguf_files_count ?? 0} files · {result.largest_gguf_human ?? '?'}
                            </div>
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>

                <div class="flex-1 overflow-y-auto p-4">
                  {#if !selectedRepo}
                    <div class="flex h-full flex-col items-center justify-center text-center">
                      <Box class="mb-3 h-10 w-10 text-neutral-200 dark:text-neutral-700" />
                      <p class="text-sm text-[var(--text-tertiary)]">Select a repository</p>
                      <p class="mt-0.5 text-xs text-[var(--text-muted)]">Choose a model to browse GGUF variants</p>
                    </div>
                  {:else}
                    <header class="mb-4">
                      <h2 class="text-sm font-semibold text-[var(--text)]">{selectedRepo.repo_id}</h2>
                      <p class="mt-0.5 text-xs text-[var(--text-muted)]">{repoFiles.length} variant{repoFiles.length !== 1 ? 's' : ''}</p>
                    </header>
                    <div class="space-y-2">
                      {#each repoFiles as file (file.filename)}
                        {@const job = downloadsStore.jobFor(selectedRepo.repo_id, file.filename)}
                        {@const downloaded = findDownloadedModel(file.filename)}
                        <div class="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                          <div class="min-w-0 flex-1">
                            <div class="text-xs font-medium text-[var(--text-secondary)] truncate">{file.filename}</div>
                            <div class="mt-0.5 text-[10px] text-[var(--text-muted)]">{file.size_human}</div>
                          </div>
                          <div class="shrink-0">
                            {#if job && job.status === 'done'}
                              <button
                                type="button"
                                class="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 transition hover:bg-emerald-500/20 disabled:opacity-50"
                                onclick={() => downloaded && appStore.openLocalModelLoadDialog(downloaded)}
                                disabled={!downloaded}
                              >
                                <Check class="h-3 w-3" />
                                Load
                              </button>
                            {:else if job && (job.status === 'starting' || job.status === 'running')}
                              {@const speed = downloadsStore.getJobSpeed(job.id)}
                              <div class="flex items-center gap-2">
                                <div class="flex flex-col gap-1 min-w-[140px]">
                                  <div class="flex justify-between text-[10px] text-[var(--text-muted)]">
                                    <span>{job.progress.toFixed(0)}%</span>
                                    <span>{speed && speed.speedBps > 0 ? (speed.speedBps >= 1048576 ? `${(speed.speedBps / 1048576).toFixed(1)} MB/s` : `${(speed.speedBps / 1024).toFixed(0)} KB/s`) : ''}</span>
                                  </div>
                                  <div class="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
                                    <div class="h-full rounded-full bg-[var(--primary)] transition-all" style="width: {job.progress}%"></div>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500"
                                  onclick={async () => { await cancelDownloadJob(job.id); await downloadsStore.refresh(); }}
                                  aria-label="Cancel download"
                                  title="Cancel"
                                >
                                  <Ban class="h-3.5 w-3.5" />
                                </button>
                              </div>
                            {:else if job && job.status === 'error'}
                              <div class="flex items-center gap-2">
                                <span class="max-w-[120px] truncate text-xs text-red-500" title={job.error || 'Error'}>{job.error || 'Error'}</span>
                                <button
                                  type="button"
                                  class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition hover:opacity-90"
                                  onclick={async () => { await downloadsStore.retryJob(job.id); }}
                                >
                                  <RotateCcw class="h-3 w-3" />
                                  Retry
                                </button>
                              </div>
                            {:else if job && job.status === 'cancelled'}
                              <div class="flex items-center gap-2">
                                <span class="text-xs text-neutral-400">Cancelled</span>
                                <button
                                  type="button"
                                  class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition hover:opacity-90"
                                  onclick={async () => { await downloadsStore.retryJob(job.id); }}
                                >
                                  <RotateCcw class="h-3 w-3" />
                                  Retry
                                </button>
                              </div>
                            {:else}
                              <button
                                type="button"
                                class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                                onclick={() => downloadRepoFile(selectedRepo.repo_id, file.filename)}
                                disabled={busyId === `${selectedRepo.repo_id}/${file.filename}`}
                              >
                                <Download class="h-3 w-3" />
                                Download
                              </button>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          </div>

        {:else if activeSection === 'voices'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold text-[var(--text)]">Voice Models</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Text-to-speech models for reading responses aloud</p>
            </header>

            {#if voiceCatalogLoading}
              <div class="flex items-center justify-center py-16">
                <div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600 dark:border-white/10 dark:border-t-white/60"></div>
              </div>
            {:else if !Object.keys(voiceModels).length}
              <div class="rounded-xl border border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
                No voice models available
              </div>
            {:else}
              <div class="grid gap-3">
                {#each Object.entries(voiceModels) as [key, item] (key)}
                  {@const voiceCount = Array.isArray(item.voices) ? item.voices.length : 0}
                  {@const sizeLabel = item.size_mb ? `${item.size_mb} MB` : (item.size_human || item.sizeHuman || '')}
                  {@const activeJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && (j.status === 'starting' || j.status === 'running'))}
                  {@const errorJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && j.status === 'error')}
                  {@const isDownloading = activeJobs.length > 0 || downloadingVoice === key}
                  {@const hasError = errorJobs.length > 0 && activeJobs.length === 0}
                  {@const totalFiles = Array.isArray(item.files) ? item.files.length : 0}
                  {@const doneJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && j.status === 'done')}
                  <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 {item.is_active ? 'ring-1 ring-emerald-200 dark:ring-emerald-800/40' : ''}">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <h3 class="text-sm font-semibold text-[var(--text)]">{item.label || key}</h3>
                          {#if item.is_active}
                            <span class="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">Active</span>
                          {/if}
                        </div>
                        <p class="mt-0.5 text-xs text-[var(--text-tertiary)]">
                          {item.engine === 'kokoro' ? 'Kokoro' : 'Kitten'}{sizeLabel ? ` · ${sizeLabel}` : ''}{voiceCount ? ` · ${voiceCount} voices` : ''}
                        </p>
                        {#if item.description}
                          <p class="mt-1 text-xs text-[var(--text-muted)]">{item.description}</p>
                        {/if}
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
                        {#if item.downloaded && !item.is_active}
                          <button
                            type="button"
                            class="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                          onclick={async () => {
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
                                ttsVoice = item.voices?.[0] || '';
                                if (ttsVoice) await appStore.updateTtsSettings({ voice: ttsVoice });
                                toastStore.success(`Using ${item.label || key}`);
                                await loadVoiceModelCatalog();
                              } catch (err) {
                                toastStore.error(`Failed to activate: ${(err as Error)?.message || err}`);
                              }
                            }}
                          >
                            Use
                          </button>
                        {/if}
                        {#if item.is_active}
                          <button
                            type="button"
                            class="rounded-lg border border-red-200 dark:border-red-800/40 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition hover:bg-red-50 dark:hover:bg-red-900/10"
                            onclick={() => unloadTts()}
                          >
                            Unload
                          </button>
                        {/if}
                        {#if isDownloading}
                          <div class="flex items-center gap-2">
                            <div class="flex flex-col gap-1 min-w-[100px]">
                              <div class="text-[10px] text-[var(--text-muted)]">
                                Downloading {activeJobs.length}/{totalFiles} files
                              </div>
                              {#if activeJobs[0]}
                                <div class="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
                                  <div class="h-full rounded-full bg-[var(--primary)] transition-all animate-pulse" style="width: {activeJobs[0].progress}%"></div>
                                </div>
                              {/if}
                            </div>
                            <button
                              type="button"
                              class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500"
                              onclick={async () => {
                                for (const j of activeJobs) { await cancelDownloadJob(j.id); }
                                downloadingVoice = null;
                                await downloadsStore.refresh();
                              }}
                              aria-label="Cancel"
                              title="Cancel all"
                            >
                              <Ban class="h-3.5 w-3.5" />
                            </button>
                          </div>
                        {:else if hasError}
                          <div class="flex items-center gap-2">
                            <span class="text-xs text-red-500">Failed</span>
                            <button
                              type="button"
                              class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                              onclick={async () => {
                                try {
                                  for (const j of errorJobs) { await downloadsStore.removeJob(j.id); }
                                  if (!item.repo_id) { toastStore.error('No repo ID'); return; }
                                  downloadingVoice = key;
                                  const dir = await getModelsDirPath();
                                  for (const file of item.files || []) {
                                    await startDownloadHf({ repo_id: item.repo_id, file, models_dir: dir, dest_rel: `${item.dir}/${file}` });
                                  }
                                  downloadsStore.startPolling();
                                  await downloadsStore.refresh();
                                } catch (err) {
                                  toastStore.error(`Retry failed: ${(err as Error)?.message || err}`);
                                } finally { downloadingVoice = null; }
                              }}
                            >
                              <RotateCcw class="h-3 w-3" />
                              Retry
                            </button>
                          </div>
                        {:else if !item.downloaded}
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                            disabled={downloadingVoice === key}
                            onclick={async () => {
                              try {
                                if (!item.repo_id) { toastStore.error('No repo ID'); return; }
                                downloadingVoice = key;
                                const dir = await getModelsDirPath();
                                for (const file of item.files || []) {
                                  await startDownloadHf({ repo_id: item.repo_id, file, models_dir: dir, dest_rel: `${item.dir}/${file}` });
                                }
                                downloadsStore.startPolling();
                                await downloadsStore.refresh();
                                toastStore.success(`Downloading ${item.label || key}…`);
                              } catch (err) {
                                console.error('Voice download error:', err);
                                toastStore.error(`Download failed: ${(err as Error)?.message || err}`);
                              } finally { downloadingVoice = null; }
                            }}
                          >
                            <Download class="h-3 w-3" />
                            Download
                          </button>
                        {/if}
                      </div>
                    </div>
                    {#if doneJobs.length > 0 && doneJobs.length >= totalFiles && !item.downloaded}
                      <div class="mt-2 flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check class="h-3.5 w-3.5" />
                        <span>Download complete — refresh to see model</span>
                        <button
                          type="button"
                          class="rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-black/5 dark:hover:bg-white/5"
                          onclick={() => loadVoiceModelCatalog()}
                        >
                          Refresh
                        </button>
                      </div>
                    {/if}

                    <!-- Voice picker for active model -->
                    {#if item.is_active && Array.isArray(item.voices) && item.voices.length > 0}
                      {@const voiceGroups = (() => {
                        const groups: { label: string; voices: string[] }[] = [];
                        const grouped: Record<string, string[]> = {};
                        for (const v of item.voices) {
                          let key = 'Other';
                          if (v.startsWith('af_')) key = 'American Female';
                          else if (v.startsWith('am_')) key = 'American Male';
                          else if (v.startsWith('bf_')) key = 'British Female';
                          else if (v.startsWith('bm_')) key = 'British Male';
                          else if (v.startsWith('ef_')) key = 'Spanish Female';
                          else if (v.startsWith('em_')) key = 'Spanish Male';
                          else if (v.startsWith('ff_')) key = 'French Female';
                          else if (v.startsWith('fm_')) key = 'French Male';
                          else if (v.startsWith('hf_')) key = 'Hindi Female';
                          else if (v.startsWith('hm_')) key = 'Hindi Male';
                          else if (v.startsWith('if_')) key = 'Italian Female';
                          else if (v.startsWith('im_')) key = 'Italian Male';
                          else if (v.startsWith('jf_')) key = 'Japanese Female';
                          else if (v.startsWith('jm_')) key = 'Japanese Male';
                          else if (v.startsWith('kf_')) key = 'Korean Female';
                          else if (v.startsWith('km_')) key = 'Korean Male';
                          else if (v.startsWith('pf_')) key = 'Portuguese Female';
                          else if (v.startsWith('pm_')) key = 'Portuguese Male';
                          else if (v.startsWith('zf_')) key = 'Chinese Female';
                          else if (v.startsWith('zm_')) key = 'Chinese Male';
                          if (!grouped[key]) grouped[key] = [];
                          grouped[key].push(v);
                        }
                        const order = [
                          'American Female', 'American Male', 'British Female', 'British Male',
                          'Japanese Female', 'Japanese Male', 'Chinese Female', 'Chinese Male',
                          'Spanish Female', 'Spanish Male', 'French Female', 'French Male',
                          'Hindi Female', 'Hindi Male', 'Italian Female', 'Italian Male',
                          'Korean Female', 'Korean Male', 'Portuguese Female', 'Portuguese Male',
                          'Other',
                        ];
                        for (const label of order) {
                          if (grouped[label]?.length) groups.push({ label, voices: grouped[label] });
                        }
                        return groups;
                      })()}
                      <div class="mt-3 border-t border-[var(--border)] pt-3">
                        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Select Voice</p>
                        <div class="max-h-[240px] space-y-3 overflow-y-auto pr-1">
                          {#each voiceGroups as group (group.label)}
                            {#if voiceGroups.length > 1}
                              <p class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{group.label}</p>
                            {/if}
                            <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                              {#each group.voices as voice (voice)}
                                {@const isSelected = ttsVoice === voice}
                                <button
                                  type="button"
                                  class="flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition {isSelected
                                    ? 'border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text)] ring-1 ring-[var(--primary)]'
                                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-highlight)]'}"
                                  onclick={async () => {
                                    ttsVoice = voice;
                                    await appStore.updateTtsSettings({ voice });
                                    toastStore.success(`Voice set to ${voice}`);
                                  }}
                                >
                                  <Volume2 class="h-3 w-3 shrink-0 {isSelected ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'}" />
                                  <span class="truncate">{voice}</span>
                                  {#if isSelected}
                                    <Check class="ml-auto h-3 w-3 shrink-0 text-[var(--primary)]" />
                                  {/if}
                                </button>
                              {/each}
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

        {:else if activeSection === 'whisper'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold text-[var(--text)]">Whisper Speech-to-Text</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Models for transcribing audio input</p>
            </header>

            <!-- ── Microphone selector ── -->
            <div class="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div class="flex items-center gap-2 mb-3">
                <Mic class="h-4 w-4 text-[var(--text-muted)] shrink-0" />
                <span class="text-sm font-semibold text-[var(--text)]">Microphone</span>
              </div>
              {#if micPermission === 'denied'}
                <p class="text-xs text-amber-500 dark:text-amber-400">
                  Microphone access was denied. Grant permission in your browser/system settings to select a device.
                </p>
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
                    class="mic-select w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] transition focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
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

            {#if voiceCatalogLoading}
              <div class="flex items-center justify-center py-16">
                <div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600 dark:border-white/10 dark:border-t-white/60"></div>
              </div>
            {:else}
              <div class="grid gap-3 sm:grid-cols-2">
                {#each Object.entries(whisperModels) as [key, item] (key)}
                  {@const sizeLabel = item.size_mb ? `${item.size_mb} MB` : (item.size_human || item.sizeHuman || '')}
                  {@const whisperFiles = Array.isArray(item.files) ? item.files : []}
                  {@const activeJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && (j.status === 'starting' || j.status === 'running'))}
                  {@const errorJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && j.status === 'error')}
                  {@const isDownloading = activeJobs.length > 0 || downloadingWhisper === key}
                  {@const hasError = errorJobs.length > 0 && activeJobs.length === 0}
                  {@const doneJobs = downloadsStore.jobs.filter((j) => j.repo_id === item.repo_id && whisperFiles.includes(j.file) && j.status === 'done')}
                  <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 {item.is_active ? 'ring-1 ring-emerald-200 dark:ring-emerald-800/40' : ''}">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <h3 class="text-sm font-semibold text-[var(--text)]">{item.label || key}</h3>
                          {#if item.is_active}
                            <span class="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">Active</span>
                          {/if}
                        </div>
                        <p class="mt-0.5 text-xs text-[var(--text-tertiary)]">{item.description}</p>
                        <div class="mt-1.5 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                          {#if sizeLabel}<span>{sizeLabel}</span><span>·</span>{/if}
                          <span>{item.speed}</span>
                          <span>·</span>
                          <span>{item.quality}</span>
                        </div>
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
                        {#if item.downloaded && !item.is_active}
                          <button
                            type="button"
                            class="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
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
                        {/if}
                        {#if item.is_active}
                          <button
                            type="button"
                            class="rounded-lg border border-red-200 dark:border-red-800/40 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition hover:bg-red-50 dark:hover:bg-red-900/10"
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
                        {/if}
                        {#if isDownloading}
                          <div class="flex items-center gap-2">
                            <div class="flex flex-col gap-1 min-w-[100px]">
                              <div class="text-[10px] text-[var(--text-muted)]">
                                Downloading {doneJobs.length + activeJobs.length}/{whisperFiles.length} files
                              </div>
                              {#if activeJobs[0]}
                                <div class="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
                                  <div class="h-full rounded-full bg-[var(--primary)] transition-all animate-pulse" style="width: {activeJobs[0].progress}%"></div>
                                </div>
                              {/if}
                            </div>
                            <button
                              type="button"
                              class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500"
                              onclick={async () => {
                                for (const j of activeJobs) { await cancelDownloadJob(j.id); }
                                downloadingWhisper = null;
                                await downloadsStore.refresh();
                              }}
                              aria-label="Cancel"
                              title="Cancel all"
                            >
                              <Ban class="h-3.5 w-3.5" />
                            </button>
                          </div>
                        {:else if hasError}
                          <div class="flex items-center gap-2">
                            <span class="text-xs text-red-500" title={errorJobs[0]?.error || ''}>Failed</span>
                            <button
                              type="button"
                              class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
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
                          </div>
                        {:else if !item.downloaded}
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
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
                  </div>
                {/each}
              </div>
            {/if}
          </div>

        {:else if activeSection === 'runtime'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold text-[var(--text)]">Local Runtime</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">llama.cpp server for running local models</p>
            </header>

            <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              {#if hasRuntime === true}
                <div class="flex items-center gap-3">
                  <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-500/20">
                    <Check class="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <h3 class="text-sm font-semibold text-[var(--text)]">Runtime installed</h3>
                    <p class="text-xs text-[var(--text-tertiary)]">Local models can be loaded and run</p>
                  </div>
                </div>
              {:else if hasRuntime === false}
                <div class="flex items-start gap-3">
                  <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-500/20">
                    <AlertTriangle class="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div class="flex-1">
                    <h3 class="text-sm font-semibold text-[var(--text)]">Runtime not installed</h3>
                    <p class="mt-0.5 text-xs text-[var(--text-tertiary)]">Install llama.cpp to run local models</p>
                    <button
                      type="button"
                      class="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90"
                      onclick={() => { close(); appStore.runtimeManagerOpen = true; }}
                    >
                      <Settings class="h-3.5 w-3.5" />
                      Open Runtime Settings
                    </button>
                  </div>
                </div>
              {:else}
                <div class="flex items-center justify-center py-4">
                  <div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600 dark:border-white/10 dark:border-t-white/60"></div>
                </div>
              {/if}
            </div>

            <div class="mt-4 rounded-xl border border-[var(--border)] bg-neutral-50 dark:bg-white/[0.02] p-4">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-2">About llama.cpp</h4>
              <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
                llama.cpp is a high-performance inference engine for running large language models locally. 
                It supports GPU acceleration (CUDA, Metal, Vulkan), quantized models, and various optimization techniques 
                for efficient memory usage on consumer hardware.
              </p>
              <a
                href="https://github.com/ggerganov/llama.cpp"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-3 inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <ExternalLink class="h-3 w-3" />
                Learn more on GitHub
              </a>
            </div>
          </div>
        {:else if activeSection === 'search'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold text-[var(--text)]">Search Settings</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Configure how web search works in your chats</p>
            </header>

            <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-5">
              <SearchSettings
                bind:searchProvider
                bind:searchMaxResults
                bind:searchApiKey
                bind:searchEngineId
                bind:searchBaseUrl
                bind:searchModel
              />

              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                onclick={saveSearchSettings}
                disabled={savingSearch}
              >
                {savingSearch ? 'Saving...' : 'Save'}
              </button>
            </div>

            <div class="mt-5 rounded-xl border border-[var(--border)] bg-neutral-50 dark:bg-white/[0.02] p-4">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">Search Modes</h4>
              <div class="space-y-3">
                <div>
                  <h5 class="text-sm font-medium text-[var(--text)]">Web Search</h5>
                  <p class="text-xs text-[var(--text-secondary)] leading-relaxed">Quick search returning snippets from top results. Fast, low context usage.</p>
                </div>
                <div>
                  <h5 class="text-sm font-medium text-[var(--text)]">Deep Search</h5>
                  <p class="text-xs text-[var(--text-secondary)] leading-relaxed">Fetches and reads full page content from top results using a headless browser when available. Extracts text and source links for richer context. Results are indexed for follow-up queries.</p>
                </div>
                <div>
                  <h5 class="text-sm font-medium text-[var(--text)]">Max Search</h5>
                  <p class="text-xs text-[var(--text-secondary)] leading-relaxed">Comprehensive investigation across multiple providers (DuckDuckGo, Wikipedia, ArXiv). Reads up to 8 pages with extended timeouts. All content is indexed into per-chat RAG for deep follow-up analysis.</p>
                </div>
              </div>
            </div>
          </div>
        {:else if activeSection === 'extensions'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold" style="color:var(--text)">Extensions</h2>
              <p class="mt-0.5 text-sm" style="color:var(--text-muted)">Capabilities and integrations for your AI assistant</p>
            </header>

            <div class="space-y-2">
              <p class="mb-3 text-[11px] font-semibold uppercase tracking-wider" style="color:var(--text-muted)">Built-in</p>
              {#each [
                { id: 'web-search', Icon: Search, title: 'Web Search', desc: 'Let the AI search the internet for real-time information.' },
                { id: 'code-sandbox', Icon: Box, title: 'Code Sandbox', desc: 'Run code snippets directly in the app using Pyodide.' },
                { id: 'tts', Icon: Volume2, title: 'Text-to-Speech', desc: 'Read AI responses aloud using local Kokoro voices.' },
                { id: 'stt', Icon: Mic, title: 'Speech-to-Text', desc: 'Transcribe your voice to text with Whisper.' },
                { id: 'rag', Icon: FolderOpen, title: 'File Context (RAG)', desc: 'Attach files and let the AI reason over your documents.' },
                { id: 'charts', Icon: Activity, title: 'Interactive Charts', desc: 'Render D3 charts inline from AI responses. Download as SVG or PNG.' },
                { id: 'agent', Icon: Cpu, title: 'Agent Mode', desc: 'Multi-step reasoning with tool use and planning capabilities.' },
              ] as ext}
                <div class="flex items-center gap-3 rounded-xl border px-4 py-3 transition"
                  style="border-color:var(--border);background:var(--surface)">
                  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                    style="background:color-mix(in srgb,var(--work-accent) 12%,transparent)">
                    <ext.Icon class="h-4 w-4" style="color:var(--work-accent)" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold" style="color:var(--text)">{ext.title}</p>
                    <p class="text-xs leading-relaxed" style="color:var(--text-muted)">{ext.desc}</p>
                  </div>
                  <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style="background:color-mix(in srgb,var(--success) 14%,transparent);color:var(--success)">Active</span>
                </div>
              {/each}
            </div>

            <div class="mt-6 rounded-xl border px-5 py-4 text-center"
              style="border-color:color-mix(in srgb,var(--work-accent) 25%,transparent);background:color-mix(in srgb,var(--work-accent) 5%,transparent)">
              <Puzzle class="mx-auto mb-2 h-8 w-8 opacity-40" style="color:var(--work-accent)" />
              <p class="text-sm font-semibold" style="color:var(--text)">Community Extensions</p>
              <p class="mt-1 text-xs" style="color:var(--text-muted)">Third-party extensions coming soon — custom tools, integrations, and more.</p>
            </div>
          </div>
        {:else if activeSection === 'providers'}
          <div class="flex-1 overflow-y-auto p-5">
            <header class="mb-5">
              <h2 class="text-base font-semibold text-[var(--text)]">API Providers</h2>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">Configure cloud or self-hosted LLM providers</p>
            </header>

            <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-5">
              <!-- Provider selector -->
              <label class="block space-y-1.5 text-sm">
                <span class="font-medium text-[var(--text-secondary)]">Provider</span>
                <select class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={providerName}>
                  <optgroup label="Cloud">
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter (multi-provider)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="groq">Groq</option>
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
                <input class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={providerBaseUrl} placeholder="https://api.openai.com/v1" />
              </label>

              <!-- API Key -->
              <div class="space-y-1.5 text-sm">
                <div class="flex items-center justify-between">
                  <span class="font-medium text-[var(--text-secondary)]">API Key</span>
                  {#if appStore.activeProvider?.has_api_key && providerName === appStore.activeProviderName}
                    <span class="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Saved
                    </span>
                  {/if}
                </div>
                <input
                  class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
                  bind:value={providerApiKey}
                  placeholder={appStore.activeProvider?.has_api_key && providerName === appStore.activeProviderName ? '••••••••• (leave blank to keep)' : 'Enter API key…'}
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
                        class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
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
                            void appStore.updateProvider({ provider: providerName, model: providerModel });
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
                                class="flex w-full items-center px-4 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-highlight)] {m === providerModel ? 'text-[var(--primary)] font-medium' : 'text-[var(--text)]'}"
                                onclick={() => {
                                  providerModel = m;
                                  modelDropdownOpen = false;
                                  modelSearchQuery = '';
                                  void appStore.updateProvider({ provider: providerName, model: m });
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
                    <input class="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]" bind:value={providerModel} placeholder="No model" />
                  {/if}
                  <button
                    class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
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
                  class="h-20 w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
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
                    class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
                    bind:value={providerMaxTokens}
                    inputmode="numeric"
                    placeholder="2048 (leave blank for provider default)"
                  />
                </label>
              </div>

              <!-- Actions -->
              <div class="flex items-center gap-3 pt-2 border-t border-[var(--border)]">
                <button
                  class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                  onclick={saveProviderConfig}
                  disabled={savingProvider}
                >
                  {savingProvider ? 'Saving…' : 'Save Provider'}
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-50"
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
                  <span class={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${providerConnectionStatus === 'ok' ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-red-500/12 text-red-700 dark:text-red-300'}`}>
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
  .mic-select option {
    background: var(--surface);
    color: var(--text);
  }
</style>
