import type { AgentActivity, AgentArtifact, AgentOutcome, AgentStep, AgentStopReason, AppConfig, Attachment, ChatFolder, ChatMessage, ChatSession, CreatedFile, MessageVersion, ModelOption, SearchMeta, WorkspaceContext, WorkspaceFile } from '$lib/types/chat';
import type { IndexedDocument, SearchResult } from '$lib/types/tauri';
import { runAgentTask } from '$lib/services/agent';
import { parseSlidesFromMarkdown } from '$lib/services/slides';
import { writeTempFile, pathExists, pickWorkspaceFolder as pickWorkspaceFolderDialog, indexWorkspaceFolder, writeWorkspaceFile, createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, openWorkspaceFile, createWorkspaceFolder } from '$lib/services/files';
import { clearRagDocuments, ingestDocument, ingestText, ingestTextFast, listRagDocuments, queryDocuments, removeRagDocument } from '$lib/services/rag';
import { webSearch } from '$lib/services/search';
import { getRecommendedSettings, loadLocalModel, stopLlama } from '$lib/services/runtime';
import { normalizeStreamingReasoningDelta } from '$lib/services/streaming';
import { isTauri } from '$lib/services/tauri';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { deepResearchStore } from '$lib/stores/deep-research.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import { completeAssistantReply, detectToolSupport, fetchModels, hasConfiguredVisionModel, loadChatConfig, streamAssistantReply } from '$lib/services/chat-api';
import { loadChatState, saveChatState, saveAppConfig, saveChatStateToDb, loadChatStateFromDb, deleteChatFromDb } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';import {
  type ApiModelMetadataValue,
  type ContextBudgetValue
} from '$lib/stores/app-context-budget';
import { resolveContextBudgetPreview } from '$lib/stores/app-context-budget-preview';
import { buildSearchSystemPrefix, buildSystemPrompt, selectBaseSystemPrompt } from '$lib/stores/app-prompts';
import {
  applyLocalContextBudgetTruncation,
  buildOutboundMessages,
  buildRequestMessagesWithPatchedUser
} from '$lib/stores/app-message-pipeline';
import {
  buildApiModelMetadataCacheKey,
  fetchApiModelMetadataFromProvider,
  getCachedOrFetchApiModelMetadata
} from '$lib/stores/app-model-metadata';

interface PersistedState {
  chats: ChatSession[];
  folders: ChatFolder[];
  currentChatId: string | null;
}

type ContextBudget = ContextBudgetValue;
type ApiModelMetadata = ApiModelMetadataValue;

type ElectronApi = {
  invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
};

type GenerationBackendMode = 'api' | 'local';
type GenerationComposerMode = 'chat' | 'agent';

interface ActiveGenerationRun {
  controller: AbortController;
  messageId: string;
  backendMode: GenerationBackendMode;
  mode: GenerationComposerMode;
  startedAt: number;
  researchTaskId?: string | null;
}

interface ChatSearchState {
  results: SearchResult[];
  loading: boolean;
  query: string;
}

const LOCAL_MODEL_SETTINGS_KEY = 'chatealm_model_load_settings_by_model';
const USER_NAME_KEY = 'chatealm_user_name';

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

function getElectronApi(): ElectronApi | null {
  if (typeof window === 'undefined') return null;
  return (window as { electronAPI?: ElectronApi }).electronAPI || null;
}

function toInvoke(api: ElectronApi): ElectronApi['invoke'] {
  return (channel, payload) => api.invoke(channel, payload);
}

function createId(prefix: string) {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type AgentStoreResult = Awaited<ReturnType<typeof runAgentTask>>;

function hasUsableAgentResult(result: AgentStoreResult): boolean {
  return !!(
    result.content?.trim() ||
    result.sources?.length ||
    result.artifact ||
    result.steps?.some((step) => step.status === 'done' || step.output)
  );
}

function agentOutcome(result: AgentStoreResult): AgentOutcome {
  if (result.outcome) return result.outcome;
  if (result.error && hasUsableAgentResult(result)) return 'stopped';
  if (result.error) return 'failed';
  if (result.warning) return 'partial';
  return 'completed';
}

function agentStopReason(result: AgentStoreResult): AgentStopReason {
  if (result.stopReason) return result.stopReason;
  const text = `${result.error || ''} ${result.warning || ''}`.toLowerCase();
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('loop')) return 'loop';
  if (text.includes('tool') && (text.includes('limit') || text.includes('budget'))) return 'tool_limit';
  if (text.includes('iteration')) return 'iteration_limit';
  if (text.includes('requested file') || text.includes('artifact')) return 'missing_artifacts';
  return result.error ? 'error' : 'none';
}

function reliableUsageMetadata(
  usage: CompletionResult['usage'],
  elapsedSeconds: number,
  source: 'provider' | 'runtime'
): NonNullable<MessageVersion['metadata']> | null {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_eval_count ?? 0) || undefined;
  const outputTokens = Number(usage.output_tokens ?? usage.eval_count ?? 0) || undefined;
  const totalTokens = Number(usage.total_tokens ?? ((inputTokens || 0) + (outputTokens || 0))) || undefined;
  const evalDurationSeconds = Number(usage.eval_duration || 0) > 0 ? Number(usage.eval_duration) / 1_000_000_000 : 0;
  const timing = evalDurationSeconds || elapsedSeconds;
  const tokensPerSecond = outputTokens && timing > 0 ? outputTokens / timing : undefined;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return {
    usageSource: source,
    timingScope: 'model',
    inputTokens,
    outputTokens,
    totalTokens,
    tokens: outputTokens || totalTokens,
    timing,
    modelTimingSeconds: timing,
    tokensPerSecond
  };
}

function noUsageMetadata(timingScope: NonNullable<MessageVersion['metadata']>['timingScope'] = 'unknown'): NonNullable<MessageVersion['metadata']> {
  return {
    usageSource: 'none',
    timingScope,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    tokens: undefined,
    timing: undefined,
    modelTimingSeconds: undefined,
    totalElapsedSeconds: undefined,
    reasoningTimingSeconds: undefined,
    tokensPerSecond: undefined
  };
}

function executionMetadata(backendMode: GenerationBackendMode): NonNullable<MessageVersion['metadata']> {
  return {
    executionBackend: backendMode,
    executionTransport: backendMode === 'local' ? 'local_runtime' : (isTauri() ? 'provider_ipc' : 'sdk')
  };
}

type AssistantMetadata = NonNullable<MessageVersion['metadata']>;

function finalizeAssistantMetadata(options: {
  existing?: MessageVersion['metadata'] | null;
  modelName: string;
  backendMode: GenerationBackendMode;
  usage?: CompletionResult['usage'] | null;
  elapsedSeconds?: number;
  totalElapsedSeconds?: number;
  reasoningElapsedSeconds?: number;
  noUsageTimingScope?: AssistantMetadata['timingScope'];
  overrides?: Partial<AssistantMetadata>;
}): AssistantMetadata {
  const {
    existing,
    modelName,
    backendMode,
    usage,
    elapsedSeconds = 0,
    totalElapsedSeconds,
    reasoningElapsedSeconds,
    noUsageTimingScope = 'unknown',
    overrides = {}
  } = options;

  const reliableUsage = reliableUsageMetadata(
    usage || null,
    elapsedSeconds,
    backendMode === 'local' ? 'runtime' : 'provider'
  );

  return {
    ...(existing || {}),
    modelName,
    ...executionMetadata(backendMode),
    ...(reliableUsage || noUsageMetadata(noUsageTimingScope)),
    totalElapsedSeconds: totalElapsedSeconds ?? existing?.totalElapsedSeconds,
    reasoningTimingSeconds: reasoningElapsedSeconds ?? existing?.reasoningTimingSeconds,
    ...overrides
  };
}

function startReasoningTimer() {
  return {
    startedAt: 0,
    markStarted() {
      if (!this.startedAt) this.startedAt = Date.now();
    },
    elapsedSeconds() {
      return this.startedAt ? (Date.now() - this.startedAt) / 1000 : undefined;
    }
  };
}

function activityFromProgress(text: string): { currentActivity: AgentActivity; activityLabel: string } {
  const value = String(text || '').toLowerCase();
  if (value.includes('search')) return { currentActivity: 'searching', activityLabel: 'Searching the web' };
  if (value.includes('fetch') || value.includes('read') || value.includes('source')) return { currentActivity: 'reading', activityLabel: 'Reading sources' };
  if (value.includes('document') || value.includes('spreadsheet') || value.includes('presentation') || value.includes('pdf') || value.includes('file') || value.includes('artifact') || value.includes('write')) {
    return { currentActivity: 'creating_files', activityLabel: 'Creating files' };
  }
  if (value.includes('final') || value.includes('answer') || value.includes('response') || value.includes('producing')) return { currentActivity: 'writing', activityLabel: 'Writing answer' };
  return { currentActivity: 'planning', activityLabel: 'Agent is planning' };
}

function setAgentActivity(message: ChatMessage, activity: AgentActivity, activityLabel: string) {
  message.metadata = {
    ...(message.metadata || {}),
    currentActivity: activity,
    activityLabel
  };
  if (message.versions?.length) {
    const index = message.activeVersion ?? message.versions.length - 1;
    if (message.versions[index]) {
      message.versions[index] = {
        ...message.versions[index],
        metadata: {
          ...(message.versions[index].metadata || {}),
          currentActivity: activity,
          activityLabel
        }
      };
    }
  }
}

