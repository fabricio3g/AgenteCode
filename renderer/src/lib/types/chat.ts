import type { IndexedDocument, SearchResult, SlideData } from '$lib/types/tauri';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  preview?: string;
  base64?: string;   // data: URL for images used in vision API calls
  data?: string;     // Blob URL or data URL for document content (for inline preview)
  kind?: 'image' | 'document';
  status?: 'ready' | 'processing' | 'error';
  docId?: string;
  ocrText?: string;  // Extracted text from OCR (images, scanned PDFs)
  processingMode?: 'vision' | 'ocr' | 'document_text';
  visionReady?: boolean;
  error?: string;
}

export interface MessageVersion {
  content: string;
  reasoning?: string;
  createdAt: number;
  metadata?: {
    modelName?: string;
    tokens?: number;
    timing?: number;
    tokensPerSecond?: number;
    modelTimingSeconds?: number;
    totalElapsedSeconds?: number;
    reasoningTimingSeconds?: number;
    usageSource?: 'provider' | 'runtime' | 'estimated' | 'none';
    timingScope?: 'model' | 'agent_wall' | 'reasoning' | 'unknown';
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    promptEvalTimingSeconds?: number;
    executionBackend?: 'local' | 'api';
    executionTransport?: 'local_runtime' | 'provider_ipc' | 'sdk';
    error?: boolean;
    errorMessage?: string;
    warning?: string;
    outcome?: AgentOutcome;
    stopReason?: AgentStopReason;
    currentActivity?: AgentActivity;
    activityLabel?: string;
    publicFallback?: boolean;
    diagnosticsRedacted?: boolean;
    documentSurface?: { kind: 'report' | 'documents'; title?: string; primaryFile?: string };
    workProduct?: { id: string; kind: WorkProductKind; title: string; primaryFile?: string; status?: WorkProductStatus };
  };
}

export type AgentOutcome = 'completed' | 'partial' | 'stopped' | 'failed';
export type AgentStopReason = 'timeout' | 'loop' | 'tool_limit' | 'iteration_limit' | 'missing_artifacts' | 'error' | 'none';
export type AgentActivity = 'planning' | 'searching' | 'reading' | 'creating_files' | 'writing' | 'stopped' | 'completed';

export interface SearchMeta {
  searchRequested: boolean;
  searchSucceeded: boolean;
  contextAvailable: boolean;
  sourceCount: number;
  requestedProvider?: string | null;
  providerUsed?: string | null;
  searchFallbackReason?: string;
  providerWarnings?: string[];
  searchError?: string;
  researchTaskId?: string | null;
  researchStatus?: 'queued' | 'awaiting_input' | 'searching' | 'crawling' | 'synthesizing' | 'completed' | 'failed' | 'cancelled' | null;
  researchSummary?: string | null;
  researchStats?: {
    pagesCrawled?: number;
    pagesDiscovered?: number;
    maxDepthReached?: number;
    truncated?: boolean;
  } | null;
  providerAttempts?: Array<{ provider: string; success: boolean; resultCount: number; error?: string }>;
  scrapeStats?: { attempted: number; success: number; blocked: number; thinContent: number };
  stopReason?: AgentStopReason;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'ready' | 'skipped' | 'error';
  docId?: string;
  reason?: string;
}

export interface WorkspaceContext {
  rootName: string;
  rootPath?: string;
  attachedAt: number;
  fileCount: number;
  indexedCount: number;
  skippedCount: number;
  files: WorkspaceFile[];
}

export interface WorkContextMeta {
  rootName: string;
  fileCount: number;
  indexedCount: number;
}

export interface AgentStep {
  id: string;
  type: 'thinking' | 'planning' | 'searching' | 'reading' | 'coding' | 'writing' | 'executing' | 'preview' | 'tool' | 'approval' | 'done' | 'error';
  label: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'done' | 'error';
  detail?: string;
  output?: string;
  fileChanges?: CodeAgentFileChange[];
  diffStats?: CodeAgentDiffStat[];
}

