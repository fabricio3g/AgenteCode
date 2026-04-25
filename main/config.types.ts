/**
 * TypeScript type definitions for the application configuration.
 * These interfaces define the structure of config.json and related files.
 */

/**
 * Runtime install variant options.
 */
export type RuntimeInstallVariant = 
  | 'auto' | 'cpu' | 'cuda' | 'cuda12' | 'cuda13' | 'vulkan'
  | 'hip' | 'rocm' | 'sycl' | 'openeuler_310p' | 'openeuler_910b_aclgraph';

/**
 * Runtime release source options.
 */
export type RuntimeReleaseSource = 'api' | 'github_release';

/**
 * Local runtime binary configuration.
 */
export interface LocalBinaryConfig {
  managed: boolean;
  path: string;
  version: string;
  channel: string;
  manifest_url: string;
  current_asset_id: string;
  sha256: string;
  install_variant: RuntimeInstallVariant;
  install_source: string;
  release_source: RuntimeReleaseSource;
  release_tag: string;
  installed: string[];
  active_runtime_id: string;
}

/**
 * Local runtime server configuration.
 */
export interface LocalServerConfig {
  host: string;
  port: number;
  args: string[];
}

/**
 * Local LLM configuration.
 */
export interface LocalLLMConfig {
  enabled: boolean;
  runtime: string;
  binary: LocalBinaryConfig;
  server: LocalServerConfig;
  models_dir: string;
  base_url: string;
  embedding_model: string;
  embedding_model_path: string;
  embedding_port: number;
  embedding_context_length: number;
  embedding_gpu_layers: number;
  active_model_id: string;
  default_model_id: string;
  models: unknown[];
}

/**
 * Provider type options.
 */
export type ProviderType = 'openai_compat' | 'anthropic' | 'gemini' | 'mistral' | 'groq';

/**
 * Provider default parameters.
 */
export interface ProviderDefaultParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
}

/**
 * LLM provider configuration.
 */
export interface LLMProviderConfig {
  type: ProviderType | string;
  base_url: string;
  api_key: string;
  model: string;
  default_params: ProviderDefaultParams;
}

/**
 * LLM backend mode options.
 */
export type LLMBackendMode = 'api' | 'local' | 'hybrid';

/**
 * Full LLM configuration.
 */
export interface LLMConfig {
  backend_mode: LLMBackendMode;
  provider: string;
  system_prompt: string;
  user_prompt: string;
  local: LocalLLMConfig;
  providers: Record<string, LLMProviderConfig>;
}

/**
 * TTS voice mapping.
 */
export interface TTSVoiceMap {
  Bella?: number;
  Jasper?: number;
  Luna?: number;
  Bruno?: number;
  Rosie?: number;
  Hugo?: number;
  Kiki?: number;
  Leo?: number;
  [key: string]: number | undefined;
}

/**
 * TTS engine type.
 */
export type TTSEngineType = 'kitten' | 'kokoro';

/**
 * TTS configuration.
 */
export interface TTSConfig {
  engine: TTSEngineType;
  model_variant: string;
  model_dir: string;
  model: string;
  voices: string;
  tokens: string;
  data_dir: string;
  dict_dir: string;
  lexicon: string;
  lang: string;
  num_threads: number;
  provider: string;
  sample_rate: number;
  voice_map: TTSVoiceMap;
  [key: string]: unknown;
}

/**
 * STT provider type.
 */
export type STTProviderType = 'local' | 'api';

/**
 * Whisper quality level.
 */
export type WhisperQuality = 'tiny' | 'base' | 'small' | 'medium';

/**
 * STT configuration.
 */
export interface STTConfig {
  provider: STTProviderType;
  model: string;
  whisper_quality: WhisperQuality;
  [key: string]: unknown;
}

/**
 * RAG configuration.
 */
export interface RAGConfig {
  enabled: boolean;
  auto_start_embedding: boolean;
  rerank: boolean;
  preferred_embedding_model: string;
  fallback_embedding_models: string[];
}

/**
 * Onboarding configuration.
 */
export interface OnboardingConfig {
  completed: boolean;
  completed_at: string | null;
}

/**
 * Full application configuration.
 */
export interface AppConfig {
  tts: TTSConfig;
  llm: LLMConfig;
  rag: RAGConfig;
  stt: STTConfig;
  onboarding: OnboardingConfig;
  [key: string]: unknown;
}

/**
 * Application paths returned by getAppPaths().
 */
export interface AppPaths {
  configPath: string;
  secretsPath: string;
  modelsRoot: string;
  localModelsRoot: string;
  appData: string;
  assetsRoot: string;
  localBinRoot: string;
  localBinVersionsRoot: string;
  cacheRoot: string;
  projectRoot: string;
  IS_DEV: boolean;
}

/**
 * TTS model catalog entry.
 */
export interface TTSModelCatalogEntry {
  label: string;
  repo: string;
  dir: string;
  engine: TTSEngineType;
  lang?: string;
  voice_map?: Record<string, number>;
}

/**
 * Whisper quality catalog entry.
 */
export interface WhisperQualityCatalogEntry {
  label: string;
  repo: string;
  dir: string;
  encoder: string;
  decoder: string;
  tokens: string;
  files: string[];
}

/**
 * Local GGUF model catalog entry.
 */
export interface LocalGGUFCatalogEntry {
  label: string;
  filename: string;
  url: string;
  size_bytes: number;
}