function markAgentWriting(message: ChatMessage) {
  setAgentActivity(message, 'writing', 'Writing answer');
  const steps = message.agentSteps || [];
  const last = steps[steps.length - 1];
  if (last?.label === 'Writing answer') {
    last.status = 'running';
    last.detail = 'Preparing final response';
    message.agentSteps = [...steps];
    return;
  }
  message.agentSteps = [
    ...steps.map((step) => step.status === 'running' ? { ...step, status: 'done' as const } : step),
    { id: createId('step'), type: 'thinking', label: 'Writing answer', status: 'running', detail: 'Preparing final response' }
  ];
}

function updateStreamingVersion(message: ChatMessage, content: string, reasoning: string, metadata: MessageVersion['metadata']) {
  message.versions = [{
    content,
    createdAt: message.createdAt,
    reasoning,
    metadata
  }];
}

function appendStreamingContent(
  message: ChatMessage,
  chunk: string,
  reasoning: string,
  metadata: MessageVersion['metadata']
) {
  if (!chunk) return;
  message.content += chunk;
  updateStreamingVersion(message, message.content, reasoning, metadata);
}

function appendStreamingReasoning(current: string, chunk: string): string {
  const cleaned = normalizeStreamingReasoningDelta(chunk);
  if (!cleaned) return current;
  return `${current || ''}${cleaned}`;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
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

const WEB_RAG_MIN_ANSWER_CHARS = 200;
const WEB_RAG_MAX_SOURCES = 12;

function normalizeText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildWebRagPayload({ query, answer, sources }: { query: string; answer: string; sources: SearchResult[] }) {
  const sourceBlocks = (sources || [])
    .slice(0, WEB_RAG_MAX_SOURCES)
    .map((source, index) => {
      const title = normalizeText(source?.title || source?.url || `Source ${index + 1}`);
      const url = normalizeText(source?.url || '');
      const snippet = normalizeText(source?.snippet || source?.full_content || '');
      const provider = normalizeText(source?.provider || '');
      return [
        `# Source ${index + 1}`,
        `Title: ${title}`,
        url ? `URL: ${url}` : null,
        provider ? `Provider: ${provider}` : null,
        snippet ? `Snippet: ${snippet.slice(0, 1000)}` : null
      ].filter(Boolean).join('\n');
    })
    .join('\n\n---\n\n');

  const sections = [
    normalizeText(query) ? `User question:\n${normalizeText(query).slice(0, 3000)}` : '',
    normalizeText(answer) ? `Assistant answer:\n${normalizeText(answer).slice(0, 16000)}` : '',
    sourceBlocks ? `Sources:\n${sourceBlocks}` : ''
  ].filter(Boolean);

  return sections.join('\n\n');
}

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

function isAbortLikeError(value: unknown): boolean {
  const text = String(value || '').toLowerCase();
  return text.includes('abort') || text.includes('cancel');
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

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
  modelsRefreshing = $state(false);
  _apiModelsCache = new Map<string, ModelOption[]>();
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
  searchStateByChat = $state<Record<string, ChatSearchState>>({});
  downloadsOpen = $state(false);
  voiceModeActive = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  abortController = $state<AbortController | null>(null);
  activeRunsByChat = $state<Record<string, ActiveGenerationRun>>({});
  editingMessageId = $state<string | null>(null);
  editingMessageContent = $state('');
  searchMode = $state<'chat' | 'search' | 'deep' | 'max'>('chat');
  composerMode = $state<'chat' | 'agent'>('chat');
  pendingAttachments = $state<Attachment[]>([]);
  workspaceIndexing = $state(false);
  ragDocumentsByChat = $state<Record<string, IndexedDocument[]>>({});
  contextBudget = $state<ContextBudget | null>(null);
  apiModelMetadataByKey = $state<Record<string, ApiModelMetadata>>({});
  currentArtifact = $state<AgentArtifact | null>(null);
  currentArtifactMessageId = $state<string | null>(null);
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
  onboardingOpen = $state(false);
  onboardingCompleted = $state(false);
  userName = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem(USER_NAME_KEY) || '') : '');
  private closeWorkFingerprint = '';
  private contextBudgetRequestId = 0;

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

  get currentRun() {
    return this.currentChatId ? (this.activeRunsByChat[this.currentChatId] || null) : null;
  }

  get currentChatGenerating() {
    return !!this.currentRun;
  }

  get hasAnyGeneration() {
    return Object.keys(this.activeRunsByChat).length > 0;
  }

  isChatGenerating(chatId = this.currentChatId || '') {
    return !!(chatId && this.activeRunsByChat[chatId]);
  }

  hasOtherChatGeneration(chatId = this.currentChatId || '') {
    return Object.keys(this.activeRunsByChat).some((id) => id !== chatId);
  }

  get currentChatBlockedByOtherLocalRun() {
    return this.backendMode === 'local' && this.hasOtherChatGeneration(this.currentChatId || '');
  }

  get hasActiveWork() {
    return this.hasAnyGeneration || this.localModelLoading || downloadsStore.hasActive;
  }

  get activeWorkReasons() {
    const reasons: string[] = [];
    if (this.hasAnyGeneration) reasons.push('chat generation');
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

  private refreshGenerationState() {
    const runs = Object.values(this.activeRunsByChat);
    this.loading = runs.length > 0;
    this.abortController = this.currentRun?.controller || runs[0]?.controller || null;
  }

  private beginGenerationRun(chatId: string, run: ActiveGenerationRun) {
    this.activeRunsByChat = {
      ...this.activeRunsByChat,
      [chatId]: run
    };
    this.refreshGenerationState();
  }

  private endGenerationRun(chatId: string, controller?: AbortController) {
    const existing = this.activeRunsByChat[chatId];
    if (!existing) {
      this.refreshGenerationState();
      return;
    }
    if (controller && existing.controller !== controller) return;
    const next = { ...this.activeRunsByChat };
    delete next[chatId];
    this.activeRunsByChat = next;
    this.refreshGenerationState();
  }

  private queueWebAnswerRagIngest(params: { chatId: string; query: string; answer: string; sources: SearchResult[] }) {
    if (!isTauri()) return;
    const normalizedAnswer = normalizeText(params.answer);
    if (normalizedAnswer.length < WEB_RAG_MIN_ANSWER_CHARS) return;

    const text = buildWebRagPayload({
      query: params.query,
      answer: normalizedAnswer,
      sources: params.sources || []
    });
    if (!text) return;

    const sourceLabel = normalizeText(params.query).slice(0, 80) || 'web-answer';
    void ingestTextFast({
      source: `web_answer:${sourceLabel}`,
      text,
      chat_id: params.chatId,
      file_type: 'web_answer',
      chunk_size: 900
    }).catch((error) => {
      console.warn('[RAG] Background web answer ingest failed', error);
    });
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

  get currentSearchState() {
    return this.getSearchStateForChat(this.currentChatId || '');
  }

  getSearchStateForChat(chatId: string): ChatSearchState {
    if (!chatId) return { results: [], loading: false, query: '' };
    return this.searchStateByChat[chatId] || { results: [], loading: false, query: '' };
  }

  private setSearchStateForChat(chatId: string, patch: Partial<ChatSearchState>) {
    if (!chatId) return;
    const current = this.getSearchStateForChat(chatId);
    this.searchStateByChat = {
      ...this.searchStateByChat,
      [chatId]: {
        ...current,
        ...patch
      }
    };
  }

  async refreshContextBudgetPreview() {
    if (!isTauri() || typeof window === 'undefined' || !window.electronAPI?.invoke) {
      this.contextBudget = null;
      return;
    }

    const chat = this.currentChat;
    if (!chat) {
      this.contextBudget = null;
      return;
    }

    const requestId = ++this.contextBudgetRequestId;

    const draftContent = this.composer.trim();
    const workspaceContext = this.currentContextMode === 'work' && this.currentWorkspace
      ? buildWorkspacePrompt(this.currentWorkspace)
      : '';

    const currentMessages = buildRequestMessagesFromHistory(chat.messages);
    if (draftContent || this.pendingAttachments.length > 0) {
      currentMessages.push({
        role: 'user',
        content: this.buildContextualPrompt({
          content: draftContent,
          workspaceContext,
          mode: this.composerMode,
          searchMode: this.searchMode
        }),
        attachments: this.pendingAttachments
      });
    }

    const systemPrompt = this.getSystemPrompt();
    const outboundMessages = buildOutboundMessages({ messages: currentMessages, systemPrompt });
    try {
      const electronApi = getElectronApi();
      if (!electronApi) {
        this.contextBudget = null;
        return;
      }

      const provider = this.activeProvider;
      const budget = await resolveContextBudgetPreview({
        backendMode: this.backendMode,
        invoke: toInvoke(electronApi),
        messages: outboundMessages,
        localContextLength: this.config.llm?.local?.context_length,
        localMaxTokens: this.config.llm?.local?.max_tokens,
        providerMaxTokens: provider?.max_tokens,
        activeProviderModel: provider?.model,
        activeProviderName: this.activeProviderName,
        readCachedMetadata: (cacheKey) => this.apiModelMetadataByKey[cacheKey] || null,
        fetchMetadata: (providerName, model) => this.fetchApiModelMetadata(providerName, model)
      });

      if (requestId !== this.contextBudgetRequestId) return;
      this.contextBudget = budget;
    } catch {
      if (requestId === this.contextBudgetRequestId) {
        this.contextBudget = null;
      }
    }
  }

  private async fetchApiModelMetadata(providerName: string, model: string): Promise<ApiModelMetadata | null> {
    if (!isTauri() || typeof window === 'undefined' || !window.electronAPI?.invoke) {
      return null;
    }

    const cacheKey = buildApiModelMetadataCacheKey(providerName, model);

    const provider = this.activeProvider;
    if (!provider) return null;

    try {
      const metadata = await getCachedOrFetchApiModelMetadata({
        providerName,
        model,
        cache: this.apiModelMetadataByKey,
        fetchFresh: async () => {
          const electronApi = getElectronApi();
          if (!electronApi) return null;
          return fetchApiModelMetadataFromProvider({
            invoke: toInvoke(electronApi),
            providerName,
            model,
            baseUrl: provider.base_url || '',
            apiKey: provider.api_key || ''
          });
        }
      });
      if (metadata) {
        this.apiModelMetadataByKey = { ...this.apiModelMetadataByKey, [cacheKey]: metadata };
        return metadata;
      }
    } catch {
      // ignore
    }

    return null;
  }

  private getSystemPrompt(): string {
    return this.buildSystemPromptForMode({
      backendMode: this.backendMode,
      providerPrompt: this.config.llm?.providers?.[this.activeProviderName]?.system_prompt,
      includeChartHint: true
    });
  }

  private buildSystemPromptForMode(args: {
    backendMode: GenerationBackendMode;
    providerPrompt?: string;
    includeChartHint?: boolean;
    searchSystemPrefix?: string;
  }): string {
    const basePrompt = selectBaseSystemPrompt({
      backendMode: args.backendMode,
      localPrompt: this.config.llm?.local?.system_prompt,
      providerPrompt: args.providerPrompt,
      globalPrompt: this.config.llm?.system_prompt
    });
    return buildSystemPrompt({
      basePrompt,
      userName: this.userName,
      searchSystemPrefix: args.searchSystemPrefix,
      includeChartHint: args.includeChartHint
    });
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
    if (!artifact && messageId && this.currentChat) {
      const msg = this.currentChat.messages.find(m => m.id === messageId);
      artifact = msg?.artifact || null;
    }
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
      const hasRememberedContext = Object.prototype.hasOwnProperty.call(remembered, 'context_length');
      const hasRememberedGpu = Object.prototype.hasOwnProperty.call(remembered, 'gpu_offload');
      const recommendedContextHint = hasRememberedContext ? pickNumber(remembered.context_length) : undefined;
      const recommendedGpuHint = hasRememberedGpu ? pickNumber(remembered.gpu_offload) : undefined;
      const settings = await getRecommendedSettings(
        model.path,
        recommendedContextHint,
        recommendedGpuHint,
        this.localModelLoadRuntimePath || this.config.llm?.local?.runtime_path
      );
      this.localModelLoadContextLength = String(pickNumber(
        remembered.context_length,
        settings.context_length,
        model.context_length,
        this.config.llm?.local?.context_length,
        4096
      ) ?? 4096);
      this.localModelLoadGpuLayers = String(pickNumber(
        remembered.gpu_offload,
        settings.gpu_layers,
        this.config.llm?.local?.gpu_layers,
        0
      ) ?? 0);
      this.localModelLoadCpuThreads = String(pickNumber(
        remembered.cpu_threads,
        settings.cpu_threads,
        this.config.llm?.local?.cpu_threads,
        navigator.hardwareConcurrency,
        4
      ) ?? 4);
      this.localModelLoadBatchSize = String(pickNumber(
        remembered.batch_size,
        settings.batch_size,
        this.config.llm?.local?.batch_size,
        512
      ) ?? 512);
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
      this.localModelLoadContextLength = String(pickNumber(
        remembered.context_length,
        this.config.llm?.local?.context_length,
        model.context_length,
        4096
      ) ?? 4096);
      this.localModelLoadGpuLayers = String(pickNumber(
        remembered.gpu_offload,
        this.config.llm?.local?.gpu_layers,
        0
      ) ?? 0);
      this.localModelLoadCpuThreads = String(pickNumber(
        remembered.cpu_threads,
        this.config.llm?.local?.cpu_threads,
        navigator.hardwareConcurrency,
        4
      ) ?? 4);
      this.localModelLoadBatchSize = String(pickNumber(
        remembered.batch_size,
        this.config.llm?.local?.batch_size,
        512
      ) ?? 512);
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
    let dir = modelPath.replace(/[/\\][^/\\]+$/, '');
    try {
      const direct = await pathExists(modelPath);
      if (direct && !/\.gguf$/i.test(modelPath)) {
        dir = modelPath;
      }
    } catch {
      // ignore path probing errors
    }
    const normalizedDir = dir.replace(/\\/g, '/');
    const windowsDir = dir.replace(/\//g, '\\');
    const candidates = ['mmproj-BF16.gguf', 'mmproj-F16.gguf', 'mmproj-F32.gguf', 'mmproj.gguf'];
    for (const name of candidates) {
      const fullPathCandidates = Array.from(new Set([
        `${normalizedDir}/${name}`,
        `${windowsDir}\\${name}`,
        `${dir}/${name}`,
        `${dir}\\${name}`
      ]));
      try {
        for (const fullPath of fullPathCandidates) {
          const exists = await pathExists(fullPath);
          if (exists) return fullPath;
        }
      } catch { /* ignore */ }
    }

    const modelBase = (modelPath.split(/[/\\]/).pop() || '').replace(/\.gguf$/i, '');
    if (modelBase) {
      const dynamicCandidates = Array.from(new Set([
        `mmproj-${modelBase}.gguf`,
        `${modelBase}-mmproj.gguf`,
        `${modelBase}.mmproj.gguf`,
        `${modelBase}.projector.gguf`,
        `projector-${modelBase}.gguf`
      ]));
      for (const name of dynamicCandidates) {
        const fullPathCandidates = Array.from(new Set([
          `${normalizedDir}/${name}`,
          `${windowsDir}\\${name}`,
          `${dir}/${name}`,
          `${dir}\\${name}`
        ]));
        try {
          for (const fullPath of fullPathCandidates) {
            const exists = await pathExists(fullPath);
            if (exists) return fullPath;
          }
        } catch { /* ignore */ }
      }
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
        gpu_layers: this.localModelLoadGpuLayers === '' ? undefined : Number(this.localModelLoadGpuLayers),
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
          gpu_offload: this.localModelLoadGpuLayers === '' ? undefined : Number(this.localModelLoadGpuLayers),
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
              gpu_layers: this.localModelLoadGpuLayers === '' ? undefined : Number(this.localModelLoadGpuLayers),
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
        gpuLayers: this.localModelLoadGpuLayers === '' ? undefined : Number(this.localModelLoadGpuLayers),
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
      await modelsStore.refreshIndex();
      await modelsStore.refreshStatus();
      this.localModelLoadProgress = 100;
      this.localModelLoadPhase = 'Model ready';
      this.localModelActive = {
        name: this.localModelLoadTarget?.name || 'local model',
        path: this.localModelLoadTarget?.path || '',
        hasMmproj: !!(this.localModelLoadMmprojPath),
      };
      toastStore.success(`Model loaded: ${this.localModelLoadTarget?.name || 'local model'}`);
      if (isTauri()) {
        detectToolSupport().catch(() => {});
      }
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
      const configResult = await withTimeout<AppConfig | typeof CONFIG_TIMEOUT_SENTINEL>(loadChatConfig(), 5000, CONFIG_TIMEOUT_SENTINEL);
      if (configResult === CONFIG_TIMEOUT_SENTINEL) {
        console.warn('[appStore.init] Config load timed out after 5s — using empty config fallback. Backend mode will default to local.');
        this.config = {};
      } else {
        this.config = configResult;
      }
      // In Electron: load from SQLite (primary). Falls back to localStorage migration.
      const dbResult = await loadChatStateFromDb();
      let chats: ChatSession[];
      let folders: ChatFolder[];
      let currentChatId: string | null;

      if (dbResult && dbResult.chats.length > 0) {
        chats = dbResult.chats;
        folders = dbResult.folders;
        // Restore currentChatId from localStorage (not stored in DB)
        const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
        currentChatId = persisted.currentChatId;
      } else {
        const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
        chats = Array.isArray(persisted.chats) ? persisted.chats : [];
        folders = Array.isArray(persisted.folders) ? persisted.folders : [];
        currentChatId = persisted.currentChatId;
      }

      this.chats = chats.map((chat, index) => normalizeChat(chat, index));
      this.folders = folders.map((folder, index) => normalizeFolder(folder, index));
      this.currentChatId = currentChatId;

      if (!this.chats.length) {
        this.createChat();
      } else if (!this.currentChat) {
        this.currentChatId = this.chats[0]?.id || null;
      }
    } catch (error) {
      this.error = toErrorMessage(error) || 'Failed to initialize application';
      if (!this.chats.length) {
        this.createChat();
      }
      console.error('[appStore.init] failed', error);
    } finally {
      this.ready = true;
    }

    void withTimeout(this.refreshModels(), 2500, undefined);
    if (isTauri()) {
      void detectToolSupport().catch(() => {});
    }
    if (isTauri()) {
      void Promise.allSettled([
        withTimeout(modelsStore.refreshIndex(), 2500, undefined),
        withTimeout(modelsStore.refreshStatus(), 2500, undefined),
        withTimeout(downloadsStore.refresh(), 2500, undefined),
        withTimeout(this.refreshRagDocuments(), 2500, undefined)
      ]);
      void modelsStore.initPushEvents().then(() => {
        modelsStore.startPolling(3000);
      });
    }

    // Check first-run onboarding
    if (isTauri()) {
      void this.checkOnboarding();
    }
  }

  private async checkOnboarding() {
    try {
      const { checkIsFirstRun } = await import('$lib/services/onboarding');
      const isFirstRun = await checkIsFirstRun();
      if (isFirstRun) {
        this.onboardingOpen = true;
      }
      this.onboardingCompleted = !isFirstRun;
    } catch {
      // ignore — onboarding is optional
    }
  }

  persist() {
    saveChatState<PersistedState>({
      chats: this.chats,
      folders: this.folders,
      currentChatId: this.currentChatId
    });
    // Also persist the visible chat and any background chats with active runs to SQLite.
    const chatIds = new Set<string>();
    if (this.currentChatId) chatIds.add(this.currentChatId);
    for (const chatId of Object.keys(this.activeRunsByChat)) {
      chatIds.add(chatId);
    }
    for (const chatId of chatIds) {
      const chat = this.findChat(chatId);
      if (chat) saveChatStateToDb(chat);
    }
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
    this.refreshGenerationState();
    this.composer = '';
    this.persist();
    return chat;
  }

  selectChat(chatId: string) {
    const match = this.chats.find((chat) => chat.id === chatId);
    if (!match) return;

    for (const attachment of this.pendingAttachments) {
      if (attachment.preview?.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.preview);
      }
    }
    this.pendingAttachments = [];

    this.currentChatId = chatId;
    this.refreshGenerationState();
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
    if (this.isChatGenerating(chatId)) {
      this.stopStreaming(chatId);
    }
    const title = this.chats.find((c) => c.id === chatId)?.title;
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    const activeRuns = { ...this.activeRunsByChat };
    delete activeRuns[chatId];
    this.activeRunsByChat = activeRuns;
    this.refreshGenerationState();
    delete this.ragDocumentsByChat[chatId];
    const searchStates = { ...this.searchStateByChat };
    delete searchStates[chatId];
    this.searchStateByChat = searchStates;
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
    if (isTauri()) {
      clearRagDocuments(chatId).catch(() => {});
    }
    deleteChatFromDb(chatId).catch(() => {});
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
    return this.appendMessageToChat(this.currentChatId || '', message);
  }

  private appendMessageToChat(chatId: string, message: ChatMessage) {
    const chat = this.findChat(chatId);
    if (!chat) return null;
    chat.messages = [...chat.messages, message];
    chat.updatedAt = Date.now();
    if (chat.title === 'New chat' && message.role === 'user') {
      chat.title = message.content.slice(0, 48) || 'New chat';
    }
    this.touchChats(); // notify reactive subscribers of array mutation
    this.persist();
    return message;
  }

  touchChats() {
    this.chats = [...this.chats];
  }

  private findChat(chatId: string | null | undefined) {
    if (!chatId) return null;
    return this.chats.find((chat) => chat.id === chatId) || null;
  }

  private buildSearchConversationContext(currentUserMessageId?: string, chatId = this.currentChatId || '') {
    const chat = this.findChat(chatId);
    if (!chat) return '';

    const entries = chat.messages
      .filter((message) => message.id !== currentUserMessageId || message.role === 'user')
      .filter((message) => message.role === 'user' || normalizeText(message.content))
      .filter((message) => message.done !== false || message.role === 'user')
      .slice(-8)
      .map((message) => {
        const label = message.role === 'user' ? 'User' : 'Assistant';
        const text = normalizeText(message.content).slice(0, 700);
        const attachments = (message.attachments || [])
          .filter((attachment) => attachment.kind !== 'image')
          .map((attachment) => attachment.name)
          .filter(Boolean)
          .slice(0, 4);
        const attachmentText = attachments.length ? ` Attachments: ${attachments.join(', ')}.` : '';
        return text ? `${label}: ${text}${attachmentText}` : (attachmentText ? `${label}:${attachmentText}` : '');
      })
      .filter(Boolean);

    return entries.join('\n').slice(-3000);
  }

  private buildContextualPrompt(args: {
    content: string;
    searchContext?: string;
    researchSummary?: string;
    ragContext?: string;
    workspaceContext?: string;
    mode: 'chat' | 'agent';
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
      if (args.mode === 'agent') {
        guidance.push([
          'You are in agent mode with workspace context attached as read-only reference.',
          'Do not claim direct host file access. Agent-created files must be chat sandbox artifacts saved with this conversation.',
          'Use <workspace> for project structure and filenames, and use <documents> for retrieved excerpts when relevant.',
          'When you mention implementation details, ground them in the provided file paths and avoid inventing files that are not present.'
        ].join(' '));
      } else {
        guidance.push([
          'You are in work mode with a project workspace attached.',
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
    }
    if (args.mode === 'agent') {
      const searchModeLabel = args.searchMode && args.searchMode !== 'chat' ? args.searchMode : 'chat';
      guidance.push([
        'You are operating in autonomous agent mode.',
        `Current search mode preference: ${searchModeLabel}.`,
        'Turn useful work into artifacts instead of only replying in chat.',
        'For research or competitor analysis, create a report file the user can open or download.',
        'When the user asks for slides, a deck, a document, an Excel workbook, or a PDF, use the matching artifact tool so the chat gets a real file and viewer.',
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

  async performWebSearch(query: string, chatId = this.currentChatId || '') {
    const trimmed = String(query || '').trim();
    const targetChatId = chatId || '';
    if (!targetChatId) return;
    if (!trimmed) {
      this.setSearchStateForChat(targetChatId, { results: [], query: '', loading: false });
      return;
    }

    this.setSearchStateForChat(targetChatId, { loading: true, query: trimmed });
    try {
      const response = await webSearch({
        query: trimmed,
        context: this.buildSearchConversationContext(undefined, targetChatId),
        deep: false,
        mode: 'search'
      });
      this.setSearchStateForChat(targetChatId, {
        results: Array.isArray(response.results) ? response.results : [],
        loading: false,
        query: trimmed
      });
    } catch (error) {
      this.setSearchStateForChat(targetChatId, { results: [], loading: false, query: trimmed });
      toastStore.error(toErrorMessage(error) || 'Search failed');
    }
  }

  openSearchSidebarWithResults(results: SearchResult[], chatId = this.currentChatId || '') {
    if (chatId) {
      this.setSearchStateForChat(chatId, {
        results: Array.isArray(results) ? results : [],
        loading: false
      });
    }
    this.searchSidebarOpen = true;
  }

  setComposerMode(mode: 'chat' | 'agent') {
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
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!isTauri() || !targetChatId || !targetChat) return;
    await clearRagDocuments(targetChatId);
    this.pendingAttachments = [];
    if (targetChat.workspace) {
      targetChat.workspace = null;
      if (targetChat.contextMode === 'work') {
        targetChat.contextMode = 'chat';
      }
      this.touchChats();
      this.persist();
    }
    await this.refreshRagDocuments(targetChatId);
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
    const targetChatId = this.currentChatId;
    if (!files.length || !targetChatId) return;

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
        // Read base64 for vision API calls.
        attachment.base64 = await readBlobAsDataUrl(file);
        const visionReady = await hasConfiguredVisionModel(this.config);
        attachment.visionReady = visionReady;
        attachment.processingMode = visionReady ? 'vision' : 'ocr';

        if (!visionReady) {
          try {
            const { extractTextFromFile } = await import('$lib/services/ocr');
            const ocrText = await extractTextFromFile(file);
            if (ocrText.trim()) attachment.ocrText = ocrText.trim();
          } catch (err: unknown) {
            console.warn('[addFiles] OCR failed for image:', err);
          }
        }
        attachment.status = 'ready';
        nextAttachments.push(attachment);
        continue;
      }

      // Create blob URL for document preview
      const fileBuffer = await file.arrayBuffer();
      const fileBlob = new Blob([fileBuffer], { type: file.type });
      attachment.data = await readBlobAsDataUrl(fileBlob);
      attachment.size = fileBlob.size;
      attachment.processingMode = 'document_text';

      // Documents: try backend RAG ingestion, fallback to client-side extraction
      try {
        const bytes = new Uint8Array(fileBuffer);
        const tempPath = await writeTempFile(`${Date.now()}_${file.name}`, bytes);
        const doc = await ingestDocument({
          file_path: tempPath,
          chat_id: targetChatId
        });
        attachment.docId = doc.id;
        attachment.status = 'ready';
        nextAttachments.push(attachment);
      } catch (error) {
        // Backend RAG failed — try client-side text extraction (OCR/PDF.js)
        console.warn('[addFiles] Backend ingest failed, trying client-side extraction:', error);

        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        const errorMessage = toErrorMessage(error) || 'Failed to process file';
        const parserFailed = isPdf && /could not parse pdf text|pdf parser returned insufficient readable text/i.test(errorMessage);

        if (parserFailed) {
          attachment.status = 'error';
          attachment.error = 'PDF parser could not extract readable text. Please upload a text-based PDF export.';
          nextAttachments.push(attachment);
          continue;
        }

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
          attachment.error = toErrorMessage(error) || 'Failed to process file';
        }
        nextAttachments.push(attachment);
      }
    }

    if (this.currentChatId === targetChatId) {
      this.pendingAttachments = [...this.pendingAttachments, ...nextAttachments];
    } else {
      for (const attachment of nextAttachments) {
        if (attachment.preview?.startsWith('blob:')) URL.revokeObjectURL(attachment.preview);
      }
    }
    await this.refreshRagDocuments(targetChatId);
  }

  private async clearWorkspaceDocs(chatId = this.currentChatId || '') {
    const chat = this.findChat(chatId);
    if (!chatId || !chat?.workspace?.files?.length) return;
    await Promise.allSettled(
      chat.workspace.files
        .map((file) => file.docId)
        .filter((docId): docId is string => !!docId)
        .map((docId) => removeRagDocument(docId, chatId))
    );
  }

  async pickWorkspaceFolder() {
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!isTauri() || !targetChatId || !targetChat) return;
    const selectedPath = await pickWorkspaceFolderDialog();
    if (!selectedPath) return;

    this.workspaceIndexing = true;
    this.error = null;

    try {
      await this.clearWorkspaceDocs(targetChatId);
      const result = await indexWorkspaceFolder(selectedPath, targetChatId);
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      chat.workspace = {
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
      chat.contextMode = 'work';
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments(targetChatId);
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
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!files.length || !targetChatId || !targetChat) return;

    this.workspaceIndexing = true;
    this.error = null;
    try {
      await this.clearWorkspaceDocs(targetChatId);

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
              chat_id: targetChatId,
              file_type: workspaceFile.type
            });
            workspaceFile.docId = doc.id;
            indexedCount += 1;
            indexedSoFar += 1;
          }
        } catch (error) {
          workspaceFile.status = 'error';
          workspaceFile.reason = toErrorMessage(error) || 'Failed to index file';
          skippedCount += 1;
        }

        workspaceFiles.push(workspaceFile);
      }

      const rootName = workspaceFiles[0]?.path.split('/')[0] || sortedFiles[0]?.name || 'Workspace';
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      chat.workspace = {
        rootName,
        rootPath: undefined,
        attachedAt: Date.now(),
        fileCount: workspaceFiles.length,
        indexedCount,
        skippedCount,
        files: workspaceFiles
      };
      chat.contextMode = 'work';
      this.touchChats();
      this.persist();
      await this.refreshRagDocuments(targetChatId);

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
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if (!targetChatId || !targetChat?.workspace) return;
    const docIds = targetChat.workspace.files
      .map((file) => file.docId)
      .filter((docId): docId is string => !!docId);
    await Promise.allSettled(docIds.map((docId) => removeRagDocument(docId, targetChatId)));
    targetChat.workspace = null;
    targetChat.contextMode = 'chat';
    this.touchChats();
    this.persist();
    await this.refreshRagDocuments(targetChatId);
    toastStore.info('Workspace removed from this chat.', 2200);
  }

  /** Re-scan the workspace folder after LLM creates new files */
  async refreshWorkspace(chatId = this.currentChatId || '') {
    const chat = this.findChat(chatId);
    const rootPath = chat?.workspace?.rootPath;
    if (!rootPath || !chatId || !isTauri()) return;
    this.workspaceIndexing = true;
    try {
      await this.clearWorkspaceDocs(chatId);
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
      await this.refreshRagDocuments(chatId);
    } finally {
      this.workspaceIndexing = false;
    }
  }

  /** Create a file inside the workspace from the UI */
  async createWorkspaceFile(relativePath: string, docType: string, content: string): Promise<string> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    const fullPath = await createWorkspaceDocument(rootPath, relativePath, docType, content);
    await this.refreshWorkspace(targetChatId);
    return fullPath;
  }

  async renameWorkspaceFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await renameWorkspaceFile(rootPath, oldRelPath, newRelPath);
    await this.refreshWorkspace(targetChatId);
    toastStore.info(`Renamed to ${newRelPath.split('/').pop()}`, 2000);
  }

  async deleteWorkspaceFile(relativePath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await deleteWorkspaceFile(rootPath, relativePath);
    await this.refreshWorkspace(targetChatId);
    toastStore.info(`Deleted ${relativePath.split('/').pop()}`, 2000);
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    return readWorkspaceFile(rootPath, relativePath);
  }

  async openWorkspaceFile(relativePath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    const fullPath = `${rootPath}/${relativePath}`;
    await openWorkspaceFile(fullPath);
  }

  async createWorkspaceFolder(relativePath: string): Promise<void> {
    const targetChatId = this.currentChatId || '';
    const rootPath = this.findChat(targetChatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    await createWorkspaceFolder(rootPath, relativePath);
    await this.refreshWorkspace(targetChatId);
    toastStore.info(`Folder created`, 2000);
  }

  private canStartGeneration(params: {
    backendMode: GenerationBackendMode;
    targetChatId: string;
    activeProvider?: { has_api_key?: boolean; api_key?: string } | null;
    localBusyActionText?: string;
  }): boolean {
    if (this.isChatGenerating(params.targetChatId)) return false;

    if (params.backendMode === 'local' && this.hasOtherChatGeneration(params.targetChatId)) {
      const actionText = params.localBusyActionText || 'starting a local response here';
      toastStore.info(`Local model is busy in another chat. Stop that run before ${actionText}.`, 3200);
      return false;
    }

    if (params.backendMode === 'local') {
      if (!this.selectedLocalModelPath) {
        toastStore.error('No local model selected. Open Model Hub to download and load a model.');
        return false;
      }
      if (!this.localModelActive) {
        toastStore.error('No model is loaded yet. Load a model from the Model Hub first, then try again.');
        return false;
      }
    }

    if (params.backendMode === 'api' && !params.activeProvider?.has_api_key && !params.activeProvider?.api_key) {
      toastStore.error('No API key configured. Open Settings to add a provider key.');
      return false;
    }

    return true;
  }

  async sendCurrentMessage() {
    const content = this.composer.trim();
    const targetChatId = this.currentChatId;
    const targetChat = this.findChat(targetChatId);
    if ((!content && this.pendingAttachments.length === 0) || !targetChat || !targetChatId) return;

    const activeBackendMode = this.backendMode as GenerationBackendMode;

    const activeModelLabel = this.activeModelLabel;
    const activeProvider = this.activeProvider;
    const activeProviderApiKey = activeProvider?.api_key;
    const activeSearchMode = this.searchMode;
    const activeComposerMode = this.composerMode;
    const activeContextMode = targetChat.contextMode || 'chat';
    const activeWorkspace = activeContextMode === 'work' ? targetChat.workspace : null;
    const targetRagDocuments = this.ragDocumentsByChat[targetChatId] || [];

    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider
    })) return;

    this.error = null;
    const targetChatTitle = targetChat?.title || 'New chat';
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
      mode: activeComposerMode,
      searchMode: activeSearchMode,
      workContext
    };

    this.appendMessageToChat(targetChatId, userMessage);
    this.composer = '';
    targetChat.draft = '';
    const sentAttachments = [...this.pendingAttachments];
    this.pendingAttachments = [];

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      done: false,
      status: 'streaming',
      model: activeModelLabel,
      versions: [],
      activeVersion: 0,
      searchMode: activeSearchMode,
      mode: activeComposerMode,
      reasoning: '',
      metadata: activeComposerMode === 'agent'
        ? {
            modelName: activeModelLabel,
            ...executionMetadata(activeBackendMode),
            currentActivity: 'planning',
            activityLabel: 'Agent is planning'
          }
        : undefined,
      workContext,
      agentSteps: activeComposerMode === 'agent'
        ? [{ id: createId('step'), type: 'thinking', label: 'Planning', status: 'running', detail: 'Preparing tools and context' }]
        : [],
      artifact: null
    };

    this.appendMessageToChat(targetChatId, assistantMessage);

    const SYNC_INTERVAL_MS = 50;
    let lastSyncTime = 0;
    let pendingSync = false;
    const syncMsg = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSyncTime < SYNC_INTERVAL_MS) {
        pendingSync = true;
        return;
      }
      pendingSync = false;
      lastSyncTime = now;
      const chat = this.findChat(targetChatId);
      if (!chat) return;
      const idx = chat.messages.findIndex((m) => m.id === assistantMessage.id);
      if (idx >= 0) {
        chat.messages[idx] = { ...assistantMessage };
        chat.updatedAt = Date.now();
      }
    };
    const flushPendingSync = () => {
      if (pendingSync) {
        pendingSync = false;
        lastSyncTime = 0;
        syncMsg(true);
      }
    };

    const controller = new AbortController();
    this.beginGenerationRun(targetChatId, {
      controller,
      messageId: assistantMessage.id,
      backendMode: activeBackendMode,
      mode: activeComposerMode,
      startedAt: Date.now()
    });
    const searchConversationContext = this.buildSearchConversationContext(userMessage.id, targetChatId);
    const startTime = Date.now();
    const reasoningTimer = startReasoningTimer();
    let exactUsage: CompletionResult['usage'] = null;
    this.searchMode = 'chat';
    if (activeComposerMode !== 'agent') {
      this.composerMode = 'chat';
    }

    try {
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
                mode: activeSearchMode,
                conversationContext: searchConversationContext
              }).then((task) => ({
                context: task.context,
                results: task.results,
                provider_used: task.providerUsed || 'auto',
                researchTaskId: task.id,
                researchSummary: task.summary,
                researchStatus: task.status,
                researchStats: task.crawlStats || null
              }))
            : await webSearch({
                query: content,
                context: searchConversationContext,
                deep: activeSearchMode !== 'search',
                mode: activeSearchMode
              });
          searchContext = searchResponse.context || '';
          sources = searchResponse.results || [];
          searchMeta = {
            searchRequested: true,
            searchSucceeded: !('error' in searchResponse && searchResponse.error),
            contextAvailable: !!(searchResponse.context || searchResponse.results?.length),
            sourceCount: searchResponse.results?.length || 0,
            requestedProvider: this.config.search?.provider || 'auto',
            providerUsed: searchResponse.provider_used || null,
            researchTaskId: 'researchTaskId' in searchResponse ? String(searchResponse.researchTaskId || '') || null : null,
            researchStatus: 'researchStatus' in searchResponse ? (searchResponse.researchStatus as SearchMeta['researchStatus']) : ('researchSummary' in searchResponse ? 'completed' : null),
            researchSummary: 'researchSummary' in searchResponse ? String(searchResponse.researchSummary || '') || null : null,
            researchStats: 'researchStats' in searchResponse ? (searchResponse.researchStats as SearchMeta['researchStats']) : null,
            providerAttempts: 'provider_attempts' in searchResponse ? (searchResponse.provider_attempts as SearchMeta['providerAttempts']) : [],
            searchFallbackReason: '',
            providerWarnings: [],
            searchError: 'error' in searchResponse ? (searchResponse.error || '') : ''
          };

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
            researchStats: null,
            providerAttempts: [],
            searchFallbackReason: '',
            providerWarnings: [],
            searchError: toErrorMessage(error) || 'Search did not return a result'
          };
        }
      }

      if (isTauri() && targetRagDocuments.length && activeSearchMode === 'chat') {
        const ragResponse = await queryDocuments({
          query: content,
          chat_id: targetChatId,
          top_k: 5
        });
        ragContext = ragResponse.context || '';
        const docIds = new Set(ragResponse.results.map((result) => result.chunk.doc_id));
        ragDocuments = targetRagDocuments.filter((doc) => docIds.has(doc.id));
      }

      assistantMessage.sources = sources;
      assistantMessage.searchMeta = searchMeta;
      assistantMessage.ragDocuments = ragDocuments;
      syncMsg(true); // push initial metadata (sources, searchMeta) to the reactive array
      this.persist();

      const requestMessages = buildRequestMessagesWithPatchedUser({
        messages: targetChat.messages,
        assistantMessageId: assistantMessage.id,
        userMessageId: userMessage.id,
        userContent: content,
        buildContextualPrompt: (userContent) => this.buildContextualPrompt({
          content: userContent,
          searchContext,
          researchSummary: searchMeta?.researchSummary || '',
          ragContext,
          workspaceContext,
          mode: activeComposerMode,
          searchMode: activeSearchMode
        })
      });

      const searchSystemPrefix = searchContext ? buildSearchSystemPrefix() : undefined;
      const systemPrompt = this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt,
        searchSystemPrefix,
        includeChartHint: activeComposerMode !== 'agent'
      });

      const outboundMessages = buildOutboundMessages({ messages: requestMessages, systemPrompt });
      // Context window budget check (local mode only)
      if (activeBackendMode === 'local' && isTauri()) {
        try {
          const electronApi = getElectronApi();
          if (electronApi) {
            await applyLocalContextBudgetTruncation({
              backendMode: activeBackendMode,
              isTauri: true,
              config: this.config,
              messages: outboundMessages,
              invoke: toInvoke(electronApi),
              onTruncated: (removed) => {
                toastStore.info(`Context window full. ${removed} older message(s) truncated to fit.`, 4000);
              }
            });
          }
        } catch {
          // Silently continue if budget check fails
        }
      }

      if (activeComposerMode === 'agent' && targetChatId) {
        const agentResult = await runAgentTask({
          chatId: targetChatId,
          systemPrompt,
          messages: requestMessages,
          rawPrompt: content,
          conversationContext: searchConversationContext,
          executionMode: 'sandbox',
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          signal: controller.signal,
          onStep: (steps) => {
            assistantMessage.agentSteps = steps;
            const running = steps.find((step) => step.status === 'running');
            if (running) {
              const mapped = activityFromProgress(running.label);
              setAgentActivity(assistantMessage, mapped.currentActivity, mapped.activityLabel);
            }
            syncMsg(true);
            this.persist();
          },
          onProgress: (text) => {
            const mapped = activityFromProgress(text);
            setAgentActivity(assistantMessage, mapped.currentActivity, mapped.activityLabel);
            syncMsg();
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            assistantMessage.reasoning = value;
            syncMsg();
          },
          onArtifact: (artifact) => {
            assistantMessage.artifact = artifact;
            syncMsg(true);
            this.persist();
            if (this.currentChatId === targetChatId && (artifact || this.currentArtifactMessageId === assistantMessage.id)) {
              this.setCurrentArtifact(artifact, assistantMessage.id);
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
              syncMsg(true);
              this.persist();
            }
          }
        });
        markAgentWriting(assistantMessage);
        syncMsg(true);
        this.persist();
        // Handle agent result - check for errors or warnings
        const outcome = agentOutcome(agentResult);
        const stopReason = agentStopReason(agentResult);
        const usableAgentResult = hasUsableAgentResult(agentResult);
        if (outcome === 'failed' && agentResult.error && !usableAgentResult) {
          // Fatal agent failure: no usable evidence/content was produced.
          assistantMessage.content = agentResult.content || agentResult.error;
          assistantMessage.status = 'error';
          assistantMessage.done = true;
          assistantMessage.metadata = {
            ...finalizeAssistantMetadata({
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                error: true,
                errorMessage: agentResult.error,
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent failed',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
        } else if (agentResult.warning || outcome === 'partial' || outcome === 'stopped') {
          // Partial/stopped agents keep their evidence and render as a normal answer with a warning.
          assistantMessage.content = agentResult.content;
          assistantMessage.done = true;
          assistantMessage.status = 'idle';
          assistantMessage.metadata = {
            ...finalizeAssistantMetadata({
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                warning: agentResult.warning || agentResult.error || 'Agent stopped before normal completion.',
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent stopped',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
          if (agentResult.error && !usableAgentResult) {
            if (this.config.ui?.agent_debug_logs) {
              console.warn('[agent]', agentResult.warning || agentResult.error);
            }
          } else {
            if (this.config.ui?.agent_debug_logs) {
              console.info('[agent]', agentResult.warning || 'Agent stopped with usable gathered evidence.');
            }
          }
        } else {
          assistantMessage.content = agentResult.content;
          assistantMessage.metadata = {
            ...(assistantMessage.metadata || {}),
            ...executionMetadata(activeBackendMode),
            outcome,
            stopReason,
            currentActivity: 'completed',
            activityLabel: 'Agent finished',
            workProduct: agentResult.artifact?.workProduct ? {
              id: agentResult.artifact.workProduct.id,
              kind: agentResult.artifact.workProduct.kind,
              title: agentResult.artifact.workProduct.title,
              primaryFile: agentResult.artifact.workProduct.files[0]?.path,
              status: agentResult.artifact.workProduct.status
            } : undefined,
            publicFallback: !!agentResult.publicFallback,
            diagnosticsRedacted: !!agentResult.diagnosticsRedacted
          };
        }
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
          assistantMessage.searchMeta = {
            ...(assistantMessage.searchMeta || {
              searchRequested: true,
              searchSucceeded: true,
              contextAvailable: true,
              sourceCount: 0
            }),
            searchRequested: true,
            searchSucceeded: true,
            contextAvailable: true,
            sourceCount: assistantMessage.sources.length,
            stopReason
          };
        }
        syncMsg(true);
        this.persist();
        if (this.currentChatId === targetChatId && (agentResult.artifact || this.currentArtifactMessageId === assistantMessage.id)) {
          this.setCurrentArtifact(agentResult.artifact, assistantMessage.id);
        }
        // Agent artifacts are chat-sandboxed, so there is no host workspace write to rescan here.
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          apiKey: activeProviderApiKey,
          onChunk: (value) => {
            appendStreamingContent(
              assistantMessage,
              value,
              assistantMessage.reasoning || '',
              assistantMessage.metadata
            );
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
            reasoningTimer.markStarted();
            assistantMessage.reasoning = appendStreamingReasoning(assistantMessage.reasoning || '', value);
            updateStreamingVersion(
              assistantMessage,
              assistantMessage.content,
              assistantMessage.reasoning,
              assistantMessage.metadata
            );
            syncMsg();
          },
          onUsage: (usage) => {
            exactUsage = usage || exactUsage;
          }
        });
      }

      assistantMessage.done = true;
      // Only set status to 'idle' if it wasn't already set to 'error'
      if (assistantMessage.status !== 'error') {
        assistantMessage.status = 'idle';
      }
      const timing = (Date.now() - startTime) / 1000;
      assistantMessage.metadata = finalizeAssistantMetadata({
        existing: assistantMessage.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        usage: exactUsage,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds()
      });
      assistantMessage.model = activeModelLabel;
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
      if (assistantMessage.mode === 'agent' && assistantMessage.agentSteps?.length) {
        const hasError = assistantMessage.metadata?.error;
        const hasWarning = assistantMessage.metadata?.warning;
        assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
          if (index === all.length - 1) {
            if (hasError) {
              return { ...step, status: 'error', detail: step.detail || 'Agent encountered an error' };
            } else if (hasWarning) {
              return { ...step, status: 'done', detail: hasWarning };
            }
            return { ...step, status: 'done', detail: assistantMessage.metadata?.outcome === 'completed' ? 'Response ready' : step.detail };
          }
          return { ...step, status: step.status === 'running' ? 'done' : step.status };
        });
      }

      const responseSources = ((assistantMessage.sources && assistantMessage.sources.length)
        ? assistantMessage.sources
        : sources) as SearchResult[];
      if (targetChatId && responseSources.length > 0) {
        this.queueWebAnswerRagIngest({
          chatId: targetChatId,
          query: content,
          answer: assistantMessage.content,
          sources: responseSources
        });
      }

      // ── Work mode file writing ──────────────────────────────────────
      const activeWorkspaceRoot = activeWorkspace?.rootPath;
      if (activeComposerMode !== 'agent' && activeWorkspaceRoot && isTauri() && assistantMessage.content) {
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
            void this.refreshWorkspace(targetChatId);
          }
        }
      }
      // ───────────────────────────────────────────────────────────────

      syncMsg(true);
      this.persist();

      if (this.config.tts?.enable_voice_output && this.config.tts?.auto_play_voice && assistantMessage.content) {
        try {
          void ttsStore.speak(assistantMessage.id, assistantMessage.content, this.config);
        } catch {
          // ignore TTS auto-play failures
        }
      }

      // Auto-generate a smarter chat title after the first exchange
      void this.generateChatTitle(targetChatId, activeProviderApiKey);
    } catch (error) {
      const errorMsg = toErrorMessage(error) || 'Request failed';
      const aborted = isAbortLikeError(errorMsg);
      // Don't show toast for user-initiated abort
      if (!aborted) {
        toastStore.error(errorMsg.length > 80 ? errorMsg.slice(0, 80) + '…' : errorMsg);
      }
      assistantMessage.done = true;
      assistantMessage.status = aborted ? 'idle' : 'error';
      assistantMessage.content = aborted ? (assistantMessage.content || '') : (assistantMessage.content || errorMsg);
      const timing = typeof startTime === 'number' ? (Date.now() - startTime) / 1000 : 0;
      assistantMessage.metadata = finalizeAssistantMetadata({
        existing: assistantMessage.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds(),
        overrides: aborted ? {} : { error: true, errorMessage: errorMsg }
      });
      assistantMessage.model = activeModelLabel;
      assistantMessage.versions = [{
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
        reasoning: assistantMessage.reasoning,
        metadata: assistantMessage.metadata
      }];
      if (assistantMessage.mode === 'agent' && assistantMessage.agentSteps?.length) {
        assistantMessage.agentSteps = assistantMessage.agentSteps.map((step, index, all) => {
          if (index === all.length - 1) {
            if (aborted) {
              return { ...step, status: 'done', detail: 'Stopped by user' };
            }
            return { ...step, status: 'error', detail: assistantMessage.content };
          }
          return step;
        });
      }
      this.error = aborted ? null : assistantMessage.content;
      userMessage.attachments = sentAttachments;
      syncMsg(true);
      this.persist();
    } finally {
      this.endGenerationRun(targetChatId, controller);
    }
  }

  stopStreaming(chatId = this.currentChatId || '') {
    const run = chatId ? this.activeRunsByChat[chatId] : null;
    run?.controller.abort();
    if (run) {
      this.endGenerationRun(chatId, run.controller);
    } else {
      this.refreshGenerationState();
    }
    const chat = this.findChat(chatId);
    if (chat) {
      const streamingAssistant = [...chat.messages].reverse().find((message) => message.role === 'assistant' && (message.status === 'streaming' || (message.mode === 'agent' && !message.done)));
      if (streamingAssistant) {
        streamingAssistant.status = 'idle';
        streamingAssistant.done = true;
        if (streamingAssistant.mode === 'agent' && streamingAssistant.agentSteps?.length) {
          streamingAssistant.agentSteps = streamingAssistant.agentSteps.map((step, index, all) => {
            if (index === all.length - 1 && step.status === 'running') {
              return { ...step, status: 'done', detail: 'Stopped by user' };
            }
            return step;
          });
        }
        this.touchChats();
        this.persist();
        saveChatStateToDb(chat);
      }
    }
    if (run?.messageId) {
      deepResearchStore.cancelTaskForMessage(run.messageId);
    } else if (chatId) {
      deepResearchStore.cancelTasksForChat(chatId);
    }
    // Exit voice mode when user explicitly cancels generation
    if (chatId === this.currentChatId && this.voiceModeActive) {
      this.voiceModeActive = false;
    }
  }

  private async generateChatTitle(chatId = this.currentChatId || '', apiKey = this.activeProvider?.api_key) {
    const chat = this.findChat(chatId);
    if (!chat) return;
    // Only generate for chats that still have the default title
    if (chat.title !== 'New chat') return;
    // Need at least one user + one assistant message
    const userMsg = chat.messages.find((m) => m.role === 'user');
    const assistantMsg = chat.messages.find((m) => m.role === 'assistant' && m.done && m.content);
    if (!userMsg || !assistantMsg) return;

    try {
      const result = await completeAssistantReply({
        apiKey,
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
    const targetChatId = this.currentChatId;
    if (!chat || !targetChatId) return;
    const index = chat.messages.findIndex((entry) => entry.id === messageId);
    const message = index >= 0 ? chat.messages[index] : null;
    if (!message || message.role !== 'assistant') return;

    const previousMessages = buildRequestMessagesFromHistory(chat.messages, index - 1);
    if (!previousMessages.length) return;

    const activeBackendMode = this.backendMode as GenerationBackendMode;
    const activeModelLabel = this.activeModelLabel;
    const activeProvider = this.activeProvider;
    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider,
      localBusyActionText: 'retrying here'
    })) return;
    const activeProviderApiKey = activeProvider?.api_key;
    const activeWorkspace = chat.workspace || null;

    this.error = null;
    const controller = new AbortController();
    this.beginGenerationRun(targetChatId, {
      controller,
      messageId: message.id,
      backendMode: activeBackendMode,
      mode: (message.mode === 'agent' ? 'agent' : 'chat'),
      startedAt: Date.now()
    });
    const startTime = Date.now();
    const reasoningTimer = startReasoningTimer();
    let exactUsage: CompletionResult['usage'] = null;

    const nextVersion: MessageVersion = {
      content: '',
      reasoning: '',
      createdAt: Date.now(),
      metadata: {
        modelName: activeModelLabel,
        ...executionMetadata(activeBackendMode)
      }
    };

    message.versions = [...(message.versions || []), nextVersion];
    message.activeVersion = message.versions.length - 1;
    message.content = '';
    message.reasoning = '';
    message.done = false;
    message.status = 'streaming';
    if (message.mode === 'agent') {
      message.agentSteps = [
        { id: createId('step'), type: 'thinking', label: 'Planning', status: 'running', detail: 'Preparing tools and context' }
      ];
      message.metadata = {
        ...(message.metadata || {}),
        modelName: activeModelLabel,
        ...executionMetadata(activeBackendMode),
        currentActivity: 'planning',
        activityLabel: 'Agent is planning'
      };
      nextVersion.metadata = {
        ...(nextVersion.metadata || {}),
        ...executionMetadata(activeBackendMode),
        currentActivity: 'planning',
        activityLabel: 'Agent is planning'
      };
      message.artifact = null;
      if (this.currentArtifactMessageId === message.id) {
        this.setCurrentArtifact(null, message.id, false);
      }
    }
    this.touchChats();
    this.persist();

    try {
      const styledSystemPrompt = this.buildSystemPromptForMode({
        backendMode: activeBackendMode,
        providerPrompt: activeProvider?.system_prompt
      });
      const outboundMessages = buildOutboundMessages({ messages: previousMessages, systemPrompt: styledSystemPrompt });
      if (message.mode === 'agent') {
        const rawPrompt = [...chat.messages.slice(0, index)].reverse().find((entry) => entry.role === 'user')?.content || '';
        const agentResult = await runAgentTask({
          chatId: targetChatId,
          systemPrompt: styledSystemPrompt,
          messages: previousMessages,
          rawPrompt,
          executionMode: 'sandbox',
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          signal: controller.signal,
          onStep: (steps) => {
            message.agentSteps = steps;
            const running = steps.find((step) => step.status === 'running');
            if (running) {
              const mapped = activityFromProgress(running.label);
              setAgentActivity(message, mapped.currentActivity, mapped.activityLabel);
              nextVersion.metadata = {
                ...(nextVersion.metadata || {}),
                currentActivity: mapped.currentActivity,
                activityLabel: mapped.activityLabel
              };
            }
            this.touchChats();
            this.persist();
          },
          onProgress: (text) => {
            const mapped = activityFromProgress(text);
            setAgentActivity(message, mapped.currentActivity, mapped.activityLabel);
            nextVersion.metadata = {
              ...(nextVersion.metadata || {}),
              currentActivity: mapped.currentActivity,
              activityLabel: mapped.activityLabel
            };
            this.touchChats();
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            nextVersion.reasoning = value;
            message.reasoning = value;
            this.touchChats();
          },
          onArtifact: (artifact) => {
            message.artifact = artifact;
            if (this.currentChatId === targetChatId && (artifact || this.currentArtifactMessageId === message.id)) {
              this.setCurrentArtifact(artifact, message.id);
            }
            this.touchChats();
            this.persist();
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
              this.persist();
            }
          }
        });
        markAgentWriting(message);
        nextVersion.metadata = {
          ...(nextVersion.metadata || {}),
          currentActivity: 'writing',
          activityLabel: 'Writing answer'
        };
        this.touchChats();
        this.persist();
        const outcome = agentOutcome(agentResult);
        const stopReason = agentStopReason(agentResult);
        const usableAgentResult = hasUsableAgentResult(agentResult);
        if (outcome === 'failed' && agentResult.error && !usableAgentResult) {
          nextVersion.content = agentResult.content || agentResult.error;
          message.content = agentResult.content || agentResult.error;
          message.status = 'error';
          nextVersion.metadata = {
            ...finalizeAssistantMetadata({
              existing: nextVersion.metadata,
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                error: true,
                errorMessage: agentResult.error,
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent failed',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
          message.metadata = nextVersion.metadata;
        } else if (agentResult.warning || outcome === 'partial' || outcome === 'stopped') {
          nextVersion.content = agentResult.content;
          message.content = agentResult.content;
          message.status = 'idle';
          nextVersion.metadata = {
            ...finalizeAssistantMetadata({
              existing: nextVersion.metadata,
              modelName: activeModelLabel,
              backendMode: activeBackendMode,
              noUsageTimingScope: 'agent_wall',
              overrides: {
                warning: agentResult.warning || agentResult.error || 'Agent stopped before normal completion.',
                outcome,
                stopReason,
                currentActivity: 'stopped',
                activityLabel: 'Agent stopped',
                workProduct: agentResult.artifact?.workProduct ? {
                  id: agentResult.artifact.workProduct.id,
                  kind: agentResult.artifact.workProduct.kind,
                  title: agentResult.artifact.workProduct.title,
                  primaryFile: agentResult.artifact.workProduct.files[0]?.path,
                  status: agentResult.artifact.workProduct.status
                } : undefined,
                publicFallback: !!agentResult.publicFallback,
                diagnosticsRedacted: !!agentResult.diagnosticsRedacted
              }
            })
          };
          message.metadata = nextVersion.metadata;
        } else {
          nextVersion.content = agentResult.content;
          message.content = agentResult.content;
          nextVersion.metadata = {
            ...(nextVersion.metadata || {}),
            ...executionMetadata(activeBackendMode),
            outcome,
            stopReason,
            currentActivity: 'completed',
            activityLabel: 'Agent finished',
            workProduct: agentResult.artifact?.workProduct ? {
              id: agentResult.artifact.workProduct.id,
              kind: agentResult.artifact.workProduct.kind,
              title: agentResult.artifact.workProduct.title,
              primaryFile: agentResult.artifact.workProduct.files[0]?.path,
              status: agentResult.artifact.workProduct.status
            } : undefined,
            publicFallback: !!agentResult.publicFallback,
            diagnosticsRedacted: !!agentResult.diagnosticsRedacted
          };
          message.metadata = nextVersion.metadata;
        }
        nextVersion.reasoning = agentResult.reasoning;
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
          message.searchMeta = {
            ...(message.searchMeta || {
              searchRequested: true,
              searchSucceeded: true,
              contextAvailable: true,
              sourceCount: 0
            }),
            searchRequested: true,
            searchSucceeded: true,
            contextAvailable: true,
            sourceCount: message.sources.length,
            stopReason
          };
        }
        if (this.currentChatId === targetChatId && (agentResult.artifact || this.currentArtifactMessageId === message.id)) {
          this.setCurrentArtifact(agentResult.artifact, message.id);
        }
        this.touchChats();
        this.persist();
        // Agent regeneration also stays inside the chat sandbox.
      } else {
        await streamAssistantReply({
          messages: outboundMessages,
          signal: controller.signal,
          apiKey: activeProviderApiKey,
          onChunk: (value) => {
            nextVersion.content += value;
            message.content = nextVersion.content;
            nextVersion.reasoning = message.reasoning;
            this.touchChats();
          },
          onReasoning: (value) => {
            reasoningTimer.markStarted();
            nextVersion.reasoning = appendStreamingReasoning(nextVersion.reasoning || '', value);
            message.reasoning = nextVersion.reasoning;
            this.touchChats();
          },
          onUsage: (usage) => {
            exactUsage = usage || exactUsage;
          }
        });
      }

      const timing = (Date.now() - startTime) / 1000;
      nextVersion.metadata = finalizeAssistantMetadata({
        existing: nextVersion.metadata,
        modelName: activeModelLabel,
        backendMode: activeBackendMode,
        usage: exactUsage,
        elapsedSeconds: timing,
        totalElapsedSeconds: timing,
        reasoningElapsedSeconds: reasoningTimer.elapsedSeconds()
      });
      message.metadata = nextVersion.metadata;
      message.model = activeModelLabel;
      message.done = true;
      // Only set status to 'idle' if it wasn't already set to 'error'
      if (message.status !== 'error') {
        message.status = 'idle';
      }
      if (message.mode === 'slides') {
        try {
          const slides = await parseSlidesFromMarkdown(nextVersion.content);
          message.slides = slides.length ? slides : [];
        } catch {
          message.slides = [];
        }
      }
      if (message.mode === 'agent' && message.agentSteps?.length) {
        const hasError = message.metadata?.error;
        const hasWarning = message.metadata?.warning;
        message.agentSteps = message.agentSteps.map((step, stepIndex, all) => {
          if (stepIndex === all.length - 1) {
            if (hasError) {
              return { ...step, status: 'error', detail: step.detail || 'Agent encountered an error' };
            } else if (hasWarning) {
              return { ...step, status: 'done', detail: hasWarning };
            }
            return { ...step, status: 'done', detail: message.metadata?.outcome === 'completed' ? 'Response ready' : step.detail };
          }
          return { ...step, status: step.status === 'running' ? 'done' : step.status };
        });
      }
      this.touchChats();
      this.persist();
    } catch (error) {
      const timing = (Date.now() - startTime) / 1000;
      const failure = toErrorMessage(error) || 'Request failed';
      const aborted = isAbortLikeError(failure);
      nextVersion.content = aborted ? (nextVersion.content || '') : (nextVersion.content || failure);
      nextVersion.metadata = {
        ...finalizeAssistantMetadata({
          existing: nextVersion.metadata,
          modelName: activeModelLabel,
          backendMode: activeBackendMode,
          elapsedSeconds: timing,
          totalElapsedSeconds: timing,
          reasoningElapsedSeconds: reasoningTimer.elapsedSeconds(),
          overrides: aborted ? {} : { error: true, errorMessage: failure }
        })
      };
      message.content = nextVersion.content;
      message.reasoning = nextVersion.reasoning || '';
      message.metadata = nextVersion.metadata;
      message.done = true;
      message.status = aborted ? 'idle' : 'error';
      this.error = aborted ? null : failure;
      if (aborted && message.mode === 'agent' && message.agentSteps?.length) {
        message.agentSteps = message.agentSteps.map((step, stepIndex, all) => {
          if (stepIndex === all.length - 1 && step.status === 'running') {
            return { ...step, status: 'done', detail: 'Stopped by user' };
          }
          return step;
        });
      }
      this.touchChats();
      this.persist();
    } finally {
      this.endGenerationRun(targetChatId, controller);
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

  private _apiModelsCacheKey(): string | null {
    const isLocal = this.config.llm?.backend_mode === 'local' && isTauri();
    if (isLocal) return null;
    const providerName = this.config.llm?.provider || 'openai';
    const provider = this.config.llm?.providers?.[providerName];
    const baseUrl = provider?.base_url || '';
    return `${providerName}:${baseUrl}`;
  }

  async refreshModels(force?: boolean) {
    if (this.backendMode === 'local' && isTauri()) {
      this.modelsRefreshing = true;
      try {
        await modelsStore.refreshIndex();
        this.models = modelsStore.availableModels.map((m) => ({
          id: m.id,
          name: m.name,
          source: 'local' as const,
          path: m.path,
          details: 'architecture' in m && m.architecture
            ? [m.architecture, (m as { size_label?: string }).size_label].filter(Boolean).join(' • ')
            : undefined
        }));
      } catch {
        this.models = [];
      } finally {
        this.modelsRefreshing = false;
      }
      return;
    }

    const cacheKey = this._apiModelsCacheKey();
    if (cacheKey && !force) {
      const cached = this._apiModelsCache.get(cacheKey);
      if (cached) {
        this.models = cached;
        return;
      }
    }
    this.modelsRefreshing = true;
    try {
      const data = await fetchModels(this.config);
      this.models = data;
      if (cacheKey && data.length > 0) {
        this._apiModelsCache.set(cacheKey, data);
      }
    } catch {
      this.models = [];
    } finally {
      this.modelsRefreshing = false;
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
    const hasApiKeyField = Object.prototype.hasOwnProperty.call(partial, 'api_key');
    const nextApiKey = hasApiKeyField
      ? (partial.api_key && partial.api_key.trim() ? partial.api_key : undefined)
      : (existing.api_key || undefined);
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
            api_key: nextApiKey,
            has_api_key: !!(nextApiKey || existing.has_api_key),
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
    if (isTauri()) {
      detectToolSupport().catch(() => {});
    }
    if (isTauri() && next.llm?.backend_mode === 'local') {
      await modelsStore.refreshStatus();
    }
  }

  async setBackendMode(mode: 'local' | 'api') {
    const current = this.config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
    if (current === mode) return;
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
      await modelsStore.refreshStatus();
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
      await modelsStore.refreshStatus();
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
      await modelsStore.refreshStatus();
    }
  }

  async stopLocalModel() {
    if (!isTauri()) return;
    await stopLlama();
    this.localModelActive = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await modelsStore.refreshStatus();
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
    volume?: number;
    engine?: 'kokoro' | 'wasm' | 'browser';
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