export type ChartArtifactPayload = {
  kind: 'chart';
  title: string;
  chartType: 'bar' | 'line' | 'pie' | 'donut';
  labels: string[];
  datasets: Array<{ label: string; data: number[] }>;
};

export type MapArtifactPayload = {
  kind: 'map';
  title: string;
  latitude: number;
  longitude: number;
  zoom: number;
  markers: Array<{ lat?: number; lng?: number; label?: string; popup?: string }>;
  polylines: Array<{ coords?: Array<{ lat?: number; lng?: number }>; color?: string; weight?: number; label?: string } | Array<{ lat?: number; lng?: number }>>;
};

export type DiagramArtifactPayload = {
  kind: 'diagram';
  title: string;
  diagramType?: string;
  source: string;
};

export type DashboardArtifactPayload = {
  kind: 'dashboard';
  title: string;
  subtitle?: string;
  metrics: Array<{ label?: string; value?: string | number; trend?: string; unit?: string; color?: string }>;
  sections: Array<{ heading?: string; content?: string }>;
};

/** Weather / status / short fact packs — chart-style in-chat card. */
export type InfoCardArtifactPayload = {
  kind: 'info_card';
  title: string;
  subtitle?: string;
  rows: Array<{ label: string; value: string; hint?: string }>;
  footer?: string;
  accent?: string;
};

/** Small self-contained HTML snippet rendered in chat (no CDN / network). */
export type HtmlCardArtifactPayload = {
  kind: 'html_card';
  title: string;
  html: string;
};

export type InlineArtifactPayload =
  | ChartArtifactPayload
  | MapArtifactPayload
  | DiagramArtifactPayload
  | DashboardArtifactPayload
  | InfoCardArtifactPayload
  | HtmlCardArtifactPayload;

export type ArtifactKind =
  | 'report'
  | 'work_product'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'chart'
  | 'diagram'
  | 'map'
  | 'dashboard'
  | 'info_card'
  | 'html_card'
  | 'research_package'
  | 'web'
  | 'files';

export type ArtifactPresentation = 'inline' | 'document' | 'web' | 'files';
export type ArtifactStatus = 'ready' | 'partial' | 'invalid';
export type ArtifactIssueSeverity = 'warning' | 'error';

export interface ArtifactIssue {
  code: string;
  severity: ArtifactIssueSeverity;
  message: string;
  path?: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  kind: ArtifactKind;
  presentation: ArtifactPresentation;
  entryPath?: string;
  status: ArtifactStatus;
  issues?: ArtifactIssue[];
}

export interface AgentArtifact {
  title: string;
  files: Record<string, string>;
  previewHtml?: string | null;
  inline?: InlineArtifactPayload | null;
  workProduct?: GeneratedWorkProduct | null;
  /** Additive metadata for deterministic rendering. Missing manifests are normalized lazily. */
  manifest?: ArtifactManifest | null;
}

export type WorkProductKind = 'report' | 'documents' | 'spreadsheet' | 'presentation' | 'bundle';
export type WorkProductStatus = 'creating' | 'ready' | 'partial' | 'failed';

export type CodeAgentDriverKind = 'chatea' | 'chatea-agent' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'pi';
export type CodeAgentInstanceId = string;
export type CodeAgentProviderId = CodeAgentInstanceId;
export type CodeAgentProviderStatus = 'ready' | 'missing' | 'login' | 'soon' | 'disabled';
export type CodeAgentRuntimeMode = 'full' | 'supervised';

export interface CodeAgentProvider {
  id: CodeAgentInstanceId;
  instanceId?: CodeAgentInstanceId;
  driverKind: CodeAgentDriverKind;
  label: string;
  driver: string;
  detail: string;
  status: CodeAgentProviderStatus;
  enabled?: boolean;
  accentColor?: string;
}

export interface CodeAgentDriver {
  driverKind: CodeAgentDriverKind;
  displayName: string;
  detail: string;
  supportsMultipleInstances?: boolean;
}

export interface CodeAgentInstance {
  id: CodeAgentInstanceId;
  driverKind: CodeAgentDriverKind;
  displayName: string;
  detail: string;
  enabled: boolean;
  status: CodeAgentProviderStatus;
  config?: unknown;
  environment?: Array<{ name: string; value: string; sensitive?: boolean }>;
  accentColor?: string;
}

