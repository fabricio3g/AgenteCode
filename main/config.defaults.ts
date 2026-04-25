/**
 * Default configuration factory.
 * Provides the base configuration structure with sensible defaults.
 */

import path from 'node:path';
import type {
  AppConfig,
  AppPaths,
  TTSConfig,
  LLMConfig,
  RAGConfig,
  STTConfig,
  OnboardingConfig,
  LocalLLMConfig,
  LLMProviderConfig,
} from './config.types.ts';

/**
 * Creates a default TTS configuration.
 * @param modelsRoot - Root path for models directory
 * @returns Default TTS configuration object
 */
export function getDefaultTTSConfig(modelsRoot: string): TTSConfig {
  return {
    engine: 'kitten',
    model_variant: 'kitten_nano_v02',
    model_dir: path.join(modelsRoot, 'kitten-nano-en-v0_2-fp16'),
    model: 'model.fp16.onnx',
    voices: 'voices.bin',
    tokens: 'tokens.txt',
    data_dir: 'espeak-ng-data',
    dict_dir: 'dict',
    lexicon: 'lexicon.txt',
    lang: 'en-us',
    num_threads: 2,
    provider: 'cpu',
    sample_rate: 24000,
    voice_map: {
      Bella: 0, Jasper: 1, Luna: 2, Bruno: 3,
      Rosie: 4, Hugo: 5, Kiki: 6, Leo: 7
    }
  };
}

/**
 * Creates a default OpenAI-compatible provider configuration.
 * @param baseUrl - The API base URL
 * @returns Default provider configuration
 */
export function getDefaultProvider(baseUrl: string): LLMProviderConfig {
  return {
    type: 'openai_compat',
    base_url: baseUrl,
    api_key: '',
    model: '',
    default_params: { temperature: 0.7 }
  };
}

/**
 * Creates default LLM provider configurations.
 * @returns Map of default providers
 */
export function getDefaultProviders(): Record<string, LLMProviderConfig> {
  return {
    openai: getDefaultProvider('https://api.openai.com/v1'),
    openrouter: getDefaultProvider('https://openrouter.ai/api/v1'),
    lmstudio: getDefaultProvider('http://localhost:1234/v1'),
  };
}

/**
 * Creates a default local LLM configuration.
 * @param localModelsRoot - Root path for local models
 * @param port - Server port number
 * @returns Default local LLM configuration
 */
export function getDefaultLocalLLMConfig(localModelsRoot: string, port: number = 11435): LocalLLMConfig {
  return {
    enabled: true,
    runtime: 'llama_cpp',
    binary: {
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
      active_runtime_id: ''
    },
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

/**
 * Creates a default LLM configuration.
 * @param localModelsRoot - Root path for local models
 * @returns Default LLM configuration
 */
export function getDefaultLLMConfig(localModelsRoot: string): LLMConfig {
  return {
    backend_mode: 'api',
    provider: 'openai',
    system_prompt: 'You are a helpful assistant.',
    user_prompt: '',
    local: getDefaultLocalLLMConfig(localModelsRoot),
    providers: getDefaultProviders()
  };
}

/**
 * Creates a default RAG configuration.
 * @returns Default RAG configuration
 */
export function getDefaultRAGConfig(): RAGConfig {
  return {
    enabled: true,
    auto_start_embedding: true,
    rerank: false,
    preferred_embedding_model: 'nomic_embed_text_v15',
    fallback_embedding_models: ['all_minilm_l6_v2']
  };
}

/**
 * Creates a default STT configuration.
 * @returns Default STT configuration
 */
export function getDefaultSTTConfig(): STTConfig {
  return {
    provider: 'local',
    model: 'whisper-1',
    whisper_quality: 'base',
  };
}

/**
 * Creates a default onboarding configuration.
 * @returns Default onboarding configuration
 */
export function getDefaultOnboardingConfig(): OnboardingConfig {
  return {
    completed: false,
    completed_at: null,
  };
}

/**
 * Creates the full default application configuration.
 * @param paths - Application paths object
 * @returns Complete default configuration object
 */
export function getDefaultConfig(paths: AppPaths): AppConfig {
  return {
    tts: getDefaultTTSConfig(paths.modelsRoot),
    llm: getDefaultLLMConfig(paths.localModelsRoot),
    rag: getDefaultRAGConfig(),
    stt: getDefaultSTTConfig(),
    onboarding: getDefaultOnboardingConfig(),
  };
}

/**
 * Creates default config with custom paths (for testing).
 * @param modelsRoot - Custom models root path
 * @param localModelsRoot - Custom local models root path
 * @returns Complete default configuration object
 */
export function createDefaultConfigWithPaths(
  modelsRoot: string,
  localModelsRoot: string
): AppConfig {
  return getDefaultConfig({
    configPath: path.join(modelsRoot, 'config.json'),
    secretsPath: path.join(modelsRoot, 'secrets.json'),
    modelsRoot,
    localModelsRoot,
  });
}