import { DEFAULT_AGGREGATOR_ENGINES } from './search-providers/aggregator/constants.ts';
import path from 'node:path';
import { DEFAULT_PROVIDER_ID } from '../shared/providers.ts';
import type {
  AppConfig,
  AppPaths,
  LLMProviderConfig,
  LocalBinaryConfig,
  LocalLLMConfig,
  LLMConfig,
  OnboardingConfig,
  RAGConfig,
  SearchConfig,
  STTConfig,
  TTSConfig,
  TTSVoiceMap,
} from './config.types.ts';

const TTS_MODEL_DIR = 'kokoro-multi-lang-v1_1';
const DEFAULT_LOCAL_LLM_PORT = 11435;

export const DEFAULT_TTS_VOICE_MAP = {
  af_heart: 0,
  af_bella: 1,
  af_nicole: 2,
  am_michael: 3,
  am_fenrir: 4,
  bf_emma: 5,
} satisfies TTSVoiceMap;

export function getDefaultTTSConfig(modelsRoot: string): TTSConfig {
  return {
    engine: 'wasm',
    model_variant: 'kokoro_v11',
    model_dir: path.join(modelsRoot, TTS_MODEL_DIR),
    model: 'model.int8.onnx',
    voices: 'voices.bin',
    tokens: 'tokens.txt',
    data_dir: 'espeak-ng-data',
    dict_dir: 'dict',
    lexicon: 'lexicon.txt',
    lang: 'en-us',
    num_threads: 2,
    provider: 'cpu',
    sample_rate: 24000,
    voice: 'af_heart',
    enable_voice_output: true,
    auto_play_voice: false,
    voice_map: { ...DEFAULT_TTS_VOICE_MAP },
  };
}

export function getDefaultProvider(baseUrl: string): LLMProviderConfig {
  return {
    type: 'openai_compat',
    base_url: baseUrl,
    api_key: '',
    model: '',
    default_params: { temperature: 0.7 }
  };
}

export function getDefaultProviders(): Record<string, LLMProviderConfig> {
  return {
    'opencode-go': getDefaultProvider('https://opencode.ai/zen/go/v1'),
    openrouter: getDefaultProvider('https://openrouter.ai/api/v1'),
    deepseek: {
      type: 'openai_compat',
      base_url: 'https://api.deepseek.com',
      api_key: '',
      model: 'deepseek-v4-flash',
      default_params: { temperature: 0.7 }
    },
    lmstudio: getDefaultProvider('http://localhost:1234/v1'),
  };
}

function getDefaultLocalBinaryConfig(): LocalBinaryConfig {
  return {
    managed: true,
    path: '',
    version: '',
    channel: 'stable',
    manifest_url: '',
    current_asset_id: '',
    sha256: '',
    install_variant: 'auto',
    install_source: 'github_release',
    release_source: 'api',
    release_tag: '',
    installed: [],
    active_runtime_id: '',
  };
}

export function getDefaultLocalLLMConfig(
  localModelsRoot: string,
  port = DEFAULT_LOCAL_LLM_PORT
): LocalLLMConfig {
  return {
    enabled: true,
    runtime: 'llama_cpp',
    binary: getDefaultLocalBinaryConfig(),
    server: { host: '127.0.0.1', port, args: [] },
    models_dir: localModelsRoot,
    base_url: `http://127.0.0.1:${port}/v1`,
    embedding_model: 'nomic_embed_text_v15',
    embedding_model_path: '',
    embedding_port: 11436,
    embedding_context_length: 2048,
    embedding_gpu_layers: 0,
    active_model_id: '',
    default_model_id: '',
    models: []
  };
}

export function getDefaultLLMConfig(localModelsRoot: string): LLMConfig {
  return {
    backend_mode: 'api',
    provider: DEFAULT_PROVIDER_ID,
    system_prompt: 'You are a helpful assistant.',
    user_prompt: '',
    local: getDefaultLocalLLMConfig(localModelsRoot),
    providers: getDefaultProviders()
  };
}

export function getDefaultRAGConfig(): RAGConfig {
  return {
    enabled: true,
    auto_start_embedding: true,
    rerank: false,
    preferred_embedding_model: 'nomic_embed_text_v15',
    fallback_embedding_models: ['all_minilm_l6_v2']
  };
}

export function getDefaultSTTConfig(): STTConfig {
  return {
    provider: 'local',
    model: 'whisper-1',
    whisper_quality: 'small_q5',
    language: 'auto',
    backend: 'auto',
  };
}

export function getDefaultOnboardingConfig(): OnboardingConfig {
  return {
    completed: false,
    completed_at: null,
  };
}

export function getDefaultSearchConfig(): SearchConfig {
  return {
    // Auto: a keyed search API when one is set up, else the free API sources.
    provider: 'auto',
    max_results: 6,
    aggregator_engines: [...DEFAULT_AGGREGATOR_ENGINES],
    safe_search: 2,
    providers: {},
  };
}

/** Only these two paths are read; demanding all of `AppPaths` invites stale partial literals. */
export function getDefaultConfig(paths: Pick<AppPaths, 'modelsRoot' | 'localModelsRoot'>): AppConfig {
  return {
    tts: getDefaultTTSConfig(paths.modelsRoot),
    llm: getDefaultLLMConfig(paths.localModelsRoot),
    rag: getDefaultRAGConfig(),
    stt: getDefaultSTTConfig(),
    onboarding: getDefaultOnboardingConfig(),
    search: getDefaultSearchConfig(),
  };
}

export function createDefaultConfigWithPaths(
  modelsRoot: string,
  localModelsRoot: string
): AppConfig {
  return getDefaultConfig({ modelsRoot, localModelsRoot });
}