export interface CodeAgentSessionMeta {
  instanceId: CodeAgentInstanceId;
  driverKind?: CodeAgentDriverKind;
  providerId?: CodeAgentProviderId;
  status?: CodeAgentProviderStatus;
  runtimeMode?: CodeAgentRuntimeMode;
  substrate?: 'native' | 'pi';
  sessionId?: string;
  checkpointsEnabled?: boolean;
  updatedAt: number;
}

export type CodeAgentFileChangeKind = 'created' | 'modified' | 'deleted';

export interface CodeAgentFileChange {
  path: string;
  kind: CodeAgentFileChangeKind;
}

export interface CodeAgentDiffStat {
  path: string;
  kind: CodeAgentFileChangeKind;
  additions: number;
  deletions: number;
  before?: string;
  after?: string;
}

export interface GeneratedWorkProductFile {
  path: string;
  title?: string;
  mime?: string;
  kind?: 'markdown' | 'html' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'csv' | 'text';
  previewPath?: string;
}

export interface GeneratedWorkProduct {
  id: string;
  title: string;
  kind: WorkProductKind;
  status: WorkProductStatus;
  files: GeneratedWorkProductFile[];
  sourceIds?: string[];
  evidenceMap?: Record<string, string[]>;
  warnings?: string[];
  createdAt: number;
}

export interface CreatedFile {
  path: string;
  name: string;
  fullPath?: string;
}

export interface TtsAudioMeta {
  duration: number;
  voice: string;
  generatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: number;
  model?: string;
  metadata?: MessageVersion['metadata'];
  done?: boolean;
  status?: 'idle' | 'streaming' | 'error';
  attachments?: Attachment[];
  versions?: MessageVersion[];
  activeVersion?: number;
  sources?: SearchResult[];
  searchMeta?: SearchMeta | null;
  ragDocuments?: IndexedDocument[];
  searchMode?: 'chat' | 'search' | 'deep' | 'max';
  slides?: SlideData[];
  mode?: 'chat' | 'slides' | 'agent';
  agentSteps?: AgentStep[];
  /**
   * The last artifact the turn produced. Retained because chats persisted before
   * artifacts became a list only have this field, and much of the UI still asks for
   * a single artifact. Read through `artifactsForMessage` to get the full set.
   */
  artifact?: AgentArtifact | null;
  /** Every artifact the turn produced, oldest first. Absent on older messages. */
  artifacts?: AgentArtifact[];
  workContext?: WorkContextMeta | null;
  filesCreated?: CreatedFile[];
  ttsAudio?: TtsAudioMeta | null;
}

// ── Reasoning levels ───────────────────────────────────────────────────
// Surfaced by each provider's getReasoningCapabilities() — never guessed
// from model names in shared code. The UI only shows the selector when a
// provider returns `supported: true` with a known `source`.

export type ReasoningLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | 'xhigh'
  | 'enabled'
  | 'disabled'
  | 'on'
  | 'none'
  | 'default'; // Groq Qwen reasoning_effort

export type ReasoningParamShape =
  | 'openai_reasoning_effort'
  | 'anthropic_thinking'
  | 'gemini_thinking_budget'
  | 'mistral_reasoning_effort'
  | 'local_disable_thinking';

export interface ReasoningCapabilities {
  supported: boolean;
  levels: ReasoningLevel[];
  paramShape: ReasoningParamShape;
  source: 'sdk' | 'api' | 'metadata' | 'unknown';
}

export interface ReasoningRequest {
  level: ReasoningLevel;
  budgetTokens?: number;
}

export interface ChatFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export type ChatContextMode = 'chat' | 'work';

export interface CodeProject {
  id: string;
  rootPath: string;
  rootName: string;
  icon?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SessionComposerMode = 'chat' | 'agent';
export type SessionSearchMode = 'chat' | 'search' | 'deep' | 'max';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  draft: string;
  /** Immutable after create: chat | work | code space identity. */
  contextMode?: ChatContextMode;
  codeAgent?: CodeAgentSessionMeta | null;
  projectId?: string | null;
  workspace?: WorkspaceContext | null;
  reasoningLevel?: ReasoningLevel | null;
  /** Per-chat composer mode; isolated across sessions. */
  composerMode?: SessionComposerMode | null;
  /** Per-chat search depth mode; isolated across sessions. */
  searchMode?: SessionSearchMode | null;
  messages: ChatMessage[];
}

