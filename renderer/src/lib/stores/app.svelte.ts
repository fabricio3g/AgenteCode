import type { AgentArtifact, AgentStep, AppConfig, Attachment, ChatFolder, ChatMessage, ChatSession, CreatedFile, MessageVersion, ModelOption, SearchMeta, WorkspaceContext, WorkspaceFile } from '$lib/types/chat';
import type { IndexedDocument, SearchResult } from '$lib/types/tauri';
import { runAgentTask } from '$lib/services/agent';
import { startManagedAgentTask, updateManagedAgentTask, cancelManagedAgentTask } from '$lib/services/agent-runtime';
import { parseSlidesFromMarkdown } from '$lib/services/slides';
import { writeTempFile, pathExists, pickWorkspaceFolder as pickWorkspaceFolderDialog, indexWorkspaceFolder, writeWorkspaceFile, createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, openWorkspaceFile, createWorkspaceFolder } from '$lib/services/files';
import { clearRagDocuments, ingestDocument, ingestText, listRagDocuments, queryDocuments, removeRagDocument } from '$lib/services/rag';
import { webSearch, ingestSearchContext } from '$lib/services/search';
import { getRecommendedSettings, loadLocalModel, stopLlama } from '$lib/services/runtime';
import { isTauri } from '$lib/services/tauri';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { deepResearchStore } from '$lib/stores/deep-research.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { RequestMessage } from '$lib/services/chat-api';
import { completeAssistantReply, fetchModels, loadChatConfig, streamAssistantReply } from '$lib/services/chat-api';
import { loadChatState, saveChatState, saveAppConfig } from '$lib/utils/storage';

interface PersistedState {
  chats: ChatSession[];
  folders: ChatFolder[];
  currentChatId: string | null;
}

const LOCAL_MODEL_SETTINGS_KEY = 'talamolm_model_load_settings_by_model';
const USER_NAME_KEY = 'talamolm_user_name';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function createId(prefix: string) {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const WORKSPACE_IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  'target'
]);

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsonl',
  'jsx', 'log', 'md', 'mjs', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'toml', 'ts', 'tsx',
  'txt', 'xml', 'yaml', 'yml'
]);

const WORKSPACE_MAX_FILES = 120;
const WORKSPACE_MAX_FILE_SIZE_BYTES = 512 * 1024;
const WORKSPACE_MAX_TEXT_CHARS = 120_000;

function getWorkspacePath(file: File) {
  return file.webkitRelativePath || file.name;
}

function shouldIgnoreWorkspacePath(relativePath: string) {
  const segments = relativePath.split('/').filter(Boolean);
  return segments.some((segment) => WORKSPACE_IGNORED_SEGMENTS.has(segment));
}

function getWorkspaceExtension(relativePath: string) {
  const match = relativePath.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || 'text';
}

function isSupportedWorkspaceFile(relativePath: string) {
  return WORKSPACE_TEXT_EXTENSIONS.has(getWorkspaceExtension(relativePath));
}

