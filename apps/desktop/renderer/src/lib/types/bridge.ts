export interface HardwareInfo {
  total_ram_gb: number;
  free_ram_gb: number;
  physical_cores: number;
  cpu_threads: number;
  cpu_model: string;
  vram_gb: number;
  vram_estimated?: boolean;
  /** Live GPU memory in use, when the driver reports it. */
  vram_used_gb?: number | null;
  /** System memory the GPU can also borrow (integrated GPUs). */
  shared_gb?: number | null;
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
  /** Non-zero only on MoE architectures. */
  expert_count?: number;
  embedding_length: number;
  file_size_bytes: number;
  quantization_name: string;
  chat_template_uses_tools: boolean;
  chat_template_supports_thinking?: boolean;
  /** Where the effective template came from: gguf, sidecar, builtin, none. */
  chat_template_source?: string;
  /** Family id when a built-in fallback was applied. */
  chat_template_family?: string | null;
  has_mtp_layers?: boolean;
  is_mmproj?: boolean;
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
  /** hf_model: resumable model files. file: a one-off (engine, speech model). */
  kind: string;
  /** For the download manager's icon: chat, speech, voice or engine. */
  category?: 'chat' | 'speech' | 'voice' | 'engine';
  model_id: string;
  repo_id: string;
  file: string;
  /** Every file this job must fetch, in order — usually [file]; more for sharded GGUF. */
  files?: string[];
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
  /** Opt-in auto-load after completion. */
  load_when_ready?: boolean;
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
  model_path?: string | null;
  runtime_path?: string | null;
  port?: number | null;
  uptime_secs?: number | null;
  memory_mb?: number | null;
  sessions_count: number;
  /** Reported by the server via GET /props once it is up, not estimated. */
  n_ctx?: number | null;
  total_slots?: number | null;
  build_info?: string | null;
  load_phase?: string | null;
  load_progress?: number | null;
  /** Tail of the server's own log, populated when startup fails. */
  log_tail?: string[] | null;
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
  /**
   * Thinking default: 'auto' (omit --reasoning, server detects from the
   * template), 'off' (--reasoning off), 'on' (--reasoning on).
   */
  thinking_mode?: 'auto' | 'off' | 'on';
  /** Legacy equivalent of thinking_mode 'off'; still honored on read. */
  disable_thinking?: boolean;
  mtp?: boolean;
  mtp_draft_path?: string;
  mtp_draft_n_max?: number;
  /** Keep all MoE expert weights on the CPU. */
  cpu_moe?: boolean;
  /** Keep the experts of the first N layers on the CPU. Wins over `cpu_moe`. */
  n_cpu_moe?: number;
  /** Drop the oldest turns instead of erroring when the context fills. */
  context_shift?: boolean;
  /** Prompt cache budget in MiB, shared across conversations. */
  cache_ram_mb?: number;
  /** Minimum chunk size reused from the KV cache. */
  cache_reuse?: number;
  /** Full-size sliding-window attention cache. */
  swa_full?: boolean;
  split_mode?: string;
}

export interface RuntimeTelemetry {
  context_size: number | null;
  context_used: number | null;
  context_percent: number | null;
  slots_total: number;
  slots_busy: number;
  tokens_per_second: number | null;
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

/** How far the extracted text of a stored file has come. */
export type FileExtractStatus = 'pending' | 'extracting' | 'ready' | 'failed' | 'keyword-only';

/** A row of the global content-addressed store (`chat-db.ts` `files`). */
export interface StoredFile {
  hash: string;
  name: string;
  mime: string | null;
  bytes: number;
  kind: string;
  storedPath: string | null;
  createdAt: number;
  lastUsedAt: number;
  extractStatus: FileExtractStatus;
  extractedChars: number;
  ragDocId: string | null;
  pinned: boolean;
  origin: 'upload' | 'generated';
  /** Source spec of a generated document (Phase 4); null for uploads. */
  specPath: string | null;
  version: number;
}

/** One chat message that uses a stored file. */
export interface FileRef {
  hash: string;
  chatId: string;
  messageId: string;
}

export interface FileStoreStats {
  count: number;
  bytes: number;
  /** Never pinned and referenced by no chat — the cleanup candidates. */
  unusedCount: number;
  unusedBytes: number;
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
  effective_query?: string;
  results: SearchResult[];
  context: string;
  provider_used: string;
  search_mode?: 'search' | 'deep' | 'max';
  error?: string;
  error_type?: string;
  retryable?: boolean;
  provider_attempts?: Array<{ provider: string; success: boolean; resultCount: number; error?: string }>;
  engine_attempts?: Array<{ engine: string; success: boolean; result_count: number; latency_ms: number; error?: string; missing?: string[]; cooldown_until?: string; skipped?: boolean }>;
  aggregation_elapsed_ms?: number;
  aggregation_deadline_reached?: boolean;
}

export interface SearchOptions {
  [key: string]: unknown;
  provider?: string;
  max_results?: number;
  context_budget_chars?: number;
  aggregator_engines?: string[];
  safe_search?: number;
  conversation_context?: string;
  brave_api_key?: string;
  tavily_api_key?: string;
  exa_api_key?: string;
  searxng_base_url?: string;
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
  backend?: 'local' | 'api' | 'browser';
  provider?: string;
  text: string;
  voice: string;
  speed: number;
  /** The voice model (shared/voice-models.ts); the first downloaded one when unset. */
  model?: string;
  language?: string;
  /** A cloned voice: the reference clip and what it says. */
  voiceRef?: { file: string; transcript?: string };
}

export interface SandboxExecResult {
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code?: number | null;
  timed_out: boolean;
  files: Record<string, string>;
}
