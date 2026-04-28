import type { IndexedDocument, SearchResult, SlideData } from '$lib/types/tauri';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  preview?: string;
  base64?: string;   // data: URL for images used in vision API calls
  kind?: 'image' | 'document';
  status?: 'ready' | 'processing' | 'error';
  docId?: string;
  ocrText?: string;  // Extracted text from OCR (images, scanned PDFs)
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
    error?: boolean;
    errorMessage?: string;
    warning?: string;
  };
}

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
}

export interface AgentArtifact {
  title: string;
  files: Record<string, string>;
  previewHtml?: string | null;
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
  agentTaskId?: string | null;
  agentSteps?: AgentStep[];
  artifact?: AgentArtifact | null;
  workContext?: WorkContextMeta | null;
  filesCreated?: CreatedFile[];
  ttsAudio?: TtsAudioMeta | null;
}

export interface ChatFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  draft: string;
  contextMode?: 'chat' | 'work';
  workspace?: WorkspaceContext | null;
  messages: ChatMessage[];
}

export interface ModelOption {
  id: string;
  name: string;
  source: 'local' | 'api';
  path?: string;
  details?: string;
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
    };
  };
  search?: {
    provider?: string;
    max_results?: number;
    context_budget_chars?: number;
    providers?: {
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
    enable_stt?: boolean;
    audio_input_device_id?: string;
  };
  ui?: {
    theme?: 'light' | 'dark';
    workspace_mode?: 'legacy' | 'modern';
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
  };
  onboarding?: {
    completed?: boolean;
    completed_at?: number | null;
  };
}