function trimWorkspaceText(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= WORKSPACE_MAX_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, WORKSPACE_MAX_TEXT_CHARS)}\n\n[truncated]`;
}

function buildWorkspacePrompt(workspace: WorkspaceContext) {
  const visibleFiles = workspace.files
    .filter((file) => file.status === 'ready')
    .slice(0, 80)
    .map((file) => `- ${file.path}`);

  const summary = [
    `Root: ${workspace.rootName}`,
    `Indexed files: ${workspace.indexedCount}`,
    `Skipped files: ${workspace.skippedCount}`
  ].join('\n');

  return `${summary}\nFiles:\n${visibleFiles.join('\n')}`;
}

/**
 * Parse <write_file path="...">content</write_file> blocks from an LLM response.
 * Returns an array of {path, content} objects.
 */
function parseWriteFileBlocks(text: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  // Match <write_file path="...">...</write_file> — allow newlines inside
  const re = /<write_file\s+path="([^"]+)"\s*>([\s\S]*?)<\/write_file>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const path = match[1].trim();
    const content = match[2];
    // Strip leading/trailing newline that the model typically adds
    const cleanContent = content.replace(/^\n/, '').replace(/\n$/, '');
    if (path) results.push({ path, content: cleanContent });
  }
  return results;
}

/**
 * Strip <write_file> blocks from the visible message content
 * and replace them with a brief inline note.
 */
function stripWriteFileBlocks(text: string, created: Array<{ path: string }>): string {
  if (!created.length) return text;
  let cleaned = text.replace(/<write_file\s+path="[^"]+"\s*>[\s\S]*?<\/write_file>/g, '').trim();
  // Remove double blank lines left behind
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function recalculateWorkspace(workspace: WorkspaceContext): WorkspaceContext {
  const indexedCount = workspace.files.filter((file) => file.status === 'ready' && !!file.docId).length;
  const skippedCount = workspace.files.length - indexedCount;
  return {
    ...workspace,
    fileCount: workspace.files.length,
    indexedCount,
    skippedCount
  };
}

function readRememberedLocalModelSettings(): Record<string, Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(LOCAL_MODEL_SETTINGS_KEY) || '{}';
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRememberedLocalModelSettings(store: Record<string, Record<string, unknown>>) {
  try {
    localStorage.setItem(LOCAL_MODEL_SETTINGS_KEY, JSON.stringify(store));
  } catch {
    // ignore local storage failures
  }
}

function getAssistantActiveVersion(message: Partial<ChatMessage>): MessageVersion | null {
  if (!Array.isArray(message.versions) || !message.versions.length) return null;
  const index = typeof message.activeVersion === 'number'
    ? Math.max(0, Math.min(message.activeVersion, message.versions.length - 1))
    : 0;
  return message.versions[index] || message.versions[0] || null;
}

function getMessageRequestContent(message: Partial<ChatMessage>) {
  if (message.role === 'assistant') {
    return getAssistantActiveVersion(message)?.content || String(message.content || '');
  }
  return String(message.content || '');
}

function buildRequestMessagesFromHistory(messages: ChatMessage[], upToIndex = messages.length - 1): RequestMessage[] {
  const endIndex = Math.max(-1, Math.min(upToIndex, messages.length - 1));
  const outbound: RequestMessage[] = [];
  for (let index = 0; index <= endIndex; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const content = getMessageRequestContent(message).trim();
    if (!content) continue;
    outbound.push({
      role: message.role,
      content
    });
  }
  return outbound;
}

function resolveLegacySearchMode(message: Partial<ChatMessage>): ChatMessage['searchMode'] {
  if (message.searchMode) return message.searchMode;
  const legacy = message as Partial<ChatMessage> & { searchDeep?: boolean; searchSources?: unknown[] };
  if (legacy.searchDeep) return 'deep';
  if (Array.isArray(legacy.searchSources) && legacy.searchSources.length) return 'search';
  return 'chat';
}

function normalizeMessage(message: Partial<ChatMessage>, index: number): ChatMessage {
  return {
    id: String(message.id || createId(`msg-${index}`)),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content || ''),
    reasoning: message.reasoning,
    createdAt: Number.isFinite(message.createdAt) ? Number(message.createdAt) : Date.now(),
    model: message.model,
    metadata: message.metadata,
    done: message.done ?? true,
    status: message.status || 'idle',
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    versions: Array.isArray(message.versions) ? message.versions : [],
    activeVersion: typeof message.activeVersion === 'number' ? message.activeVersion : 0,
    sources: Array.isArray(message.sources)
      ? message.sources
      : Array.isArray((message as Partial<ChatMessage> & { searchSources?: ChatMessage['sources'] }).searchSources)
        ? ((message as Partial<ChatMessage> & { searchSources?: ChatMessage['sources'] }).searchSources || [])
        : [],
    searchMeta: (message as Partial<ChatMessage> & { searchMeta?: SearchMeta | null }).searchMeta || null,
    ragDocuments: Array.isArray(message.ragDocuments) ? message.ragDocuments : [],
    searchMode: resolveLegacySearchMode(message),
    slides: Array.isArray(message.slides) ? message.slides : [],
    mode: message.mode || (((message as Partial<ChatMessage> & { agent?: boolean }).agent) ? 'agent' : 'chat'),
    agentTaskId: message.agentTaskId || null,
    agentSteps: Array.isArray(message.agentSteps) ? message.agentSteps : [],
    artifact: message.artifact || null,
    workContext: message.workContext || null
  };
}

function normalizeChat(chat: Partial<ChatSession>, index: number): ChatSession {
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map((message, messageIndex) => normalizeMessage(message, messageIndex))
    : [];

  return {
    id: String(chat.id || createId(`chat-${index}`)),
    title: String(chat.title || 'New chat'),
    createdAt: Number.isFinite(chat.createdAt) ? Number(chat.createdAt) : Date.now(),
    updatedAt: Number.isFinite(chat.updatedAt) ? Number(chat.updatedAt) : Date.now(),
    folderId: chat.folderId ?? null,
    draft: String(chat.draft || ''),
    contextMode: chat.contextMode === 'work' ? 'work' : 'chat',
    workspace: chat.workspace || null,
    messages
  };
}

function normalizeFolder(folder: Partial<ChatFolder>, index: number): ChatFolder {
  return {
    id: String(folder.id || createId(`folder-${index}`)),
    name: String(folder.name || 'Folder'),
    parentId: folder.parentId ?? null,
    createdAt: Number.isFinite(folder.createdAt) ? Number(folder.createdAt) : Date.now()
  };
}

class AppStore {
  ready = $state(false);
  config = $state<AppConfig>({});
  chats = $state<ChatSession[]>([]);
  folders = $state<ChatFolder[]>([]);
  currentChatId = $state<string | null>(null);
  composer = $state('');
  models = $state<ModelOption[]>([]);
  modelMenuOpen = $state(false);
  settingsOpen = $state(false);
  promptConfigOpen = $state(false);
  modelManagerOpen = $state(false);
  modelManagerOpenModelId = $state<string | null>(null);
  modelManagerOpenSection = $state<string | null>(null);
  runtimeManagerOpen = $state(false);
  agentWorkspaceOpen = $state(false);
  sandboxOpen = $state(false);
  llmDrawerOpen = $state(false);
  sidebarOpen = $state(true);
  chatSearchOpen = $state(false);
  searchSidebarOpen = $state(false);
  searchResults = $state<SearchResult[]>([]);
  searchLoading = $state(false);
  downloadsOpen = $state(false);
  voiceModeActive = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  abortController = $state<AbortController | null>(null);
  editingMessageId = $state<string | null>(null);
  editingMessageContent = $state('');
  searchMode = $state<'chat' | 'search' | 'deep' | 'max'>('chat');
  composerMode = $state<'chat' | 'slides' | 'agent'>('chat');
  pendingAttachments = $state<Attachment[]>([]);
  workspaceIndexing = $state(false);
  ragDocumentsByChat = $state<Record<string, IndexedDocument[]>>({});
  currentArtifact = $state<AgentArtifact | null>(null);
  currentArtifactMessageId = $state<string | null>(null);
  activeManagedAgentTaskId = $state<string | null>(null);
  localModelLoadTarget = $state<({ id: string; name: string; path?: string; details?: string; context_length?: number }) | null>(null);
  localModelLoadContextLength = $state('4096');
  localModelLoadGpuLayers = $state('0');
  localModelLoadCpuThreads = $state('4');
  localModelLoadBatchSize = $state('512');
  localModelLoadRuntimePath = $state('');
  localModelLoadFlashAttention = $state(true);
  localModelLoadOffloadKvCache = $state(true);
  localModelLoadKeepInMemory = $state(true);
  localModelLoadMmap = $state(true);
  localModelLoadSeed = $state('');
  localModelLoadParallel = $state('1');
  localModelLoadRopeFreqBase = $state('');
  localModelLoadRopeFreqScale = $state('');
  localModelLoadCacheTypeK = $state('f16');
  localModelLoadCacheTypeV = $state('f16');
  localModelLoadMmprojPath = $state('');
  localModelRememberSettings = $state(false);
  localModelLoadProgress = $state(0);
  localModelLoadPhase = $state('');
  localModelLoading = $state(false);
  localModelActive = $state<{ name: string; path: string; hasMmproj: boolean } | null>(null);
  userName = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem(USER_NAME_KEY) || '') : '');
  private closeWorkFingerprint = '';

  get currentChat() {
    return this.chats.find((chat) => chat.id === this.currentChatId) || null;
  }

  get activeProviderName() {
    return this.config.llm?.provider || 'openai';
  }

  get backendMode() {
    return this.config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
  }

  get activeProvider() {
    return this.config.llm?.providers?.[this.activeProviderName] || null;
  }

  get activeModelLabel() {
    if (this.backendMode === 'local') {
      return this.config.llm?.local?.model || 'No model';
    }
    return this.activeProvider?.model || 'No model';
  }

  get hasActiveWork() {
    return this.loading || this.localModelLoading || downloadsStore.hasActive;
  }

  get activeWorkReasons() {
    const reasons: string[] = [];
    if (this.loading) reasons.push('chat generation');
    if (this.localModelLoading) reasons.push('model loading');
    if (downloadsStore.hasActive) reasons.push('downloads');
    return reasons;
  }

  async syncWindowActiveWork() {
    if (!isTauri() || typeof window === 'undefined' || !window.electronAPI?.windowSetActiveWork) return;
    const payload = {
      active: this.hasActiveWork,
      reasons: this.activeWorkReasons
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === this.closeWorkFingerprint) return;
    this.closeWorkFingerprint = fingerprint;
    try {
      await window.electronAPI.windowSetActiveWork(payload.active, payload.reasons);
    } catch {
      // no-op for close guard sync failures
    }
  }

  get selectedLocalModelPath() {
    return this.config.llm?.local?.selected_model_path || '';
  }

  get workspaceMode() {
    return this.config.ui?.workspace_mode || 'modern';
  }

  get currentContextMode() {
    return this.currentChat?.contextMode || 'chat';
  }

  get currentWorkspace() {
    return this.currentChat?.workspace || null;
  }

  get currentRagDocuments() {
    if (!this.currentChatId) return [];
    return this.ragDocumentsByChat[this.currentChatId] || [];
  }

  private syncArtifactState(artifact: AgentArtifact | null, messageId: string | null = this.currentArtifactMessageId, open = this.sandboxOpen) {
    this.currentArtifact = artifact;
    this.currentArtifactMessageId = artifact ? messageId : null;

    if (messageId && this.currentChat) {
      const index = this.currentChat.messages.findIndex((message) => message.id === messageId);
      if (index >= 0) {
        this.currentChat.messages[index] = {
          ...this.currentChat.messages[index],
          artifact
        };
      }
      this.touchChats();
      this.persist();
    }

    this.sandboxOpen = artifact ? open : false;
  }

  openArtifact(artifact: AgentArtifact | null, messageId: string | null = null) {
    if (!artifact) return;
    this.syncArtifactState(artifact, messageId, true);
  }

  setCurrentArtifact(artifact: AgentArtifact | null, messageId: string | null = this.currentArtifactMessageId, open = this.sandboxOpen) {
    this.syncArtifactState(artifact, messageId, open);
  }

  async openLocalModelLoadDialog(model: { id: string; name: string; path?: string; details?: string; context_length?: number }) {
    if (!model.path) return;
    this.localModelLoadTarget = model;
    this.localModelLoadRuntimePath = this.config.llm?.local?.runtime_path || '';
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
    // Auto-detect mmproj in same folder
    this.localModelLoadMmprojPath = '';
    this.localModelLoadMmprojPath = await this.detectMmprojForModel(model.path);
    const remembered = readRememberedLocalModelSettings()[model.id] || {};
    try {
      const settings = await getRecommendedSettings(
        model.path,
        this.config.llm?.local?.context_length,
        this.config.llm?.local?.gpu_layers
      );
      this.localModelLoadContextLength = String(Number(remembered.context_length || this.config.llm?.local?.context_length || settings.context_length || model.context_length || 4096));
      this.localModelLoadGpuLayers = String(Number(remembered.gpu_offload || this.config.llm?.local?.gpu_layers || settings.gpu_layers || 0));
      this.localModelLoadCpuThreads = String(Number(remembered.cpu_threads || this.config.llm?.local?.cpu_threads || settings.cpu_threads || navigator.hardwareConcurrency || 4));
      this.localModelLoadBatchSize = String(Number(remembered.batch_size || this.config.llm?.local?.batch_size || settings.batch_size || 512));
      this.localModelLoadFlashAttention = remembered.flash_attention != null ? Boolean(remembered.flash_attention) : (this.config.llm?.local?.flash_attention ?? settings.flash_attention ?? true);
      this.localModelLoadOffloadKvCache = remembered.offload_kv_cache != null ? Boolean(remembered.offload_kv_cache) : (this.config.llm?.local?.offload_kv_cache ?? settings.offload_kv ?? true);
      this.localModelLoadKeepInMemory = remembered.keep_in_memory != null ? Boolean(remembered.keep_in_memory) : (this.config.llm?.local?.keep_in_memory ?? true);
      this.localModelLoadMmap = remembered.mmap != null ? Boolean(remembered.mmap) : (this.config.llm?.local?.mmap ?? settings.use_mmap ?? true);
      this.localModelLoadSeed = remembered.seed != null ? String(remembered.seed) : String(this.config.llm?.local?.seed || '');
      this.localModelLoadParallel = String(Number(remembered.parallel || this.config.llm?.local?.parallel || 1));
      this.localModelLoadRopeFreqBase = remembered.rope_freq_base != null ? String(remembered.rope_freq_base) : String(this.config.llm?.local?.rope_freq_base || '');
      this.localModelLoadRopeFreqScale = remembered.rope_freq_scale != null ? String(remembered.rope_freq_scale) : String(this.config.llm?.local?.rope_freq_scale || '');
      this.localModelLoadCacheTypeK = String(remembered.cache_type_k || this.config.llm?.local?.cache_type_k || 'f16');
      this.localModelLoadCacheTypeV = String(remembered.cache_type_v || this.config.llm?.local?.cache_type_v || 'f16');
      this.localModelRememberSettings = Object.keys(remembered).length > 0;
    } catch {
      this.localModelLoadContextLength = String(Number(remembered.context_length || this.config.llm?.local?.context_length || model.context_length || 4096));
      this.localModelLoadGpuLayers = String(Number(remembered.gpu_offload || this.config.llm?.local?.gpu_layers || 0));
      this.localModelLoadCpuThreads = String(Number(remembered.cpu_threads || this.config.llm?.local?.cpu_threads || navigator.hardwareConcurrency || 4));
      this.localModelLoadBatchSize = String(Number(remembered.batch_size || this.config.llm?.local?.batch_size || 512));
      this.localModelLoadFlashAttention = remembered.flash_attention != null ? Boolean(remembered.flash_attention) : (this.config.llm?.local?.flash_attention ?? true);
      this.localModelLoadOffloadKvCache = remembered.offload_kv_cache != null ? Boolean(remembered.offload_kv_cache) : (this.config.llm?.local?.offload_kv_cache ?? true);
      this.localModelLoadKeepInMemory = remembered.keep_in_memory != null ? Boolean(remembered.keep_in_memory) : (this.config.llm?.local?.keep_in_memory ?? true);
      this.localModelLoadMmap = remembered.mmap != null ? Boolean(remembered.mmap) : (this.config.llm?.local?.mmap ?? true);
      this.localModelLoadSeed = remembered.seed != null ? String(remembered.seed) : String(this.config.llm?.local?.seed || '');
      this.localModelLoadParallel = String(Number(remembered.parallel || this.config.llm?.local?.parallel || 1));
      this.localModelLoadRopeFreqBase = remembered.rope_freq_base != null ? String(remembered.rope_freq_base) : String(this.config.llm?.local?.rope_freq_base || '');
      this.localModelLoadRopeFreqScale = remembered.rope_freq_scale != null ? String(remembered.rope_freq_scale) : String(this.config.llm?.local?.rope_freq_scale || '');
      this.localModelLoadCacheTypeK = String(remembered.cache_type_k || this.config.llm?.local?.cache_type_k || 'f16');
      this.localModelLoadCacheTypeV = String(remembered.cache_type_v || this.config.llm?.local?.cache_type_v || 'f16');
      this.localModelRememberSettings = Object.keys(remembered).length > 0;
    }
  }

  closeLocalModelLoadDialog() {
    this.localModelLoadTarget = null;
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
  }

  async detectMmprojForModel(modelPath: string): Promise<string> {
    if (!modelPath) return '';
    const dir = modelPath.replace(/[/\\][^/\\]+$/, '');
    const candidates = ['mmproj-BF16.gguf', 'mmproj-F16.gguf', 'mmproj-F32.gguf'];
    for (const name of candidates) {
      const sep = modelPath.includes('\\') ? '\\' : '/';
      const fullPath = `${dir}${sep}${name}`;
      try {
        const exists = await pathExists(fullPath);
        if (exists) return fullPath;
      } catch { /* ignore */ }
    }
    return '';
  }

  async confirmLocalModelLoad() {
    if (!this.localModelLoadTarget?.path) return;
    this.localModelLoading = true;
    this.localModelLoadProgress = 5;
    this.localModelLoadPhase = 'Preparing load configuration';
    try {
      // Re-detect mmproj in case it wasn't found during dialog open
      if (!this.localModelLoadMmprojPath && this.localModelLoadTarget.path) {
        this.localModelLoadMmprojPath = await this.detectMmprojForModel(this.localModelLoadTarget.path);
      }
      await this.setBackendMode('local');
      this.localModelLoadProgress = 12;
      this.localModelLoadPhase = 'Saving local model selection';
      await this.updateLocalModel({
        id: this.localModelLoadTarget.id,
        name: this.localModelLoadTarget.name,
        path: this.localModelLoadTarget.path,
        source: 'local',
        details: this.localModelLoadTarget.details
      });
      await this.updateLocalSettings({
        context_length: this.localModelLoadContextLength ? Number(this.localModelLoadContextLength) : undefined,
        gpu_layers: this.localModelLoadGpuLayers ? Number(this.localModelLoadGpuLayers) : undefined,
        cpu_threads: this.localModelLoadCpuThreads ? Number(this.localModelLoadCpuThreads) : undefined,
        batch_size: this.localModelLoadBatchSize ? Number(this.localModelLoadBatchSize) : undefined,
        flash_attention: this.localModelLoadFlashAttention,
        offload_kv_cache: this.localModelLoadOffloadKvCache,
        keep_in_memory: this.localModelLoadKeepInMemory,
        mmap: this.localModelLoadMmap,
        seed: this.localModelLoadSeed ? Number(this.localModelLoadSeed) : null,
        parallel: this.localModelLoadParallel ? Number(this.localModelLoadParallel) : null,
        rope_freq_base: this.localModelLoadRopeFreqBase ? Number(this.localModelLoadRopeFreqBase) : null,
        rope_freq_scale: this.localModelLoadRopeFreqScale ? Number(this.localModelLoadRopeFreqScale) : null,
        cache_type_k: this.localModelLoadCacheTypeK || undefined,
        cache_type_v: this.localModelLoadCacheTypeV || undefined,
        runtime_path: this.localModelLoadRuntimePath || undefined,
        mmproj_path: this.localModelLoadMmprojPath || undefined
      });
      const remembered = readRememberedLocalModelSettings();
      if (this.localModelRememberSettings) {
        remembered[this.localModelLoadTarget.id] = {
          context_length: this.localModelLoadContextLength ? Number(this.localModelLoadContextLength) : undefined,
          gpu_offload: this.localModelLoadGpuLayers ? Number(this.localModelLoadGpuLayers) : undefined,
          cpu_threads: this.localModelLoadCpuThreads ? Number(this.localModelLoadCpuThreads) : undefined,
          batch_size: this.localModelLoadBatchSize ? Number(this.localModelLoadBatchSize) : undefined,
          flash_attention: this.localModelLoadFlashAttention,
          offload_kv_cache: this.localModelLoadOffloadKvCache,
          keep_in_memory: this.localModelLoadKeepInMemory,
          mmap: this.localModelLoadMmap,
          seed: this.localModelLoadSeed ? Number(this.localModelLoadSeed) : null,
          parallel: this.localModelLoadParallel ? Number(this.localModelLoadParallel) : null,
          rope_freq_base: this.localModelLoadRopeFreqBase ? Number(this.localModelLoadRopeFreqBase) : null,
          rope_freq_scale: this.localModelLoadRopeFreqScale ? Number(this.localModelLoadRopeFreqScale) : null,
          cache_type_k: this.localModelLoadCacheTypeK || 'f16',
          cache_type_v: this.localModelLoadCacheTypeV || 'f16',
          runtime_path: this.localModelLoadRuntimePath || ''
        };
      } else {
        delete remembered[this.localModelLoadTarget.id];
      }
      writeRememberedLocalModelSettings(remembered);
      const config = await loadChatConfig();
      this.localModelLoadProgress = 24;
      this.localModelLoadPhase = 'Launching local runtime';
      await loadLocalModel({
        config: {
          ...config,
          llm: {
            ...config.llm,
            local: {
              ...(config.llm?.local || {}),
              selected_model_path: this.localModelLoadTarget.path,
              model: this.localModelLoadTarget.name,
              context_length: this.localModelLoadContextLength ? Number(this.localModelLoadContextLength) : undefined,
              gpu_layers: this.localModelLoadGpuLayers ? Number(this.localModelLoadGpuLayers) : undefined,
              cpu_threads: this.localModelLoadCpuThreads ? Number(this.localModelLoadCpuThreads) : undefined,
              batch_size: this.localModelLoadBatchSize ? Number(this.localModelLoadBatchSize) : undefined,
              flash_attention: this.localModelLoadFlashAttention,
              offload_kv_cache: this.localModelLoadOffloadKvCache,
              keep_in_memory: this.localModelLoadKeepInMemory,
              mmap: this.localModelLoadMmap,
              seed: this.localModelLoadSeed ? Number(this.localModelLoadSeed) : undefined,
              parallel: this.localModelLoadParallel ? Number(this.localModelLoadParallel) : undefined,
              rope_freq_base: this.localModelLoadRopeFreqBase ? Number(this.localModelLoadRopeFreqBase) : undefined,
              rope_freq_scale: this.localModelLoadRopeFreqScale ? Number(this.localModelLoadRopeFreqScale) : undefined,
              cache_type_k: this.localModelLoadCacheTypeK || undefined,
              cache_type_v: this.localModelLoadCacheTypeV || undefined,
              runtime_path: this.localModelLoadRuntimePath || undefined,
              mmproj_path: this.localModelLoadMmprojPath || undefined
            }
          }
        },
        modelPath: this.localModelLoadTarget.path,
        runtimePath: this.localModelLoadRuntimePath || undefined,
        contextLength: this.localModelLoadContextLength ? Number(this.localModelLoadContextLength) : undefined,
        gpuLayers: this.localModelLoadGpuLayers ? Number(this.localModelLoadGpuLayers) : undefined,
        cpuThreads: this.localModelLoadCpuThreads ? Number(this.localModelLoadCpuThreads) : undefined,
        batchSize: this.localModelLoadBatchSize ? Number(this.localModelLoadBatchSize) : undefined,
        flashAttention: this.localModelLoadFlashAttention,
        offloadKvCache: this.localModelLoadOffloadKvCache,
        keepInMemory: this.localModelLoadKeepInMemory,
        mmap: this.localModelLoadMmap,
        seed: this.localModelLoadSeed ? Number(this.localModelLoadSeed) : undefined,
        parallel: this.localModelLoadParallel ? Number(this.localModelLoadParallel) : undefined,
        ropeFreqBase: this.localModelLoadRopeFreqBase ? Number(this.localModelLoadRopeFreqBase) : undefined,
        ropeFreqScale: this.localModelLoadRopeFreqScale ? Number(this.localModelLoadRopeFreqScale) : undefined,
        cacheTypeK: this.localModelLoadCacheTypeK || undefined,
        cacheTypeV: this.localModelLoadCacheTypeV || undefined,
        mmprojPath: this.localModelLoadMmprojPath || undefined
      });
      this.localModelLoadProgress = 88;
      this.localModelLoadPhase = 'Refreshing local model state';
      await Promise.all([modelsStore.refresh(), this.refreshModels()]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await modelsStore.refreshStatus();
      this.localModelLoadProgress = 100;
      this.localModelLoadPhase = 'Model ready';
      this.localModelActive = {
        name: this.localModelLoadTarget?.name || 'local model',
        path: this.localModelLoadTarget?.path || '',
        hasMmproj: !!(this.localModelLoadMmprojPath),
      };
      toastStore.success(`Model loaded: ${this.localModelLoadTarget?.name || 'local model'}`);
      this.localModelLoadTarget = null;
    } finally {
      this.localModelLoading = false;
    }
  }

  async init() {
    this.ready = false;
    this.error = null;

    try {
      const CONFIG_TIMEOUT_SENTINEL = Symbol('timeout');
      const configResult = await withTimeout(loadChatConfig(), 5000, CONFIG_TIMEOUT_SENTINEL as any);
      if (configResult === CONFIG_TIMEOUT_SENTINEL) {
        console.warn('[appStore.init] Config load timed out after 5s — using empty config fallback. Backend mode will default to local.');
        this.config = {};
      } else {
        this.config = configResult;
      }
      const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
      this.chats = Array.isArray(persisted.chats) ? persisted.chats.map((chat, index) => normalizeChat(chat, index)) : [];
      this.folders = Array.isArray(persisted.folders) ? persisted.folders.map((folder, index) => normalizeFolder(folder, index)) : [];
      this.currentChatId = persisted.currentChatId;

      if (!this.chats.length) {
        this.createChat();
      } else if (!this.currentChat) {
        this.currentChatId = this.chats[0]?.id || null;
      }
    } catch (error) {
      this.error = String((error as Error)?.message || error || 'Failed to initialize application');
      if (!this.chats.length) {
        this.createChat();
      }
      console.error('[appStore.init] failed', error);
    } finally {
      this.ready = true;
    }

    void withTimeout(this.refreshModels(), 2500, undefined);
    if (isTauri()) {
      void Promise.allSettled([
        withTimeout(modelsStore.refresh(), 2500, undefined),
        withTimeout(downloadsStore.refresh(), 2500, undefined),
        withTimeout(this.refreshRagDocuments(), 2500, undefined)
      ]);
      modelsStore.startPolling(3000);
    }
  }

  persist() {
    saveChatState<PersistedState>({
      chats: this.chats,
      folders: this.folders,
      currentChatId: this.currentChatId
    });
  }

  createChat() {
    const chat: ChatSession = {
      id: createId('chat'),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      folderId: null,
      draft: '',
      contextMode: 'chat',
      workspace: null,
      messages: []
    };
    this.chats = [chat, ...this.chats];
    this.currentChatId = chat.id;
    this.composer = '';
    this.persist();
    return chat;
  }

  selectChat(chatId: string) {
    const match = this.chats.find((chat) => chat.id === chatId);
    if (!match) return;
    this.currentChatId = chatId;
    this.composer = match.draft || '';
    // Restore artifact from the selected chat's last agent message, or clear
    const lastArtifactMsg = [...match.messages].reverse().find(m => m.artifact);
    this.currentArtifact = lastArtifactMsg?.artifact || null;
    this.currentArtifactMessageId = lastArtifactMsg?.id || null;
    if (!this.currentArtifact) this.sandboxOpen = false;
    this.persist();
    if (isTauri()) {
      void this.refreshRagDocuments(chatId);
    }
  }

  updateComposer(value: string) {
    this.composer = value;
    if (this.currentChat) {
      this.currentChat.draft = value;
      this.persist();
    }
  }

  setUserName(name: string) {
    this.userName = name;
    try { localStorage.setItem(USER_NAME_KEY, name); } catch {}
  }

  deleteChat(chatId: string) {
    const title = this.chats.find((c) => c.id === chatId)?.title;
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    delete this.ragDocumentsByChat[chatId];
    if (this.currentChatId === chatId) {
      this.currentChatId = this.chats[0]?.id || null;
      this.composer = this.currentChat?.draft || '';
      // Clear sandbox when current chat is deleted
      this.currentArtifact = null;
      this.currentArtifactMessageId = null;
      this.sandboxOpen = false;
    }
    if (!this.chats.length) this.createChat();
    this.persist();
    toastStore.info(`Chat deleted${title ? `: ${title}` : ''}`, 2500);
  }

  renameChat(chatId: string, title: string) {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return;
    chat.title = title.trim() || 'New chat';
    this.touchChats();
    this.persist();
  }

  openEditMessage(messageId: string) {
    const message = this.currentChat?.messages.find((entry) => entry.id === messageId);
    if (!message) return;
    this.editingMessageId = messageId;
    this.editingMessageContent = getMessageRequestContent(message);
  }

  closeEditMessage() {
    this.editingMessageId = null;
    this.editingMessageContent = '';
  }

  updateEditingMessage(value: string) {
    this.editingMessageContent = value;
  }

  saveEditedMessage() {
    const chat = this.currentChat;
    const messageId = this.editingMessageId;
    const nextContent = this.editingMessageContent.trim();
    if (!chat || !messageId || !nextContent) {
      this.closeEditMessage();
      return;
    }

    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    if (index < 0) {
      this.closeEditMessage();
      return;
    }

    const message = chat.messages[index];
    if (message.role === 'user') {
      message.content = nextContent;
      chat.messages = chat.messages.slice(0, index + 1);
    } else {
      if (!Array.isArray(message.versions) || !message.versions.length) {
        message.versions = [{
          content: nextContent,
          reasoning: message.reasoning || '',
          createdAt: Date.now(),
          metadata: message.metadata
        }];
        message.activeVersion = 0;
      } else {
        const activeIndex = typeof message.activeVersion === 'number'
          ? Math.max(0, Math.min(message.activeVersion, message.versions.length - 1))
          : 0;
        message.versions[activeIndex] = {
          ...message.versions[activeIndex],
          content: nextContent
        };
        message.activeVersion = activeIndex;
      }
      message.content = nextContent;
    }

    chat.updatedAt = Date.now();
    this.closeEditMessage();
    this.touchChats();
    this.persist();
  }

  deleteMessage(messageId: string) {
    const chat = this.currentChat;
    if (!chat) return;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    if (index < 0) return;
    chat.messages = chat.messages.filter((entry) => entry.id !== messageId);
    chat.updatedAt = Date.now();
    if (this.editingMessageId === messageId) {
      this.closeEditMessage();
    }
    this.touchChats();
    this.persist();
  }

  private appendMessage(message: ChatMessage) {
    if (!this.currentChat) return null;
    this.currentChat.messages = [...this.currentChat.messages, message];
    this.currentChat.updatedAt = Date.now();
    if (this.currentChat.title === 'New chat' && message.role === 'user') {
      this.currentChat.title = message.content.slice(0, 48) || 'New chat';
    }
    this.touchChats(); // notify reactive subscribers of array mutation
    this.persist();
    return message;
  }

  private touchChats() {
    this.chats = [...this.chats];
  }

  private findChat(chatId: string | null | undefined) {
    if (!chatId) return null;
    return this.chats.find((chat) => chat.id === chatId) || null;
  }

  private buildContextualPrompt(args: {
    content: string;
    searchContext?: string;
    researchSummary?: string;
    ragContext?: string;
    workspaceContext?: string;
    mode: 'chat' | 'slides' | 'agent';
    searchMode?: 'chat' | 'search' | 'deep' | 'max';
  }) {
    const extras: string[] = [];
    if (args.ragContext) {
      extras.push(`<documents>\n${args.ragContext}\n</documents>`);
    }
    if (args.searchContext) {
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      extras.push(`<web_search_results date="${dateStr}" time="${timeStr}">\n${args.searchContext}\n</web_search_results>`);
    }
    if (args.researchSummary) {
      extras.push(`<deep_research_brief>\n${args.researchSummary}\n</deep_research_brief>`);
    }
    if (args.workspaceContext) {
      extras.push(`<workspace>\n${args.workspaceContext}\n</workspace>`);
    }

    if (args.mode === 'slides') {
      const slidesSystemPrompt = `You are a senior presentation designer. Generate a sharp, audience-aware deck. Use this exact format:

