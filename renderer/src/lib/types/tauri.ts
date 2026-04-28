export interface HardwareInfo {
  total_ram_gb: number;
  free_ram_gb: number;
  physical_cores: number;
  cpu_threads: number;
  cpu_model: string;
  vram_gb: number;
  vram_estimated?: boolean;
  gpu_name: string;
  gpu_backend: 'cuda' | 'vulkan' | 'metal' | 'cpu' | string;
  os_platform: string;
  os_arch: string;
}

export interface DesktopCapabilities {
  platform: string;
  desktop_shell: boolean;
  local_runtime: boolean;
  local_tts: boolean;
  audio_recording: boolean;
  rag_indexing: boolean;
  web_search: boolean;
  sandbox_exec: boolean;
   agent_runtime: boolean;
}

export interface ManagedAgentArtifact {
  title: string;
  files: Record<string, string>;
  preview_html?: string | null;
  thumbnail?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ManagedAgentStep {
  id: string;
  type: string;
  label: string;
  status: string;
  detail?: string | null;
  output?: string | null;
}

export interface ManagedAgentTask {
  id: string;
  chat_id: string;
  prompt: string;
  status: string;
  mode: string;
  search_mode: string;
  created_at: number;
  updated_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  content?: string | null;
  reasoning?: string | null;
  error?: string | null;
  work_context?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  artifact?: ManagedAgentArtifact | null;
  steps: ManagedAgentStep[];
}

export interface GgufMeta {
  architecture: string;
  context_length: number;
  context_length_source?: string;
  parameter_count: number;
  block_count: number;
  size_label: string;
  quantization: string;
  head_count: number;
  head_count_kv: number;
  embedding_length: number;
  file_size_bytes: number;
  quantization_name: string;
  chat_template_uses_tools: boolean;
}

export interface LocalModel {
  id: string;
  name: string;
  path: string;
  size_gb: number;
  modified: number;
  architecture?: string;
  parameter_count?: number;
  size_label?: string;
  quantization_name?: string;
  context_length?: number;
  block_count?: number;
  chat_template_uses_tools?: boolean;
}

export interface CachedModelMeta {
  id: string;
  name: string;
  path: string;
  size_gb: number;
  modified_time: number;
  architecture?: string;
  context_length?: number;
  parameter_count?: number;
  size_label?: string;
  quantization_name?: string;
  block_count?: number;
  head_count?: number;
  embedding_length?: number;
  chat_template_uses_tools?: boolean;
  indexed_at: number;
  cache_key: string;
}

export interface DownloadJob {
  id: string;
  kind: string;
  model_id: string;
  repo_id: string;
  file: string;
  url: string;
  dest_path: string;
  total_bytes: number;
  downloaded_bytes: number;
  progress: number;
  status: string;
  error?: string | null;
  timestamp: number;
  label: string;
  etag?: string | null;
  last_modified?: string | null;
  expected_sha256?: string | null;
  verified: boolean;
}

export type SupervisorState = 'idle' | 'starting' | 'ready' | 'loading_model' | 'model_ready' | 'stopping' | 'error';

export interface ModelSession {
  id: string;
  model_id: string;
  model_path: string;
  port: number;
  is_embedding: boolean;
}

export interface SupervisorStatus {
  state: SupervisorState | { Error: string } | string;
  active_model?: string | null;
  port?: number | null;
  uptime_secs?: number | null;
  memory_mb?: number | null;
  sessions_count: number;
}

export interface SupervisorEvent {
  type: string;
  from?: string;
  to?: string;
  model_id?: string;
  progress?: number;
  phase?: string;
  port?: number;
  message?: string;
  recoverable?: boolean;
  status?: string;
  latency_ms?: number;
}

export interface RecommendedSettings {
  context_length: number;
  gpu_layers: number;
  backend?: string;
  selected_device?: string | null;
  available_backends?: string[];
  batch_size: number;
  ubatch_size: number;
  cpu_threads: number;
  flash_attention: boolean;
  offload_kv: boolean;
  use_mmap: boolean;
  estimated_memory_gb: number;
  fits_in_vram: boolean;
  warnings: string[];
}

export interface LlamaConfig {
  model_path: string;
  backend_mode?: string;
  host?: string;
  port?: number;
  context_length?: number;
  gpu_offload?: number;
  cpu_threads?: number;
  batch_size?: number;
  flash_attention?: boolean;
  offload_kv_cache?: boolean;
  keep_in_memory?: boolean;
  mmap?: boolean;
  seed?: number;
  rope_freq_base?: number;
  rope_freq_scale?: number;
  parallel?: number;
  cache_type_k?: string;
  cache_type_v?: string;
  runtime_path?: string;
  mmproj_path?: string;
}

export interface RagChunk {
  id: string;
  doc_id: string;
  text: string;
  index: number;
}

export interface IndexedDocument {
  id: string;
  source: string;
  file_type: string;
  chunk_count: number;
  char_count: number;
}

export interface WorkspaceIndexedFile {
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'ready' | 'skipped' | 'error';
  doc_id?: string;
  reason?: string;
}

export interface WorkspaceIndexResult {
  root_path: string;
  root_name: string;
  file_count: number;
  indexed_count: number;
  skipped_count: number;
  files: WorkspaceIndexedFile[];
}

export interface RetrievalResult {
  chunk: RagChunk;
  score: number;
}

export interface QueryResponse {
  results: RetrievalResult[];
  context: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider?: string;
  providers?: string[];
  score?: number;
  source_rank?: number;
  full_content?: string;
  published_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  context: string;
  provider_used: string;
  search_mode?: 'search' | 'deep' | 'max';
  error?: string;
  error_type?: string;
  retryable?: boolean;
}

export interface SearchOptions {
  provider?: string;
  max_results?: number;
  context_budget_chars?: number;
  google_cse_api_key?: string;
  google_cse_id?: string;
  brave_api_key?: string;
  serpapi_api_key?: string;
  tavily_api_key?: string;
  exa_api_key?: string;
  searxng_base_url?: string;
  bing_api_key?: string;
  bing_endpoint?: string;
  serper_api_key?: string;
  jina_api_key?: string;
  jina_base_url?: string;
  youcom_api_key?: string;
  perplexity_api_key?: string;
  perplexity_model?: string;
  perplexity_api_url?: string;
}

export interface SlideData {
  title: string;
  content: string[];
  notes?: string | null;
  layout: string;
}

export interface PresentationData {
  title: string;
  slides: SlideData[];
}

export interface TtsRequest {
  text: string;
  voice: string;
  speed: number;
  engine: 'kokoro' | 'wasm';
  model_path: string;
  voices_path: string;
  tokens_path: string;
  lexicon_path?: string;
  dict_dir?: string;
  data_dir?: string;
}

export interface SandboxExecResult {
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code?: number | null;
  timed_out: boolean;
  files: Record<string, string>;
}