export interface ModelOption {
  id: string;
  name: string;
  source: 'local' | 'api';
  path?: string;
  details?: string;
  architecture?: string;
  context_length?: number;
  parameter_count?: number;
  size_label?: string;
  quantization_name?: string;
  block_count?: number;
  chat_template_uses_tools?: boolean;
  has_mmproj?: boolean;
}

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'mistral' | 'openai_compat' | 'local';

export interface ProviderConfig {
  base_url: string;
  api_key?: string;
  has_api_key?: boolean;
  model: string;
  type?: ProviderType | string;
  // Generation params (optional)
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  system_prompt?: string;
}

export interface AppConfig {
  llm?: {
    provider?: string;
    system_prompt?: string;
    user_prompt?: string;
    providers?: Record<string, ProviderConfig>;
    backend_mode?: 'local' | 'api';
    local?: {
      system_prompt?: string;
      base_url?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      selected_model_path?: string;
      runtime_path?: string;
      context_length?: number;
      gpu_layers?: number;
      cpu_threads?: number;
      batch_size?: number;
      flash_attention?: boolean;
      offload_kv_cache?: boolean;
      keep_in_memory?: boolean;
      mmap?: boolean;
      seed?: number | null;
      rope_freq_base?: number | null;
      rope_freq_scale?: number | null;
      parallel?: number | null;
      cache_type_k?: string;
      cache_type_v?: string;
      mmproj_path?: string;
      disable_thinking?: boolean;
      mtp?: boolean;
      mtp_draft_path?: string | null;
      mtp_draft_n_max?: number | null;
    };
  };
  search?: {
    provider?: string;
    max_results?: number;
    context_budget_chars?: number;
    aggregator_engines?: string[];
    safe_search?: number;
    providers?: {
      [provider: string]: Record<string, unknown> | undefined;
      google_cse?: {
        api_key?: string;
        engine_id?: string;
      };
      brave?: {
        api_key?: string;
      };
      serpapi?: {
        api_key?: string;
      };
      tavily?: {
        api_key?: string;
      };
      exa?: {
        api_key?: string;
      };
      searxng?: {
        base_url?: string;
      };
      bing?: {
        api_key?: string;
        endpoint?: string;
      };
      youcom?: {
        api_key?: string;
      };
      jina?: {
        api_key?: string;
        base_url?: string;
      };
      perplexity?: {
        api_key?: string;
        model?: string;
        api_url?: string;
      };
      serper?: {
        api_key?: string;
      };
    };
  };
  tts?: {
    enable_voice_output?: boolean;
    auto_play_voice?: boolean;
    voice?: string;
    speed?: number;
    volume?: number;
    engine?: 'kokoro' | 'wasm' | 'browser';
    model_path?: string;
    voices_path?: string;
    tokens_path?: string;
    lexicon_path?: string;
    dict_dir?: string;
    data_dir?: string;
    model_variant?: string;
  };
  stt?: {
    whisper_quality?: string;
    whisper_model_path?: string;
    runtime_path?: string;
    backend?: 'auto' | 'cpu' | 'cuda' | 'vulkan' | string;
    language?: string;
    enable_stt?: boolean;
    audio_input_device_id?: string;
  };
  ui?: {
    theme?: 'light' | 'dark';
    workspace_mode?: 'legacy' | 'modern';
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
    agent_debug_logs?: boolean;
    artifact_toggles?: Record<string, boolean>;
    /**
     * How Chat vs Agent is chosen:
     * - tabs: show Chat | Agent control in composer
     * - auto: hide tabs; route each message by intent
     */
    composer_mode_control?: 'tabs' | 'auto';
  };
  onboarding?: {
    completed?: boolean;
    completed_at?: number | null;
  };
}