# [Deck Title]

---

# [Slide Title]
- Insight or key message
- Supporting point
- Supporting point

---

# [Next Slide Title]
- Key point
- Supporting detail

Design rules:
- Create 5-10 slides unless asked otherwise
- Make titles specific and declarative, never vague labels like "Overview"
- Each slide must make one strong point
- Bullets must be concise and worth presenting on screen
- Build a narrative arc: context → insight → implication → action
- Start strong and end with a decisive closing slide
- Do NOT add any text outside the slide format above`;

      return [
        slidesSystemPrompt,
        extras.length ? extras.join('\n\n') : '',
        `User request:\n${args.content}`
      ].filter(Boolean).join('\n\n');
    }

    if (!extras.length) return args.content;

    const guidance: string[] = [];
    if (args.searchContext) {
      guidance.push([
        'You have access to real-time web search results retrieved just now.',
        'Use the information in <web_search_results> as your primary source of truth for this response.',
        'If <deep_research_brief> is present, use it as the high-level synthesis of the gathered evidence while still staying faithful to the raw search results.',
        'Present the information clearly, cite specific facts and data from the sources.',
        'When sources include URLs, reference them naturally (e.g. "According to [Source Title]...").',
        'If the search results do not contain enough information to fully answer, say so honestly.',
        'Do NOT fabricate information that is not present in the search results.'
      ].join(' '));
    }
    if (args.workspaceContext) {
      guidance.push([
        'You are in work mode with a project workspace attached.',
        'When agent mode is active in work mode, operate directly inside the attached workspace folder instead of a temporary sandbox.',
        'Use <workspace> for project structure and filenames, and use <documents> for retrieved excerpts from the workspace when relevant.',
        'When you mention implementation details, ground them in the provided file paths and avoid inventing files that are not present.',
        'You CAN create or write files for the user. To create or update a file use this EXACT format on its own line:',
        '<write_file path="relative/path/to/filename.ext">',
        'full file content here',
        '</write_file>',
        'Use .md for documents, .txt for plain text, .csv for data, .py/.js/.ts for code, .html/.css/.js for previews, and .docx/.xlsx when the user wants Office documents.',
        'For graphs and diagrams use Mermaid inside a ```mermaid code block inside a .md file.',
        'You may output multiple <write_file> blocks in one response.',
        'After the block(s), briefly explain what you created.'
      ].join(' '));
    }
    if (args.mode === 'agent') {
      const searchModeLabel = args.searchMode && args.searchMode !== 'chat' ? args.searchMode : 'chat';
      guidance.push([
        'You are operating in autonomous agent mode.',
        `Current search mode preference: ${searchModeLabel}.`,
        'Turn useful work into artifacts instead of only replying in chat.',
        'For research or competitor analysis, create a report file the user can open or download.',
        'For code requests, create the actual files, test them when possible, and include a previewable HTML result when it helps.'
      ].join(' '));
    }
    if (!guidance.length) {
      guidance.push('Answer the user using the supplemental context when it is relevant. Cite concrete details from the context instead of inventing facts.');
    }

    return [
      guidance.join(' '),
      extras.join('\n\n'),
      `User question:\n${args.content}`
    ].join('\n\n');
  }

  setContextMode(mode: 'chat' | 'work') {
    if (!this.currentChat) return;
    this.currentChat.contextMode = mode;
    if (mode === 'work') {
      this.composerMode = 'agent';
    } else if (this.composerMode === 'agent') {
      this.composerMode = 'chat';
    }
    this.touchChats();
    this.persist();
  }

  setSearchMode(mode: 'chat' | 'search' | 'deep' | 'max') {
    this.searchMode = this.searchMode === mode ? 'chat' : mode;
  }

  async performWebSearch(query: string) {
    const trimmed = String(query || '').trim();
    if (!trimmed) {
      this.searchResults = [];
      return;
    }

    this.searchLoading = true;
    try {
      const response = await webSearch({ query: trimmed, deep: false, mode: 'search' });
      this.searchResults = Array.isArray(response.results) ? response.results : [];
    } catch (error) {
      this.searchResults = [];
      toastStore.error(String((error as Error)?.message || error || 'Search failed'));
    } finally {
      this.searchLoading = false;
    }
  }

  openSearchSidebarWithResults(results: SearchResult[]) {
    this.searchResults = Array.isArray(results) ? results : [];
    this.searchSidebarOpen = true;
  }

  setComposerMode(mode: 'chat' | 'slides' | 'agent') {
    if (mode === 'agent') {
      this.searchMode = 'chat';
    }
    if (this.currentContextMode === 'work' && mode !== 'agent') {
      this.composerMode = mode;
      return;
    }
    this.composerMode = mode;
  }

  async refreshRagDocuments(chatId = this.currentChatId || '') {
    if (!isTauri() || !chatId) return;
    try {
      const docs = await listRagDocuments(chatId);
      this.ragDocumentsByChat = {
        ...this.ragDocumentsByChat,
        [chatId]: docs
      };
    } catch {
      this.ragDocumentsByChat = {
        ...this.ragDocumentsByChat,
        [chatId]: []
      };
    }
  }

  async clearRag() {
    if (!isTauri() || !this.currentChatId) return;
    await clearRagDocuments(this.currentChatId);
    this.pendingAttachments = [];
    if (this.currentChat?.workspace) {
      this.currentChat.workspace = null;
      if (this.currentChat.contextMode === 'work') {
        this.currentChat.contextMode = 'chat';
      }
      this.touchChats();
      this.persist();
    }
    await this.refreshRagDocuments();
  }

  removeAttachment(attachmentId: string) {
    const attachment = this.pendingAttachments.find((a) => a.id === attachmentId);
    this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== attachmentId);
    // If image, revoke the blob URL to free memory
    if (attachment?.preview?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.preview);
    }
    // If it's a RAG document, remove from backend too
    if (attachment?.docId && isTauri() && this.currentChatId) {
      removeRagDocument(attachment.docId, this.currentChatId).catch(() => {});
      this.refreshRagDocuments().catch(() => {});
    }
  }

  async removeRagDoc(docId: string) {
    if (!isTauri() || !this.currentChatId) return;
    await removeRagDocument(docId, this.currentChatId);
    this.pendingAttachments = this.pendingAttachments.filter((attachment) => attachment.docId !== docId);
    if (this.currentChat?.workspace) {
      const nextFiles = this.currentChat.workspace.files.filter((file) => file.docId !== docId);
      if (nextFiles.length !== this.currentChat.workspace.files.length) {
        this.currentChat.workspace = nextFiles.length
          ? recalculateWorkspace({
              ...this.currentChat.workspace,
              files: nextFiles
            })
          : null;
        if (!this.currentChat.workspace && this.currentChat.contextMode === 'work') {
          this.currentChat.contextMode = 'chat';
        }
        this.touchChats();
        this.persist();
      }
    }
    await this.refreshRagDocuments();
  }

  async addFiles(files: File[]) {
    if (!files.length || !this.currentChatId) return;

    const nextAttachments: Attachment[] = [];

    for (const file of files) {
      const attachment: Attachment = {
        id: createId('attachment'),
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        kind: file.type.startsWith('image/') && !/\.pdf$/i.test(file.name) ? 'image' : 'document',
        status: 'processing'
      };

      if (attachment.kind === 'image') {
        attachment.preview = URL.createObjectURL(file);
        // Read base64 for vision API calls
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = (e) => resolve(e.target?.result as string || '');
          reader.readAsDataURL(file);
        });
        attachment.base64 = base64;
        // Run OCR on images for text fallback (non-blocking)
        try {
          const { extractTextFromFile } = await import('$lib/services/ocr');
          const ocrText = await extractTextFromFile(file);
          if (ocrText.trim()) attachment.ocrText = ocrText.trim();
        } catch (err) {
          console.warn('[addFiles] OCR failed for image:', err);
        }
        attachment.status = 'ready';
        nextAttachments.push(attachment);
        continue;
      }

      // Documents: try backend RAG ingestion, fallback to client-side extraction
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const tempPath = await writeTempFile(`${Date.now()}_${file.name}`, bytes);
        const doc = await ingestDocument({
          file_path: tempPath,
          chat_id: this.currentChatId
        });
        attachment.docId = doc.id;
        attachment.status = 'ready';
        nextAttachments.push(attachment);
      } catch (error) {
        // Backend RAG failed — try client-side text extraction (OCR/PDF.js)
        console.warn('[addFiles] Backend ingest failed, trying client-side extraction:', error);
        try {
          const { extractTextFromFile } = await import('$lib/services/ocr');
          const text = await extractTextFromFile(file);
          if (text.trim()) {
            attachment.ocrText = text.trim();
            attachment.status = 'ready';
          } else {
            attachment.status = 'error';
            attachment.error = 'Could not extract text from file';
          }
        } catch (ocrErr) {
          attachment.status = 'error';
          attachment.error = String((error as Error)?.message || error || 'Failed to process file');
        }
        nextAttachments.push(attachment);
      }
    }

    this.pendingAttachments = [...this.pendingAttachments, ...nextAttachments];
    await this.refreshRagDocuments();
  }

  private async clearWorkspaceDocs() {
    if (!this.currentChatId || !this.currentChat?.workspace?.files?.length) return;
    await Promise.allSettled(
      this.currentChat.workspace.files
        .map((file) => file.docId)
        .filter((docId): docId is string => !!docId)
        .map((docId) => removeRagDocument(docId, this.currentChatId!))
    );
  }

  async pickWorkspaceFolder() {
    if (!isTauri() || !this.currentChatId || !this.currentChat) return;
    const selectedPath = await pickWorkspaceFolderDialog();
    if (!selectedPath) return;

    this.workspaceIndexing = true;
    this.error = null;

    try {
      await this.clearWorkspaceDocs();
      const result = await indexWorkspaceFolder(selectedPath, this.currentChatId);
      this.currentChat.workspace = {
        rootName: result.root_name,
        rootPath: result.root_path,
        attachedAt: Date.now(),
        fileCount: result.file_count,
        indexedCount: result.indexed_count,
        skippedCount: result.skipped_count,
        files: result.files.map((file) => ({
          path: file.path,
          name: file.name,
          size: file.size,
          type: file.type,
          status: file.status,
          docId: file.doc_id,
          reason: file.reason
        }))
      };
      this.currentChat.contextMode = 'work';
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments();
      toastStore.success(
        result.indexed_count > 0
          ? `Workspace ready: ${result.indexed_count} file${result.indexed_count === 1 ? '' : 's'} indexed`
          : 'Workspace attached, but no files could be indexed.'
      );
    } finally {
      this.workspaceIndexing = false;
    }
  }

  async addWorkspaceFolder(files: File[]) {
    if (!isTauri()) {
      toastStore.error('Work mode is only available in the desktop app.');
      return;
    }
    if (!files.length || !this.currentChatId || !this.currentChat) return;

    this.workspaceIndexing = true;
    this.error = null;
    try {
      await this.clearWorkspaceDocs();

      const sortedFiles = [...files].sort((left, right) => getWorkspacePath(left).localeCompare(getWorkspacePath(right)));
      const workspaceFiles: WorkspaceFile[] = [];
      let indexedCount = 0;
      let skippedCount = 0;
      let indexedSoFar = 0;

      for (const file of sortedFiles) {
        const relativePath = getWorkspacePath(file);
        if (!relativePath || shouldIgnoreWorkspacePath(relativePath)) {
          skippedCount += 1;
          continue;
        }

        const workspaceFile: WorkspaceFile = {
          path: relativePath,
          name: file.name,
          size: file.size,
          type: getWorkspaceExtension(relativePath),
          status: 'ready'
        };

        if (!isSupportedWorkspaceFile(relativePath)) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'Unsupported file type';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        if (file.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'File too large';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        if (indexedSoFar >= WORKSPACE_MAX_FILES) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'Workspace file limit reached';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        try {
          const text = trimWorkspaceText(await file.text());
          if (!text) {
            workspaceFile.status = 'skipped';
            workspaceFile.reason = 'Empty text content';
            skippedCount += 1;
          } else {
            const doc = await ingestText({
              source: relativePath,
              text,
              chat_id: this.currentChatId,
              file_type: workspaceFile.type
            });
            workspaceFile.docId = doc.id;
            indexedCount += 1;
            indexedSoFar += 1;
          }
        } catch (error) {
          workspaceFile.status = 'error';
          workspaceFile.reason = String((error as Error)?.message || error || 'Failed to index file');
          skippedCount += 1;
        }

        workspaceFiles.push(workspaceFile);
      }

      const rootName = workspaceFiles[0]?.path.split('/')[0] || sortedFiles[0]?.name || 'Workspace';
      this.currentChat.workspace = {
        rootName,
        rootPath: undefined,
        attachedAt: Date.now(),
        fileCount: workspaceFiles.length,
        indexedCount,
        skippedCount,
        files: workspaceFiles
      };
      this.currentChat.contextMode = 'work';
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments();

      toastStore.success(
        indexedCount > 0
          ? `Workspace ready: ${indexedCount} file${indexedCount === 1 ? '' : 's'} indexed`
          : 'Workspace attached, but no files could be indexed.'
      );
    } finally {
      this.workspaceIndexing = false;
    }
  }

  async clearWorkspace() {
    if (!this.currentChatId || !this.currentChat?.workspace) return;
    const docIds = this.currentChat.workspace.files
      .map((file) => file.docId)
      .filter((docId): docId is string => !!docId);
    await Promise.allSettled(docIds.map((docId) => removeRagDocument(docId, this.currentChatId!)));
    this.currentChat.workspace = null;
    this.currentChat.contextMode = 'chat';
    this.touchChats();
    this.persist();
    await this.refreshRagDocuments();
    toastStore.info('Workspace removed from this chat.', 2200);
  }

  /** Re-scan the workspace folder after LLM creates new files */
  async refreshWorkspace() {
    const chat = this.currentChat;
    const rootPath = chat?.workspace?.rootPath;
    const chatId = this.currentChatId;
    if (!rootPath || !chatId || !isTauri()) return;
    this.workspaceIndexing = true;
    try {
      await this.clearWorkspaceDocs();
      const result = await indexWorkspaceFolder(rootPath, chatId);
      chat!.workspace = {
        rootName: result.root_name,
        rootPath: result.root_path,
        attachedAt: chat!.workspace!.attachedAt,
        fileCount: result.file_count,
        indexedCount: result.indexed_count,
        skippedCount: result.skipped_count,
        files: result.files.map((f) => ({
          path: f.path, name: f.name, size: f.size, type: f.type,
          status: f.status, docId: f.doc_id, reason: f.reason
        }))
      };
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments();
    } finally {
      this.workspaceIndexing = false;
    }
  }

  /** Create a file inside the workspace from the UI */
  async createWorkspaceFile(relativePath: string, docType: string, content: string): Promise<string> {
    const rootPath = this.currentChat?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    const fullPath = await createWorkspaceDocument(rootPath, relativePath, docType, content);
    await this.refreshWorkspace();
    return fullPath;
  }

  async renameWorkspaceFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const rootPath = this.currentChat?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await renameWorkspaceFile(rootPath, oldRelPath, newRelPath);
    await this.refreshWorkspace();
    toastStore.info(`Renamed to ${newRelPath.split('/').pop()}`, 2000);
  }

  async deleteWorkspaceFile(relativePath: string): Promise<void> {
    const rootPath = this.currentChat?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await deleteWorkspaceFile(rootPath, relativePath);
    await this.refreshWorkspace();
    toastStore.info(`Deleted ${relativePath.split('/').pop()}`, 2000);
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    const rootPath = this.currentChat?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    return readWorkspaceFile(rootPath, relativePath);
  }

  async openWorkspaceFile(relativePath: string): Promise<void> {
    const rootPath = this.currentChat?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    const fullPath = `${rootPath}/${relativePath}`;
    await openWorkspaceFile(fullPath);
  }

  async createWorkspaceFolder(relativePath: string): Promise<void> {
    const rootPath = this.currentChat?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await createWorkspaceFolder(rootPath, relativePath);
    await this.refreshWorkspace();
    toastStore.info(`Folder created`, 2000);
  }

  async sendCurrentMessage() {
    const content = this.composer.trim();
    if (!content || !this.currentChat || this.loading) return;

    // Guard: local mode with no model loaded
    if (this.backendMode === 'local') {
      if (!this.selectedLocalModelPath) {
        toastStore.error('No local model selected. Open Model Hub to download and load a model.');
        return;
      }
      if (!this.localModelActive) {
        toastStore.error('No model is loaded yet. Load a model from the Model Hub first, then try again.');
        return;
      }
    }
    // Guard: API mode with no provider configured
    if (this.backendMode === 'api') {
      const provider = this.activeProvider;
      if (!provider?.has_api_key && !provider?.api_key) {
        toastStore.error('No API key configured. Open Settings to add a provider key.');
        return;
      }
    }

    this.error = null;
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    const targetChatTitle = targetChat?.title || 'New chat';
    const activeContextMode = this.currentContextMode;
    const activeWorkspace = activeContextMode === 'work' ? this.currentWorkspace : null;
    const workContext = activeWorkspace
      ? {
          rootName: activeWorkspace.rootName,
          fileCount: activeWorkspace.fileCount,
          indexedCount: activeWorkspace.indexedCount
        }
      : null;
    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content,
      createdAt: Date.now(),
      done: true,
      status: 'idle',
      attachments: this.pendingAttachments,
      mode: this.composerMode,
      searchMode: this.searchMode,
      workContext
    };

    this.appendMessage(userMessage);
    this.composer = '';
    this.currentChat.draft = '';
    const sentAttachments = [...this.pendingAttachments];
    this.pendingAttachments = [];

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      done: false,
      status: 'streaming',
      model: this.activeProvider?.model || undefined,
      versions: [],
      activeVersion: 0,
      searchMode: this.searchMode,
      mode: this.composerMode,
      agentTaskId: null,
      reasoning: '',
      workContext,
      agentSteps: this.composerMode === 'agent'
        ? [{ id: createId('step'), type: 'thinking', label: 'Planning', status: 'running', detail: 'Preparing tools and context' }]
        : [],
      artifact: null
    };

    this.appendMessage(assistantMessage);

    // SVELTE 5 REACTIVITY FIX: assistantMessage is a plain JS object. After appendMessage()
    // puts it in the $state array, Svelte wraps it in a reactive proxy — but the LOCAL
    // variable still points to the original unwrapped object. Mutations via
    // `assistantMessage.prop = value` bypass the proxy, so the UI never updates.
    // Solution: after every mutation, REPLACE the slot in the reactive array with a fresh
    // spread copy. This creates a new object reference that Svelte 5 detects as changed.
    const syncMsg = () => {
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      const idx = chat.messages.findIndex((m) => m.id === assistantMessage.id);
      if (idx >= 0) {
        chat.messages[idx] = { ...assistantMessage };
        chat.updatedAt = Date.now();
        this.touchChats();
      }
    };

    this.loading = true;
    const controller = new AbortController();
    this.abortController = controller;
    const activeSearchMode = this.searchMode;
    const activeComposerMode = this.composerMode;
    const startTime = Date.now();
    let tokenCount = 0;
    this.searchMode = 'chat';
    if (activeComposerMode !== 'agent') {
      this.composerMode = 'chat';
    }

    try {
      let managedTaskId: string | null = null;
      let searchContext = '';
      let sources: ChatMessage['sources'] = [];
      let searchMeta: SearchMeta | null = null;
      let ragContext = '';
      let ragDocuments: IndexedDocument[] = [];
      const workspaceContext = activeWorkspace ? buildWorkspacePrompt(activeWorkspace) : '';

      if (isTauri() && activeSearchMode !== 'chat') {
        try {
          const searchResponse = activeSearchMode === 'deep' || activeSearchMode === 'max'
            ? await deepResearchStore.runTask({
                chatId: targetChatId || 'unknown-chat',
                messageId: assistantMessage.id,
                chatTitle: targetChatTitle,
                query: content,
                mode: activeSearchMode
              }).then((task) => ({
                context: task.context,
                results: task.results,
                provider_used: task.providerUsed || 'auto',
                researchTaskId: task.id,
                researchSummary: task.summary
              }))
            : await webSearch({
                query: content,
                deep: activeSearchMode !== 'search',
                mode: activeSearchMode
              });
          searchContext = searchResponse.context || '';
          sources = searchResponse.results || [];
          searchMeta = {
            searchRequested: true,
            searchSucceeded: true,
            contextAvailable: !!(searchResponse.context || searchResponse.results?.length),
            sourceCount: searchResponse.results?.length || 0,
            requestedProvider: this.config.search?.provider || 'auto',
            providerUsed: searchResponse.provider_used || null,
            researchTaskId: 'researchTaskId' in searchResponse ? String(searchResponse.researchTaskId || '') || null : null,
            researchStatus: 'researchSummary' in searchResponse ? 'completed' : null,
            researchSummary: 'researchSummary' in searchResponse ? String(searchResponse.researchSummary || '') || null : null,
            searchFallbackReason: '',
            providerWarnings: [],
            searchError: ''
          };

          // Ingest search context into per-chat RAG for follow-up queries
          if (targetChatId && searchContext) {
            try {
              await ingestSearchContext(targetChatId, searchContext, sources);
            } catch (_) { /* non-critical */ }
          }
        } catch (error) {
          searchMeta = {
            searchRequested: true,
            searchSucceeded: false,
            contextAvailable: false,
            sourceCount: 0,
            requestedProvider: this.config.search?.provider || 'auto',
            providerUsed: null,
            researchTaskId: null,
            researchStatus: activeSearchMode === 'deep' || activeSearchMode === 'max' ? 'failed' : null,
            researchSummary: null,
            searchFallbackReason: '',
            providerWarnings: [],
            searchError: String((error as Error)?.message || error || 'Search did not return a result')
          };
        }
      }

      if (isTauri() && targetChatId && this.currentRagDocuments.length) {
        const ragResponse = await queryDocuments({
          query: content,
          chat_id: targetChatId,
          top_k: 5
        });
        ragContext = ragResponse.context || '';
        const docIds = new Set(ragResponse.results.map((result) => result.chunk.doc_id));
        ragDocuments = this.currentRagDocuments.filter((doc) => docIds.has(doc.id));
      }

      assistantMessage.sources = sources;
      assistantMessage.searchMeta = searchMeta;
      assistantMessage.ragDocuments = ragDocuments;
      if (assistantMessage.mode === 'agent') {
        const steps: AgentStep[] = [];
        steps.push({ id: createId('step'), type: 'thinking', label: 'Planning', status: 'done', detail: 'Context prepared' });
        if (sources.length) {
          steps.push({ id: createId('step'), type: 'searching', label: 'Web search', status: 'done', detail: `${sources.length} source${sources.length === 1 ? '' : 's'} gathered` });
        }
        if (ragDocuments.length) {
          steps.push({ id: createId('step'), type: 'reading', label: 'Documents', status: 'done', detail: `${ragDocuments.length} document${ragDocuments.length === 1 ? '' : 's'} loaded` });
        }
        steps.push({ id: createId('step'), type: 'coding', label: 'Drafting answer', status: 'running', detail: 'Streaming response' });
        assistantMessage.agentSteps = steps;
      }
      syncMsg(); // push initial metadata (sources, searchMeta) to the reactive array

      const requestMessages: RequestMessage[] = this.currentChat.messages
        .filter((message) => message.id !== assistantMessage.id)
        .map((message) => {
          if (message.id !== userMessage.id) return message;
          return {
            ...message,
              content: this.buildContextualPrompt({
                content,
                searchContext,
                researchSummary: searchMeta?.researchSummary || '',
                ragContext,
                workspaceContext,
                mode: activeComposerMode,
              searchMode: activeSearchMode
            })
          };
        });

      let systemPrompt = this.backendMode === 'local'
        ? (this.config.llm?.local?.system_prompt?.trim() || this.config.llm?.system_prompt?.trim() || '')
        : (this.activeProvider?.system_prompt?.trim() || this.config.llm?.system_prompt?.trim() || '');

      // Augment system prompt for search-grounded responses
      if (searchContext) {
        const searchSystemPrefix = 'You are a helpful assistant with access to real-time web search results. ' +
          'The user\'s message includes fresh web data retrieved moments ago. ' +
          'Ground your response in the provided search results — present facts, figures, and details from the sources. ' +
          'Always attribute information to its source when possible. ' +
          'If the search results are insufficient to answer fully, state what you found and what is missing.';
        systemPrompt = systemPrompt
          ? `${searchSystemPrefix}\n\n${systemPrompt}`
          : searchSystemPrefix;
      }

      // Chart rendering capability hint
      const chartHint = '\n\nWhen the user asks for a graph, chart, or visual data representation, output a chart block using this exact format:\n' +
        '<chart type="bar|line|pie|donut" title="Chart Title" xlabel="X axis label" ylabel="Y axis label">\n' +
        '{"labels":["A","B","C"],"datasets":[{"label":"Series","data":[10,20,30]}]}\n' +
        '</chart>\n' +
        'Supported types: bar, line, pie, donut. The JSON must be valid. Do not return raw chart JSON by itself and do not wrap chart JSON in markdown code fences unless it is inside the chart block. You may include multiple chart blocks in a single response.';
      systemPrompt = systemPrompt ? `${systemPrompt}${chartHint}` : chartHint.trim();

      const outboundMessages: RequestMessage[] = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...requestMessages]
        : requestMessages;

      if (activeComposerMode === 'agent' && targetChatId) {
        if (isTauri()) {
          try {
            const managedTask = await startManagedAgentTask({
              chatId: targetChatId,
              prompt: content,
              mode: activeComposerMode,
              searchMode: activeSearchMode,
              workContext: workContext ? { ...workContext } : null,
              metadata: {
                messageId: assistantMessage.id,
                chatTitle: targetChatTitle
              }
            });
            managedTaskId = managedTask.id;
            this.activeManagedAgentTaskId = managedTask.id;
            assistantMessage.agentTaskId = managedTask.id;
            syncMsg();
          } catch (managedTaskError) {
            console.warn('[agent-runtime] Failed to start managed task, continuing with in-memory agent only', managedTaskError);
          }
        }

        const agentResult = await runAgentTask({
          chatId: targetChatId,
          systemPrompt,
          messages: requestMessages,
          rawPrompt: content,
          executionMode: activeContextMode === 'work' && !!activeWorkspace?.rootPath ? 'workspace' : 'sandbox',
          workspaceRoot: activeWorkspace?.rootPath,
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          signal: controller.signal,
          onStep: (steps) => {
            assistantMessage.agentSteps = steps;
            syncMsg();
            if (managedTaskId) {
              void updateManagedAgentTask({
                taskId: managedTaskId,
                status: steps.some((step) => step.status === 'error') ? 'failed' : 'running',
                steps
              }).catch((error) => {
                console.warn('[agent-runtime] Failed to sync step update', error);
              });
            }
          },
          onReasoning: (value) => {
            assistantMessage.reasoning = value;
            syncMsg();
          },
          onArtifact: (artifact) => {
            assistantMessage.artifact = artifact;
            syncMsg();
            if (artifact || this.currentArtifactMessageId === assistantMessage.id) {
              this.setCurrentArtifact(artifact, assistantMessage.id, !!artifact);
            }
            if (managedTaskId) {
              void updateManagedAgentTask({
                taskId: managedTaskId,
                artifact,
                steps: assistantMessage.agentSteps
              }).catch((error) => {
                console.warn('[agent-runtime] Failed to sync artifact update', error);
              });
            }
          },
          onSources: (liveSources) => {
            const existingUrls = new Set((assistantMessage.sources || []).map((s) => s.url));
            const newSources = liveSources.filter((s) => !existingUrls.has(s.url));
            if (newSources.length) {
              assistantMessage.sources = [...(assistantMessage.sources || []), ...newSources];
              if (!assistantMessage.searchMode || assistantMessage.searchMode === 'chat') {
                assistantMessage.searchMode = 'search';
              }
              syncMsg();
            }
          }
        });
        assistantMessage.content = agentResult.content;
        assistantMessage.reasoning = agentResult.reasoning;
        assistantMessage.agentSteps = agentResult.steps;
        assistantMessage.artifact = agentResult.artifact;
        if (agentResult.sources?.length) {
          const existingUrls = new Set((assistantMessage.sources || []).map((s) => s.url));
          const newSources = agentResult.sources.filter((s) => !existingUrls.has(s.url));
          if (newSources.length) {
            assistantMessage.sources = [...(assistantMessage.sources || []), ...newSources];
          }
          if (!assistantMessage.searchMode || assistantMessage.searchMode === 'chat') {
            assistantMessage.searchMode = 'search';
          }
        }
        syncMsg();
        if (agentResult.artifact || this.currentArtifactMessageId === assistantMessage.id) {
          this.setCurrentArtifact(agentResult.artifact, assistantMessage.id, !!agentResult.artifact);
        }
        tokenCount = agentResult.content.split(/\s+/).filter(Boolean).length;
        if (managedTaskId) {
          await updateManagedAgentTask({
            taskId: managedTaskId,
            status: 'completed',
            content: agentResult.content,
            reasoning: agentResult.reasoning,
            artifact: agentResult.artifact,
            steps: agentResult.steps,
            metadata: {
              model: this.activeModelLabel,
              tokenCount
            }
          }).catch((error) => {
            console.warn('[agent-runtime] Failed to finalize managed task', error);
          });
        }
        if (activeContextMode === 'work' && activeWorkspace?.rootPath && this.currentChatId === targetChatId) {
          void this.refreshWorkspace();
        }
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          onChunk: (value) => {
            assistantMessage.content += value;
            tokenCount += value.split(/\s+/).filter(Boolean).length;
            assistantMessage.versions = [{
              content: assistantMessage.content,
              createdAt: assistantMessage.createdAt,
              reasoning: assistantMessage.reasoning,
              metadata: assistantMessage.metadata
            }];
            if (assistantMessage.mode === 'agent' && assistantMessage.agentSteps?.length) {
              assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
                if (index === all.length - 1) {
                  return { ...step, status: 'running', detail: 'Streaming response' };
                }
                return step;
              });
            }
            syncMsg(); // ← CRITICAL: replace array slot so Svelte 5 sees the new object
          },
          onReasoning: (value) => {
            assistantMessage.reasoning = `${assistantMessage.reasoning || ''}${value}`;
            syncMsg();
          }
        });
      }

      assistantMessage.done = true;
      assistantMessage.status = 'idle';
      const timing = (Date.now() - startTime) / 1000;
      const tokensPerSecond = timing > 0 ? tokenCount / timing : 0;
      assistantMessage.metadata = {
        modelName: this.activeModelLabel,
        tokens: tokenCount,
        timing,
        tokensPerSecond
      };
      assistantMessage.model = this.activeModelLabel;
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
      if (assistantMessage.mode === 'agent' && assistantMessage.agentSteps?.length) {
        assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
          if (index === all.length - 1) {
            return { ...step, type: 'done', label: 'Completed', status: 'done', detail: 'Response ready' };
          }
          return { ...step, status: step.status === 'running' ? 'done' : step.status };
        });
      }

      if (activeComposerMode === 'slides') {
        try {
          const slides = await parseSlidesFromMarkdown(assistantMessage.content);
          if (slides.length) {
            assistantMessage.slides = slides;
          }
        } catch {
          // ignore slide parse failures
        }
      }

      // ── Work mode file writing ──────────────────────────────────────
      const activeWorkspaceRoot = this.currentChat?.workspace?.rootPath;
      if (activeWorkspaceRoot && isTauri() && assistantMessage.content) {
        const blocks = parseWriteFileBlocks(assistantMessage.content);
        if (blocks.length > 0) {
          const created: import('$lib/types/chat').CreatedFile[] = [];
          for (const block of blocks) {
            try {
              const fullPath = await writeWorkspaceFile(activeWorkspaceRoot, block.path, block.content);
              created.push({ path: block.path, name: block.path.split('/').pop() || block.path, fullPath });
            } catch (writeErr) {
              toastStore.error(`Could not write ${block.path}: ${String((writeErr as Error)?.message || writeErr)}`);
            }
          }
          if (created.length > 0) {
            assistantMessage.filesCreated = created;
            assistantMessage.content = stripWriteFileBlocks(assistantMessage.content, created);
            assistantMessage.versions = [{
              content: assistantMessage.content,
              createdAt: assistantMessage.createdAt,
              reasoning: assistantMessage.reasoning,
              metadata: assistantMessage.metadata
            }];
            toastStore.success(
              created.length === 1
                ? `File created: ${created[0].name}`
                : `${created.length} files created in workspace`
            );
            // Auto-refresh workspace so new files appear in sidebar
            void this.refreshWorkspace();
          }
        }
      }
      // ───────────────────────────────────────────────────────────────

      syncMsg();
      this.persist();
      if (assistantMessage.agentTaskId && this.activeManagedAgentTaskId === assistantMessage.agentTaskId) {
        this.activeManagedAgentTaskId = null;
      }

      if (this.config.tts?.enable_voice_output && this.config.tts?.auto_play_voice && assistantMessage.content) {
        try {
          void ttsStore.speak(assistantMessage.id, assistantMessage.content, this.config);
        } catch {
          // ignore TTS auto-play failures
        }
      }

      // Auto-generate a smarter chat title after the first exchange
      void this.generateChatTitle();
    } catch (error) {
      const errorMsg = String((error as Error)?.message || error || 'Request failed');
      // Don't show toast for user-initiated abort
      if (!errorMsg.includes('abort') && !errorMsg.includes('AbortError') && !errorMsg.toLowerCase().includes('cancel')) {
        toastStore.error(errorMsg.length > 80 ? errorMsg.slice(0, 80) + '…' : errorMsg);
      }
      assistantMessage.done = true;
      assistantMessage.status = 'error';
      assistantMessage.content = assistantMessage.content || errorMsg;
      const timing = typeof startTime === 'number' ? (Date.now() - startTime) / 1000 : 0;
      const tokensPerSecond = timing > 0 ? tokenCount / timing : 0;
      assistantMessage.metadata = {
        modelName: this.activeModelLabel,
        tokens: tokenCount,
        timing,
        tokensPerSecond,
        error: true
      };
      assistantMessage.model = this.activeModelLabel;
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
      if (assistantMessage.mode === 'agent' && assistantMessage.agentSteps?.length) {
        assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
          if (index === all.length - 1) {
            return { ...step, status: 'error', detail: assistantMessage.content };
          }
          return step;
        });
      }
      this.error = assistantMessage.content;
      userMessage.attachments = sentAttachments;
      if (assistantMessage.agentTaskId) {
        await updateManagedAgentTask({
          taskId: assistantMessage.agentTaskId,
          status: 'failed',
          content: assistantMessage.content,
          reasoning: assistantMessage.reasoning,
          error: assistantMessage.content,
          artifact: assistantMessage.artifact,
          steps: assistantMessage.agentSteps,
          metadata: {
            model: this.activeModelLabel,
            failed: true
          }
        }).catch((managedTaskError) => {
          console.warn('[agent-runtime] Failed to mark managed task as failed', managedTaskError);
        });
      }
      syncMsg();
      this.persist();
    } finally {
      this.loading = false;
      this.abortController = null;
      if (assistantMessage.agentTaskId && this.activeManagedAgentTaskId === assistantMessage.agentTaskId) {
        this.activeManagedAgentTaskId = null;
      }
    }
  }

  stopStreaming() {
    this.abortController?.abort();
    this.loading = false;
    deepResearchStore.cancelActiveTask();
    if (this.activeManagedAgentTaskId && isTauri()) {
      void cancelManagedAgentTask(this.activeManagedAgentTaskId).catch((error) => {
        console.warn('[agent-runtime] Failed to cancel managed task', error);
      });
      this.activeManagedAgentTaskId = null;
    }
    // Exit voice mode when user explicitly cancels generation
    if (this.voiceModeActive) {
      this.voiceModeActive = false;
    }
  }

  private async generateChatTitle() {
    const chat = this.currentChat;
    if (!chat) return;
    // Only generate for chats that still have the default title
    if (chat.title !== 'New chat') return;
    // Need at least one user + one assistant message
    const userMsg = chat.messages.find((m) => m.role === 'user');
    const assistantMsg = chat.messages.find((m) => m.role === 'assistant' && m.done && m.content);
    if (!userMsg || !assistantMsg) return;

    try {
      const result = await completeAssistantReply({
        messages: [
          {
            role: 'system',
            content: 'Generate a concise, specific 4-6 word title for this conversation. Reply with ONLY the title — no quotes, no punctuation at the end, no explanation.'
          },
          {
            role: 'user',
            content: `User asked: ${userMsg.content.slice(0, 300)}\nAssistant replied: ${assistantMsg.content.slice(0, 300)}`
          }
        ]
      });

      const generated = result.content
        .trim()
        .replace(/^["']|["']$/g, '')   // strip surrounding quotes
        .replace(/[.!?]+$/, '')         // strip trailing punctuation
        .trim();

      if (generated && generated.length >= 4 && generated.length <= 80 && chat.title === 'New chat') {
        chat.title = generated;
        this.touchChats();
        this.persist();
      }
    } catch {
      // Title generation is best-effort, never show errors to user
    }
  }

  async regenerateMessage(messageId: string) {
    const chat = this.currentChat;
    if (!chat || this.loading) return;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    const message = index >= 0 ? chat.messages[index] : null;
    if (!message || message.role !== 'assistant') return;

    const previousMessages = buildRequestMessagesFromHistory(chat.messages, index - 1);
    if (!previousMessages.length) return;

    this.error = null;
    this.loading = true;
    const controller = new AbortController();
    this.abortController = controller;
    const startTime = Date.now();
    let tokenCount = 0;

    const nextVersion: MessageVersion = {
      content: '',
      reasoning: '',
      createdAt: Date.now(),
      metadata: {
        modelName: this.activeModelLabel
      }
    };

    message.versions = [...(message.versions || []), nextVersion];
    message.activeVersion = message.versions.length - 1;
    message.content = '';
    message.reasoning = '';
    message.done = false;
    message.status = 'streaming';
    if (message.mode === 'agent') {
      message.agentTaskId = null;
      message.agentSteps = [
        { id: createId('step'), type: 'thinking', label: 'Planning', status: 'running', detail: 'Preparing tools and context' }
      ];
      message.artifact = null;
      if (this.currentArtifactMessageId === message.id) {
        this.setCurrentArtifact(null, message.id, false);
      }
    }
    this.touchChats();
    this.persist();

    try {
      let managedTaskId: string | null = null;
      const systemPrompt = this.backendMode === 'local'
        ? (this.config.llm?.local?.system_prompt?.trim() || this.config.llm?.system_prompt?.trim() || '')
        : (this.activeProvider?.system_prompt?.trim() || this.config.llm?.system_prompt?.trim() || '');
      const outboundMessages: RequestMessage[] = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...previousMessages]
        : previousMessages;

      if (message.mode === 'agent' && this.currentChatId) {
        if (isTauri()) {
          try {
            const rawPrompt = [...chat.messages.slice(0, index)].reverse().find((entry) => entry.role === 'user')?.content || '';
            const managedTask = await startManagedAgentTask({
              chatId: this.currentChatId,
              prompt: rawPrompt,
              mode: message.mode,
              searchMode: message.searchMode,
              workContext: message.workContext ? { ...message.workContext } : null,
              metadata: {
                messageId: message.id,
                regeneration: true
              }
            });
            managedTaskId = managedTask.id;
            message.agentTaskId = managedTask.id;
            this.activeManagedAgentTaskId = managedTask.id;
            this.touchChats();
          } catch (managedTaskError) {
            console.warn('[agent-runtime] Failed to start managed task for regeneration', managedTaskError);
          }
        }

        if (managedTaskId) {
          this.activeManagedAgentTaskId = managedTaskId;
        }

        const rawPrompt = [...chat.messages.slice(0, index)].reverse().find((entry) => entry.role === 'user')?.content || '';
        const agentResult = await runAgentTask({
          chatId: this.currentChatId,
          systemPrompt,
          messages: previousMessages,
          rawPrompt,
          executionMode: this.currentContextMode === 'work' && !!this.currentChat?.workspace?.rootPath ? 'workspace' : 'sandbox',
          workspaceRoot: this.currentChat?.workspace?.rootPath,
          workspaceName: this.currentChat?.workspace?.rootName,
          workspaceFiles: this.currentChat?.workspace?.files,
          signal: controller.signal,
          onStep: (steps) => {
            message.agentSteps = steps;
            this.touchChats();
            if (managedTaskId) {
              void updateManagedAgentTask({
                taskId: managedTaskId,
                status: steps.some((step) => step.status === 'error') ? 'failed' : 'running',
                steps
              }).catch((managedTaskError) => {
                console.warn('[agent-runtime] Failed to sync regenerated task steps', managedTaskError);
              });
            }
          },
          onReasoning: (value) => {
            nextVersion.reasoning = value;
            message.reasoning = value;
            this.touchChats();
          },
          onArtifact: (artifact) => {
            message.artifact = artifact;
            if (artifact || this.currentArtifactMessageId === message.id) {
              this.setCurrentArtifact(artifact, message.id, !!artifact);
            }
            this.touchChats();
            if (managedTaskId) {
              void updateManagedAgentTask({
                taskId: managedTaskId,
                artifact,
                steps: message.agentSteps
              }).catch((managedTaskError) => {
                console.warn('[agent-runtime] Failed to sync regenerated task artifact', managedTaskError);
              });
            }
          },
          onSources: (liveSources) => {
            const existingUrls = new Set((message.sources || []).map((s) => s.url));
            const newSources = liveSources.filter((s) => !existingUrls.has(s.url));
            if (newSources.length) {
              message.sources = [...(message.sources || []), ...newSources];
              if (!message.searchMode || message.searchMode === 'chat') {
                message.searchMode = 'search';
              }
              this.touchChats();
            }
          }
        });
        nextVersion.content = agentResult.content;
        nextVersion.reasoning = agentResult.reasoning;
        message.content = agentResult.content;
        message.reasoning = agentResult.reasoning;
        message.agentSteps = agentResult.steps;
        message.artifact = agentResult.artifact;
        if (agentResult.sources?.length) {
          const existingUrls = new Set((message.sources || []).map((s) => s.url));
          const newSources = agentResult.sources.filter((s) => !existingUrls.has(s.url));
          message.sources = [...(message.sources || []), ...newSources];
          if (!message.searchMode || message.searchMode === 'chat') {
            message.searchMode = 'search';
          }
        }
        if (agentResult.artifact || this.currentArtifactMessageId === message.id) {
          this.setCurrentArtifact(agentResult.artifact, message.id, !!agentResult.artifact);
        }
        tokenCount = agentResult.content.split(/\s+/).filter(Boolean).length;
        if (managedTaskId) {
          await updateManagedAgentTask({
            taskId: managedTaskId,
            status: 'completed',
            content: agentResult.content,
            reasoning: agentResult.reasoning,
            artifact: agentResult.artifact,
            steps: agentResult.steps,
            metadata: {
              model: this.activeModelLabel,
              tokenCount,
              regeneration: true
            }
          }).catch((managedTaskError) => {
            console.warn('[agent-runtime] Failed to finalize regenerated managed task', managedTaskError);
          });
        }
        if (this.currentContextMode === 'work' && this.currentChat?.workspace?.rootPath) {
          void this.refreshWorkspace();
        }
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          onChunk: (value) => {
            nextVersion.content += value;
            message.content = nextVersion.content;
            tokenCount += value.split(/\s+/).filter(Boolean).length;
            this.touchChats();
          },
          onReasoning: (value) => {
            nextVersion.reasoning = `${nextVersion.reasoning || ''}${value}`;
            message.reasoning = nextVersion.reasoning;
            this.touchChats();
          }
        });
      }

      const timing = (Date.now() - startTime) / 1000;
      const tokensPerSecond = timing > 0 ? tokenCount / timing : 0;
      nextVersion.metadata = {
        modelName: this.activeModelLabel,
        tokens: tokenCount,
        timing,
        tokensPerSecond
      };
      message.metadata = nextVersion.metadata;
      message.model = this.activeModelLabel;
      message.done = true;
      message.status = 'idle';
      if (message.mode === 'slides') {
        try {
          const slides = await parseSlidesFromMarkdown(nextVersion.content);
          message.slides = slides.length ? slides : [];
        } catch {
          message.slides = [];
        }
      }
      if (message.mode === 'agent' && message.agentSteps?.length) {
        message.agentSteps = message.agentSteps.map((step, stepIndex, all) => {
          if (stepIndex === all.length - 1) {
            return { ...step, type: 'done', label: 'Completed', status: 'done', detail: 'Response ready' };
          }
          return { ...step, status: step.status === 'running' ? 'done' : step.status };
        });
      }
      this.touchChats();
      this.persist();
      if (message.agentTaskId && this.activeManagedAgentTaskId === message.agentTaskId) {
        this.activeManagedAgentTaskId = null;
      }
    } catch (error) {
      const timing = (Date.now() - startTime) / 1000;
      const tokensPerSecond = timing > 0 ? tokenCount / timing : 0;
      const failure = String((error as Error)?.message || error || 'Request failed');
      nextVersion.content = nextVersion.content || failure;
      nextVersion.metadata = {
        modelName: this.activeModelLabel,
        tokens: tokenCount,
        timing,
        tokensPerSecond,
        error: true
      };
      message.content = nextVersion.content;
      message.reasoning = nextVersion.reasoning || '';
      message.metadata = nextVersion.metadata;
      message.done = true;
      message.status = 'error';
      this.error = failure;
      if (message.agentTaskId) {
        await updateManagedAgentTask({
          taskId: message.agentTaskId,
          status: 'failed',
          content: message.content,
          reasoning: message.reasoning,
          error: failure,
          artifact: message.artifact,
          steps: message.agentSteps,
          metadata: {
            model: this.activeModelLabel,
            failed: true,
            regeneration: true
          }
        }).catch((managedTaskError) => {
          console.warn('[agent-runtime] Failed to mark regenerated managed task as failed', managedTaskError);
        });
      }
      this.touchChats();
      this.persist();
    } finally {
      this.loading = false;
      this.abortController = null;
      if (message.agentTaskId && this.activeManagedAgentTaskId === message.agentTaskId) {
        this.activeManagedAgentTaskId = null;
      }
    }
  }

  setMessageActiveVersion(messageId: string, direction: -1 | 1) {
    const chat = this.currentChat;
    if (!chat) return;
    const message = chat.messages.find((entry) => entry.id === messageId);
    if (!message?.versions?.length) return;
    const current = typeof message.activeVersion === 'number' ? message.activeVersion : 0;
    const next = Math.max(0, Math.min(current + direction, message.versions.length - 1));
    if (next === current) return;
    message.activeVersion = next;
    this.touchChats();
    this.persist();
  }

  async refreshModels() {
    try {
      this.models = await fetchModels(this.config);
    } catch {
      this.models = [];
    }
  }

  async updateProvider(partial: {
    provider: string;
    base_url?: string;
    api_key?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    system_prompt?: string;
  }) {
    const existing: import('$lib/types/chat').ProviderConfig = this.config.llm?.providers?.[partial.provider] || { base_url: '', model: '' };
    const next: AppConfig = {
      ...this.config,
      llm: {
        ...this.config.llm,
        provider: partial.provider,
        providers: {
          ...(this.config.llm?.providers || {}),
          [partial.provider]: {
            ...existing,
            base_url: partial.base_url ?? existing.base_url,
            // Use new key if provided; otherwise use existing key if it's a real value (not empty string)
            api_key: partial.api_key || (existing.api_key || undefined),
            has_api_key: !!(partial.api_key || existing.api_key || existing.has_api_key),
            model: partial.model ?? existing.model,
            ...(Number.isFinite(partial.temperature) ? { temperature: partial.temperature } : partial.temperature === undefined ? {} : { temperature: undefined }),
            ...(partial.max_tokens !== undefined ? { max_tokens: partial.max_tokens || undefined } : {}),
            ...(Number.isFinite(partial.top_p) ? { top_p: partial.top_p } : partial.top_p === undefined ? {} : { top_p: undefined }),
            ...(partial.system_prompt !== undefined ? { system_prompt: partial.system_prompt || undefined } : {})
          }
        }
      }
    };
    this.config = next;
    await saveAppConfig(next);
    await this.refreshModels();
    if (isTauri() && next.llm?.backend_mode === 'local') {
      await modelsStore.refresh();
    }
  }

  async setBackendMode(mode: 'local' | 'api') {
    const next: AppConfig = {
      ...this.config,
      llm: {
        ...this.config.llm,
        backend_mode: mode,
        local: {
          base_url: this.config.llm?.local?.base_url || 'http://127.0.0.1:11435/v1',
          ...(this.config.llm?.local || {})
        }
      }
    };
    this.config = next;
    await saveAppConfig(next);
    await this.refreshModels();
    if (isTauri()) {
      await modelsStore.refresh();
    }
  }

  async updateLocalModel(model: ModelOption) {
    const next: AppConfig = {
      ...this.config,
      llm: {
        ...this.config.llm,
        backend_mode: 'local',
        local: {
          ...(this.config.llm?.local || {}),
          model: model.name,
          selected_model_path: model.path,
          base_url: this.config.llm?.local?.base_url || 'http://127.0.0.1:11435/v1'
        }
      }
    };
    this.config = next;
    await saveAppConfig(next);
    await this.refreshModels();
    if (isTauri()) {
      await modelsStore.refresh();
    }
  }

  async updateLocalSettings(partial: {
    base_url?: string;
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
    system_prompt?: string;
    temperature?: number;
    max_tokens?: number;
  }) {
    const next: AppConfig = {
      ...this.config,
      llm: {
        ...this.config.llm,
        local: {
          ...(this.config.llm?.local || {}),
          ...partial
        }
      }
    };
    this.config = next;
    await saveAppConfig(next);
    if (isTauri()) {
      await modelsStore.refresh();
    }
  }

  async stopLocalModel() {
    if (!isTauri()) return;
    await stopLlama();
    this.localModelActive = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await modelsStore.refresh();
    await this.refreshModels();
  }

  async setLocalRuntimePath(path: string) {
    await this.updateLocalSettings({ runtime_path: path });
    this.localModelLoadRuntimePath = path;
  }

  async setWorkspaceMode(mode: 'legacy' | 'modern') {
    const next: AppConfig = {
      ...this.config,
      ui: {
        ...(this.config.ui || {}),
        workspace_mode: mode
      }
    };
    this.config = next;
    await saveAppConfig(next);
  }

  async updateUiSettings(partial: {
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
  }) {
    const next: AppConfig = {
      ...this.config,
      ui: {
        ...(this.config.ui || {}),
        ...partial
      }
    };
    this.config = next;
    await saveAppConfig(next);
  }

  async updatePromptSettings(partial: {
    system_prompt?: string;
    user_prompt?: string;
    local_system_prompt?: string;
  }) {
    const next: AppConfig = {
      ...this.config,
      llm: {
        ...this.config.llm,
        ...(partial.system_prompt !== undefined ? { system_prompt: partial.system_prompt } : {}),
        ...(partial.user_prompt !== undefined ? { user_prompt: partial.user_prompt } : {}),
        local: {
          ...(this.config.llm?.local || {}),
          ...(partial.local_system_prompt !== undefined ? { system_prompt: partial.local_system_prompt } : {})
        }
      }
    };
    this.config = next;
    await saveAppConfig(next);
  }

  async updateSearchSettings(partial: {
    provider?: string;
    max_results?: number;
    context_budget_chars?: number;
    providers?: NonNullable<AppConfig['search']>['providers'];
  }) {
    const next: AppConfig = {
      ...this.config,
      search: {
        ...(this.config.search || {}),
        ...partial,
        providers: {
          ...(this.config.search?.providers || {}),
          ...(partial.providers || {})
        }
      }
    };
    this.config = next;
    await saveAppConfig(next);
  }

  async updateTtsSettings(partial: {
    enable_voice_output?: boolean;
    auto_play_voice?: boolean;
    voice?: string;
    speed?: number;
    engine?: 'kitten' | 'kokoro' | 'browser';
    model_path?: string;
    voices_path?: string;
    tokens_path?: string;
    lexicon_path?: string;
    dict_dir?: string;
    data_dir?: string;
    model_variant?: string;
  }) {
    const next: AppConfig = {
      ...this.config,
      tts: {
        ...(this.config.tts || {}),
        ...partial
      }
    };
    this.config = next;
    await saveAppConfig(next);
  }
}

export const appStore = new AppStore();
