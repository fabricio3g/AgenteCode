import type { AgentActivity, AgentArtifact, AgentOutcome, AgentStep, AgentStopReason, AppConfig, Attachment, ChatContextMode, ChatFolder, ChatMessage, ChatSession, CodeAgentInstanceId, CodeAgentRuntimeMode, CodeProject, CreatedFile, MessageVersion, ModelOption, ReasoningCapabilities, ReasoningLevel, SearchMeta, WorkspaceFile } from '$lib/types/chat';
import type { IndexedDocument, SearchResult } from '$lib/types/tauri';
import { resolveCodeAgentInstance, runCodeAgent } from '$lib/services/agent-provider';
import { computeSnapshotDiff, snapshotWorkspace } from '$lib/services/workspace-diff';
import { parseSlidesFromMarkdown } from '$lib/services/slides';
import { writeTempFile, pathExists, pickWorkspaceFolder as pickWorkspaceFolderDialog, indexWorkspaceFolder, writeWorkspaceFile, createWorkspaceDocument, renameWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, openWorkspaceFile, createWorkspaceFolder } from '$lib/services/files';
import { clearRagDocuments, ingestDocument, ingestText, ingestTextFast, listRagDocuments, queryDocuments, removeRagDocument } from '$lib/services/rag';
import { webSearch } from '$lib/services/search';
import { getRecommendedSettings, loadLocalModel, stopLlama } from '$lib/services/runtime';
import { isTauri } from '$lib/services/tauri';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { deepResearchStore } from '$lib/stores/deep-research.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import { completeAssistantReply, detectToolSupport, fetchModels, fetchReasoningCapabilities, hasConfiguredVisionModel, loadChatConfig, streamAssistantReply } from '$lib/services/chat-api';
import { loadChatState, saveChatState, saveAppConfig, saveChatStateToDb, loadChatStateFromDb, deleteChatFromDb, loadCodeProjectsFromDb, saveCodeProjectToDb, deleteCodeProjectFromDb } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';
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
import {
  mergeLocalSettingsConfig,
  mergePromptSettingsConfig,
  mergeProviderConfig,
  mergeSearchSettingsConfig,
  mergeTtsSettingsConfig,
  mergeUiSettingsConfig,
  mergeWorkspaceModeConfig,
  setBackendModeConfig,
  setLocalModelConfig
} from '$lib/stores/app-store-config';
import { applyArtifactToMessage, findLatestArtifactMessage, resolveArtifactForMessage } from '$lib/stores/app-store-artifacts';
import {
  buildLocalModelRuntimeRequest,
  buildLocalModelSettingsPatch,
  buildRememberedLocalModelSettingsEntry,
  pickNumber,
  readRememberedLocalModelSettings,
  resolveLocalModelLoadState,
  writeRememberedLocalModelSettings
} from '$lib/stores/app-store-local-model';
import {
  buildWorkspaceFromIndexResult,
  buildWorkspacePrompt,
  getWorkspaceExtension,
  getWorkspacePath,
  isSupportedWorkspaceFile,
  recalculateWorkspace,
  shouldIgnoreWorkspacePath,
  trimWorkspaceText
} from '$lib/stores/app-store-workspace';
import type {
  ActiveGenerationRun,
  ChatSearchState,
  GenerationBackendMode,
  GenerationComposerMode,
  PersistedState
} from '$lib/stores/app-store-types';
import { buildLocalModelOption } from '$lib/utils/local-models';

import {
  USER_NAME_KEY,
  WEB_RAG_MIN_ANSWER_CHARS,
  WORKSPACE_MAX_FILES,
  WORKSPACE_MAX_FILE_SIZE_BYTES,
  activityFromProgress,
  agentOutcome,
  agentStopReason,
  appendStreamingContent,
  appendStreamingReasoning,
  buildContextualPrompt as buildContextualPromptHelper,
  buildRequestMessagesFromHistory,
  canStartGeneration as canStartGenerationHelper,
  buildSearchConversationContext,
  buildWebRagPayload,
  executionMetadata,
  createId,
  finalizeAssistantMetadata,
  getElectronApi,
  getMessageRequestContent,
  hasUsableAgentResult,
  isAbortLikeError,
  markAgentWriting,
  normalizeChat,
  normalizeContextMode,
  normalizeFolder,
  normalizeMessage,
  normalizeText,
  parseWriteFileBlocks,
  readBlobAsDataUrl,
  setAgentActivity,
  startReasoningTimer,
  stripWriteFileBlocks,
  toInvoke,
  updateStreamingVersion,
  withTimeout,
  type ApiModelMetadata,
  type AssistantMetadata,
  type ContextBudget,
  type ElectronApi,
  type LocalModelLoadTarget,
  type MainView
} from '$lib/stores/app-store-helpers';

class AppStore {
  ready = $state(false);
  config = $state<AppConfig>({});
  chats = $state<ChatSession[]>([]);
  folders = $state<ChatFolder[]>([]);
  codeProjects = $state<CodeProject[]>([]);
  currentProjectId = $state<string | null>(null);
  currentChatId = $state<string | null>(null);
  activeSpace = $state<ChatContextMode>('chat');
  currentChatIdBySpace = $state<Record<ChatContextMode, string | null>>({ chat: null, work: null, code: null });
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
  mainView = $state<MainView>('chat');
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
  reasoningLevel = $state<ReasoningLevel | null>(null);
  reasoningCapabilities = $state<ReasoningCapabilities>({ supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' });
  composerMode = $state<'chat' | 'agent'>('chat');
  pendingAttachments = $state<Attachment[]>([]);
  workspaceIndexing = $state(false);
  ragDocumentsByChat = $state<Record<string, IndexedDocument[]>>({});
  contextBudget = $state<ContextBudget | null>(null);
  apiModelMetadataByKey = $state<Record<string, ApiModelMetadata>>({});
  currentArtifact = $state<AgentArtifact | null>(null);
  currentArtifactMessageId = $state<string | null>(null);
  activityDrawerOpen = $state(false);
  activityMessageId = $state<string | null>(null);
  activityDrawerTab = $state<'activity' | 'sources'>('activity');
  localModelLoadTarget = $state<LocalModelLoadTarget | null>(null);
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
  localModelLoadDisableThinking = $state(false);
  localModelLoadMtpEnabled = $state(false);
  localModelLoadMtpDraftPath = $state('');
  localModelLoadMtpDraftNMax = $state('');
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

  get activityMessage() {
    const messageId = this.activityMessageId;
    if (!messageId) return null;
    return this.currentChat?.messages?.find((message) => message.id === messageId) || null;
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
    return this.currentChat?.contextMode || this.activeSpace || 'chat';
  }

  get visibleChats() {
    if (this.activeSpace === 'code' && this.currentProjectId) {
      return this.chats.filter((chat) => normalizeContextMode(chat.contextMode) === 'code' && chat.projectId === this.currentProjectId);
    }
    return this.chats.filter((chat) => normalizeContextMode(chat.contextMode) === this.activeSpace);
  }

  get currentProject() {
    return this.codeProjects.find((p) => p.id === this.currentProjectId) || null;
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

    if (applyArtifactToMessage(this.currentChat, messageId, artifact)) {
      this.touchChats();
      this.persist();
    }

    this.sandboxOpen = artifact ? open : false;
  }

  openArtifact(artifact: AgentArtifact | null, messageId: string | null = null) {
    if (!artifact && messageId && this.currentChat) {
      artifact = resolveArtifactForMessage(this.currentChat, messageId);
    }
    if (!artifact) return;
    this.syncArtifactState(artifact, messageId, true);
  }

  setCurrentArtifact(artifact: AgentArtifact | null, messageId: string | null = this.currentArtifactMessageId, open = this.sandboxOpen) {
    this.syncArtifactState(artifact, messageId, open);
  }

  openActivityDrawer(messageId: string, tab: 'activity' | 'sources' = 'activity') {
    if (!messageId) return;
    if (this.activityDrawerOpen && this.activityMessageId === messageId && this.activityDrawerTab === tab) {
      this.closeActivityDrawer();
      return;
    }
    this.activityMessageId = messageId;
    this.activityDrawerTab = tab;
    this.activityDrawerOpen = true;
  }

  closeActivityDrawer() {
    this.activityDrawerOpen = false;
  }

  async openLocalModelLoadDialog(model: LocalModelLoadTarget) {
    if (!model.path) return;
    this.localModelLoadTarget = model;
    this.localModelLoadRuntimePath = this.config.llm?.local?.runtime_path || '';
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
    // Auto-detect mmproj in same folder
    this.localModelLoadMmprojPath = '';
    this.localModelLoadMmprojPath = await this.detectMmprojForModel(model.path);
    const remembered = readRememberedLocalModelSettings()[model.id] || {};
    let recommended: Awaited<ReturnType<typeof getRecommendedSettings>> | null = null;
    try {
      const hasRememberedContext = Object.prototype.hasOwnProperty.call(remembered, 'context_length');
      const hasRememberedGpu = Object.prototype.hasOwnProperty.call(remembered, 'gpu_offload');
      const recommendedContextHint = hasRememberedContext ? pickNumber(remembered.context_length) : undefined;
      const recommendedGpuHint = hasRememberedGpu ? pickNumber(remembered.gpu_offload) : undefined;
      recommended = await getRecommendedSettings(
        model.path,
        recommendedContextHint,
        recommendedGpuHint,
        this.localModelLoadRuntimePath || this.config.llm?.local?.runtime_path
      );
    } catch {
      recommended = null;
    }
    const resolved = resolveLocalModelLoadState({
      remembered,
      config: this.config,
      model,
      runtimePath: this.localModelLoadRuntimePath,
      recommended,
      hardwareConcurrency: navigator.hardwareConcurrency,
      mmprojPath: this.localModelLoadMmprojPath
    });
    this.localModelLoadContextLength = resolved.contextLength;
    this.localModelLoadGpuLayers = resolved.gpuLayers;
    this.localModelLoadCpuThreads = resolved.cpuThreads;
    this.localModelLoadBatchSize = resolved.batchSize;
    this.localModelLoadFlashAttention = resolved.flashAttention;
    this.localModelLoadOffloadKvCache = resolved.offloadKvCache;
    this.localModelLoadKeepInMemory = resolved.keepInMemory;
    this.localModelLoadMmap = resolved.mmap;
    this.localModelLoadSeed = resolved.seed;
    this.localModelLoadParallel = resolved.parallel;
    this.localModelLoadRopeFreqBase = resolved.ropeFreqBase;
    this.localModelLoadRopeFreqScale = resolved.ropeFreqScale;
    this.localModelLoadCacheTypeK = resolved.cacheTypeK;
    this.localModelLoadCacheTypeV = resolved.cacheTypeV;
    this.localModelLoadMmprojPath = resolved.mmprojPath;
    this.localModelLoadMtpEnabled = resolved.mtpEnabled;
    this.localModelLoadMtpDraftPath = resolved.mtpDraftPath;
    this.localModelLoadMtpDraftNMax = resolved.mtpDraftNMax;
    this.localModelRememberSettings = resolved.rememberSettings;
  }

  closeLocalModelLoadDialog() {
    this.localModelLoadTarget = null;
    this.localModelLoadProgress = 0;
    this.localModelLoadPhase = '';
  }

  async detectMmprojForModel(modelPath: string): Promise<string> {
    const candidates = await this.listProjectorCandidates(modelPath);
    return candidates[0] || '';
  }

  async listProjectorCandidates(modelPath: string): Promise<string[]> {
    if (!modelPath) return [];
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
    const orderedNames = [
      'mmproj-BF16.gguf',
      'mmproj-F16.gguf',
      'mmproj-F32.gguf',
      'mmproj.gguf'
    ];
    const modelBase = (modelPath.split(/[/\\]/).pop() || '').replace(/\.gguf$/i, '');
    if (modelBase) {
      orderedNames.push(
        `mmproj-${modelBase}.gguf`,
        `${modelBase}-mmproj.gguf`,
        `${modelBase}.mmproj.gguf`,
        `${modelBase}.projector.gguf`,
        `projector-${modelBase}.gguf`
      );
    }

    const found: string[] = [];
    for (const name of orderedNames) {
      const fullPathCandidates = Array.from(new Set([
        `${normalizedDir}/${name}`,
        `${windowsDir}\\${name}`,
        `${dir}/${name}`,
        `${dir}\\${name}`
      ]));
      for (const fullPath of fullPathCandidates) {
        try {
          const exists = await pathExists(fullPath);
          if (exists && !found.includes(fullPath)) found.push(fullPath);
        } catch { /* ignore */ }
      }
    }
    return found;
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
      const loadState = {
        contextLength: this.localModelLoadContextLength,
        gpuLayers: this.localModelLoadGpuLayers,
        cpuThreads: this.localModelLoadCpuThreads,
        batchSize: this.localModelLoadBatchSize,
        runtimePath: this.localModelLoadRuntimePath,
        flashAttention: this.localModelLoadFlashAttention,
        offloadKvCache: this.localModelLoadOffloadKvCache,
        keepInMemory: this.localModelLoadKeepInMemory,
        mmap: this.localModelLoadMmap,
        seed: this.localModelLoadSeed,
        parallel: this.localModelLoadParallel,
        ropeFreqBase: this.localModelLoadRopeFreqBase,
        ropeFreqScale: this.localModelLoadRopeFreqScale,
        cacheTypeK: this.localModelLoadCacheTypeK,
        cacheTypeV: this.localModelLoadCacheTypeV,
        mmprojPath: this.localModelLoadMmprojPath,
        disableThinking: this.localModelLoadDisableThinking,
        mtpEnabled: this.localModelLoadMtpEnabled,
        mtpDraftPath: this.localModelLoadMtpDraftPath,
        mtpDraftNMax: this.localModelLoadMtpDraftNMax,
        rememberSettings: this.localModelRememberSettings
      };
      await this.updateLocalSettings(buildLocalModelSettingsPatch(loadState));
      const remembered = readRememberedLocalModelSettings();
      if (this.localModelRememberSettings) {
        remembered[this.localModelLoadTarget.id] = buildRememberedLocalModelSettingsEntry(loadState);
      } else {
        delete remembered[this.localModelLoadTarget.id];
      }
      writeRememberedLocalModelSettings(remembered);
      const config = await loadChatConfig();
      this.localModelLoadProgress = 24;
      this.localModelLoadPhase = 'Launching local runtime';
      await loadLocalModel(buildLocalModelRuntimeRequest({
        config,
        target: this.localModelLoadTarget,
        state: loadState
      }));
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
        this.refreshReasoningCapabilities().catch(() => {});
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
      const dbProjects = await loadCodeProjectsFromDb();
      let chats: ChatSession[];
      let folders: ChatFolder[];
      let currentChatId: string | null;

      if (dbResult && dbResult.chats.length > 0) {
        chats = dbResult.chats;
        folders = dbResult.folders;
        // Restore currentChatId from localStorage (not stored in DB)
        const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
        currentChatId = persisted.currentChatId;
        this.activeSpace = normalizeContextMode(persisted.activeSpace);
        this.currentChatIdBySpace = this.normalizeChatIdBySpace(persisted.currentChatIdBySpace);
        this.currentProjectId = persisted.currentProjectId || null;
      } else {
        const persisted = loadChatState<PersistedState>({ chats: [], folders: [], currentChatId: null });
        chats = Array.isArray(persisted.chats) ? persisted.chats : [];
        folders = Array.isArray(persisted.folders) ? persisted.folders : [];
        if (!dbProjects.length && Array.isArray(persisted.codeProjects)) {
          dbProjects.push(...persisted.codeProjects);
        }
        currentChatId = persisted.currentChatId;
        this.activeSpace = normalizeContextMode(persisted.activeSpace);
        this.currentChatIdBySpace = this.normalizeChatIdBySpace(persisted.currentChatIdBySpace);
        this.currentProjectId = persisted.currentProjectId || null;
      }

      this.chats = chats.map((chat, index) => normalizeChat(chat, index));
      this.folders = folders.map((folder, index) => normalizeFolder(folder, index));
      this.codeProjects = dbProjects;
      this.ensureLooseCodeProject();
      if (this.currentProjectId && !this.codeProjects.some((project) => project.id === this.currentProjectId)) {
        this.currentProjectId = this.codeProjects[0]?.id || null;
      }
      this.currentChatId = currentChatId;

      if (!this.chats.length) {
        this.createChat(this.activeSpace);
      } else if (!this.currentChat) {
        this.currentChatId = this.resolveChatIdForSpace(this.activeSpace) || this.chats[0]?.id || null;
      }
      this.activeSpace = normalizeContextMode(this.currentChat?.contextMode || this.activeSpace);
      this.rebuildChatIdBySpace();
    } catch (error) {
      this.error = toErrorMessage(error) || 'Failed to initialize application';
      if (!this.chats.length) {
        this.createChat(this.activeSpace);
      }
      console.error('[appStore.init] failed', error);
    } finally {
      this.ready = true;
    }

    void withTimeout(this.refreshModels(), 2500, undefined);
    if (isTauri()) {
      void detectToolSupport().catch(() => {});
      void this.refreshReasoningCapabilities().catch(() => {});
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
      codeProjects: this.codeProjects,
      currentChatId: this.currentChatId,
      activeSpace: this.activeSpace,
      currentChatIdBySpace: this.currentChatIdBySpace,
      currentProjectId: this.currentProjectId
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

  private normalizeChatIdBySpace(value: unknown): Record<ChatContextMode, string | null> {
    const raw = value && typeof value === 'object' ? value as Partial<Record<ChatContextMode, unknown>> : {};
    return {
      chat: typeof raw.chat === 'string' ? raw.chat : null,
      work: typeof raw.work === 'string' ? raw.work : null,
      code: typeof raw.code === 'string' ? raw.code : null
    };
  }

  private defaultTitleForMode(mode: ChatContextMode) {
    if (mode === 'work') return 'New work';
    if (mode === 'code') return 'Codebase overview';
    return 'New chat';
  }

  private projectNameFromPath(rootPath: string) {
    return String(rootPath || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Project';
  }

  private ensureLooseCodeProject() {
    const looseChats = this.chats.filter((chat) => normalizeContextMode(chat.contextMode) === 'code' && !chat.projectId);
    if (!looseChats.length) return;
    let loose = this.codeProjects.find((project) => project.id === 'project-loose');
    if (!loose) {
      const now = Date.now();
      loose = {
        id: 'project-loose',
        rootPath: '',
        rootName: 'Loose sessions',
        icon: null,
        createdAt: now,
        updatedAt: now
      };
      this.codeProjects = [loose, ...this.codeProjects];
      void saveCodeProjectToDb(loose);
    }
    for (const chat of looseChats) {
      chat.projectId = loose.id;
    }
  }

  private isDefaultTitle(chat: ChatSession, title = chat.title) {
    return title === 'New chat' || title === 'New work' || title === 'New code' || title === this.defaultTitleForMode(normalizeContextMode(chat.contextMode));
  }

  private applyContextModeDefaults(mode: ChatContextMode) {
    if (mode === 'work' || mode === 'code') {
      this.searchMode = 'chat';
      this.composerMode = 'agent';
      return;
    }
    if (this.composerMode === 'agent') {
      this.composerMode = 'chat';
    }
  }

  private resolveChatIdForSpace(mode: ChatContextMode) {
    const remembered = this.currentChatIdBySpace[mode];
    if (remembered) {
      const chat = this.findChat(remembered);
      if (chat && normalizeContextMode(chat.contextMode) === mode) return remembered;
    }
    return this.chats.find((chat) => normalizeContextMode(chat.contextMode) === mode)?.id || null;
  }

  private rebuildChatIdBySpace() {
    const next: Record<ChatContextMode, string | null> = { chat: null, work: null, code: null };
    for (const chat of this.chats) {
      const mode = normalizeContextMode(chat.contextMode);
      if (!next[mode]) next[mode] = chat.id;
    }
    if (this.currentChat) {
      next[normalizeContextMode(this.currentChat.contextMode)] = this.currentChat.id;
    }
    this.currentChatIdBySpace = next;
  }

  setActiveSpace(mode: ChatContextMode) {
    const nextMode = normalizeContextMode(mode);
    if (this.currentChat) {
      const currentMode = normalizeContextMode(this.currentChat.contextMode);
      this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [currentMode]: this.currentChat.id };
    }
    this.activeSpace = nextMode;
    const targetId = this.resolveChatIdForSpace(nextMode);
    if (targetId) {
      this.selectChat(targetId);
      return;
    }
    this.createChat(nextMode);
  }

  createChat(mode: ChatContextMode = this.activeSpace, options: { projectId?: string | null; workspace?: ChatSession['workspace'] } = {}) {
    const contextMode = normalizeContextMode(mode);
    this.mainView = 'chat';
    const now = Date.now();
    const chat: ChatSession = {
      id: createId('chat'),
      title: this.defaultTitleForMode(contextMode),
      createdAt: now,
      updatedAt: now,
      folderId: null,
      draft: '',
      contextMode,
      codeAgent: contextMode === 'code' ? { instanceId: 'chatea-agent', driverKind: 'chatea-agent', substrate: 'pi', updatedAt: now } : null,
      projectId: contextMode === 'code' ? (options.projectId || this.currentProjectId || null) : null,
      workspace: options.workspace || null,
      messages: []
    };
    this.chats = [chat, ...this.chats];
    this.activeSpace = contextMode;
    if (contextMode === 'code') this.currentProjectId = chat.projectId || this.currentProjectId;
    this.currentChatId = chat.id;
    this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [contextMode]: chat.id };
    this.refreshGenerationState();
    this.composer = '';
    this.currentArtifact = null;
    this.currentArtifactMessageId = null;
    this.sandboxOpen = false;
    this.applyContextModeDefaults(contextMode);
    this.persist();
    return chat;
  }

  async pickCodeProjectFolder() {
    if (!isTauri()) {
      toastStore.error('Code projects are only available in the desktop app.');
      return null;
    }
    const selectedPath = await pickWorkspaceFolderDialog();
    if (!selectedPath) return null;
    return this.createCodeProjectFromPath(selectedPath);
  }

  async createCodeProjectFromPath(rootPath: string) {
    const now = Date.now();
    const existing = this.codeProjects.find((project) => project.rootPath === rootPath);
    if (existing) {
      this.selectCodeProject(existing.id);
      return existing;
    }

    const project: CodeProject = {
      id: createId('project'),
      rootPath,
      rootName: this.projectNameFromPath(rootPath),
      icon: null,
      createdAt: now,
      updatedAt: now
    };

    this.codeProjects = [project, ...this.codeProjects];
    this.currentProjectId = project.id;
    this.activeSpace = 'code';
    await saveCodeProjectToDb(project);

    let workspace: ChatSession['workspace'] = {
      rootName: project.rootName,
      rootPath,
      attachedAt: now,
      fileCount: 0,
      indexedCount: 0,
      skippedCount: 0,
      files: []
    };
    if (isTauri()) {
      try {
        const result = await indexWorkspaceFolder(rootPath, project.id);
        workspace = buildWorkspaceFromIndexResult(result, now);
      } catch (error) {
        toastStore.info(`Project created, but indexing failed: ${toErrorMessage(error)}`, 4000);
      }
    }

    this.createChat('code', { projectId: project.id, workspace });
    toastStore.success(`Project ready: ${project.rootName}`, 2500);
    return project;
  }

  selectCodeProject(projectId: string) {
    const project = this.codeProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    this.currentProjectId = projectId;
    this.activeSpace = 'code';
    const chatId = this.chats.find((chat) => normalizeContextMode(chat.contextMode) === 'code' && chat.projectId === projectId)?.id;
    if (chatId) {
      this.selectChat(chatId);
      return;
    }
    this.createChat('code', {
      projectId,
      workspace: {
        rootName: project.rootName,
        rootPath: project.rootPath,
        attachedAt: Date.now(),
        fileCount: 0,
        indexedCount: 0,
        skippedCount: 0,
        files: []
      }
    });
  }

  createCodeChat(projectId = this.currentProjectId || '') {
    const project = this.codeProjects.find((entry) => entry.id === projectId);
    if (!project) {
      void this.pickCodeProjectFolder();
      return null;
    }
    return this.createChat('code', {
      projectId: project.id,
      workspace: {
        rootName: project.rootName,
        rootPath: project.rootPath,
        attachedAt: Date.now(),
        fileCount: 0,
        indexedCount: 0,
        skippedCount: 0,
        files: []
      }
    });
  }

  async deleteCodeProject(projectId: string) {
    const project = this.codeProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    const projectChats = this.chats.filter((chat) => chat.projectId === projectId);
    const deletingCurrentChat = !!this.currentChatId && projectChats.some((chat) => chat.id === this.currentChatId);
    for (const chat of projectChats) {
      if (this.isChatGenerating(chat.id)) this.stopStreaming(chat.id);
      delete this.ragDocumentsByChat[chat.id];
      deleteChatFromDb(chat.id).catch(() => {});
      if (isTauri()) clearRagDocuments(chat.id).catch(() => {});
    }
    this.codeProjects = this.codeProjects.filter((entry) => entry.id !== projectId);
    this.chats = this.chats.filter((chat) => chat.projectId !== projectId);
    if (deletingCurrentChat) {
      this.currentChatId = null;
    }
    if (this.currentProjectId === projectId) this.currentProjectId = this.codeProjects[0]?.id || null;
    await deleteCodeProjectFromDb(projectId);
    if (!this.currentChatId) {
      const nextCodeChat = this.currentProjectId
        ? this.chats.find((chat) => chat.projectId === this.currentProjectId)?.id
        : this.chats.find((chat) => normalizeContextMode(chat.contextMode) === 'code')?.id;
      this.currentChatId = nextCodeChat || this.chats[0]?.id || null;
    }
    this.rebuildChatIdBySpace();
    this.persist();
    toastStore.info(`Project deleted: ${project.rootName}`, 2200);
  }

  selectChat(chatId: string) {
    const match = this.chats.find((chat) => chat.id === chatId);
    if (!match) return;
    this.mainView = 'chat';
    const mode = normalizeContextMode(match.contextMode);
    this.activeSpace = mode;
    if (mode === 'code') this.currentProjectId = match.projectId || this.currentProjectId;
    this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [mode]: chatId };

    for (const attachment of this.pendingAttachments) {
      if (attachment.preview?.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.preview);
      }
    }
    this.pendingAttachments = [];

    this.currentChatId = chatId;
    this.refreshGenerationState();
    this.composer = match.draft || '';
    this.applyContextModeDefaults(mode);
    // Restore artifact from the selected chat's last agent message, or clear
    const lastArtifactMsg = findLatestArtifactMessage(match);
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
    const deletedMode = normalizeContextMode(this.chats.find((c) => c.id === chatId)?.contextMode || this.activeSpace);
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
      this.currentChatId = this.resolveChatIdForSpace(deletedMode) || this.chats[0]?.id || null;
      this.activeSpace = normalizeContextMode(this.currentChat?.contextMode || deletedMode);
      this.composer = this.currentChat?.draft || '';
      // Clear sandbox when current chat is deleted
      this.currentArtifact = null;
      this.currentArtifactMessageId = null;
      this.sandboxOpen = false;
    }
    this.rebuildChatIdBySpace();
    if (!this.chats.length) this.createChat(this.activeSpace);
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
    chat.title = title.trim() || this.defaultTitleForMode(normalizeContextMode(chat.contextMode));
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

    // Fast provisional title so history updates instantly.
    if (this.isDefaultTitle(chat) && message.role === 'user') {
      const firstUser = chat.messages.find((m) => m.role === 'user');
      const preview = (firstUser?.content || '').trim().replace(/\s+/g, ' ').slice(0, 48);
      if (preview) chat.title = preview;
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
    return buildSearchConversationContext(this.findChat(chatId), currentUserMessageId);
  }

  private buildContextualPrompt(args: Parameters<typeof buildContextualPromptHelper>[0]) {
    return buildContextualPromptHelper(args);
  }

  setContextMode(mode: ChatContextMode) {
    if (!this.currentChat) return;
    const nextMode = normalizeContextMode(mode);
    this.currentChat.contextMode = nextMode;
    this.currentChat.codeAgent = nextMode === 'code'
      ? (this.currentChat.codeAgent || { instanceId: 'chatea-agent', driverKind: 'chatea-agent', substrate: 'pi', updatedAt: Date.now() })
      : null;
    this.activeSpace = nextMode;
    this.currentChatIdBySpace = { ...this.currentChatIdBySpace, [nextMode]: this.currentChat.id };
    this.applyContextModeDefaults(nextMode);
    this.touchChats();
    this.persist();
  }

  setCodeAgentProvider(instanceId: CodeAgentInstanceId) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'code') return;
    const instance = resolveCodeAgentInstance(instanceId).instance;
    chat.codeAgent = {
      ...(chat.codeAgent || {}),
      instanceId: instance.id,
      driverKind: instance.driverKind,
      status: instance.status,
      updatedAt: Date.now()
    };
    this.touchChats();
    this.persist();
  }

  setCodeAgentRuntimeMode(mode: CodeAgentRuntimeMode) {
    const chat = this.currentChat;
    if (!chat || normalizeContextMode(chat.contextMode) !== 'code') return;
    chat.codeAgent = {
      ...(chat.codeAgent || { instanceId: 'chatea-agent', driverKind: 'chatea-agent', substrate: 'pi', updatedAt: Date.now() }),
      runtimeMode: mode,
      updatedAt: Date.now()
    };
    this.touchChats();
    this.persist();
  }

  setSearchMode(mode: 'chat' | 'search' | 'deep' | 'max') {
    this.searchMode = this.searchMode === mode ? 'chat' : mode;
  }

  setReasoningLevel(level: ReasoningLevel | null) {
    this.reasoningLevel = level;
    const chat = this.currentChat;
    if (chat) {
      chat.reasoningLevel = level;
      this.touchChats();
      this.persist();
    }
  }

  async refreshReasoningCapabilities() {
    if (!isTauri()) {
      this.reasoningCapabilities = { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
      return;
    }
    try {
      const config = await loadChatConfig();
      const backendMode = config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
      if (backendMode === 'local') {
        const local = config.llm?.local || {};
        this.reasoningCapabilities = await fetchReasoningCapabilities({
          providerName: 'local',
          model: local.model || 'local-model',
          modelPath: local.selected_model_path || ''
        });
      } else {
        const providerName = config.llm?.provider || 'openai';
        const provider = (config.llm?.providers?.[providerName] || {}) as { base_url?: string; api_key?: string; model?: string };
        this.reasoningCapabilities = await fetchReasoningCapabilities({
          baseUrl: provider.base_url,
          apiKey: provider.api_key,
          providerName,
          model: provider.model || ''
        });
      }
      // If the current reasoning level isn't in the new capabilities' levels, reset it
      if (this.reasoningCapabilities.supported && this.reasoningLevel &&
          !this.reasoningCapabilities.levels.includes(this.reasoningLevel)) {
        this.reasoningLevel = null;
      }
      if (!this.reasoningCapabilities.supported) {
        this.reasoningLevel = null;
      }
    } catch {
      this.reasoningCapabilities = { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
      this.reasoningLevel = null;
    }
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
        this.setContextMode('chat');
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
          this.setContextMode('chat');
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
      chat.workspace = buildWorkspaceFromIndexResult(result, Date.now());
      this.setContextMode('work');
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
      this.setContextMode('work');
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
    this.setContextMode('chat');
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
      chat!.workspace = buildWorkspaceFromIndexResult(result, chat!.workspace!.attachedAt);
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
    activeProvider?: { has_api_key?: boolean; api_key?: string; model?: string } | null;
    localBusyActionText?: string;
  }): boolean {
    return canStartGenerationHelper({
      ...params,
      selectedLocalModelPath: this.selectedLocalModelPath,
      localModelActive: Boolean(this.localModelActive),
      isChatGenerating: (chatId) => this.isChatGenerating(chatId),
      hasOtherChatGeneration: (chatId) => this.hasOtherChatGeneration(chatId),
      info: (message, duration) => toastStore.info(message, duration),
      error: (message) => toastStore.error(message)
    });
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
    const activeWorkspace = activeContextMode === 'work' || activeContextMode === 'code' ? targetChat.workspace : null;
    const targetRagDocuments = this.ragDocumentsByChat[targetChatId] || [];

    if (!this.canStartGeneration({
      backendMode: activeBackendMode,
      targetChatId,
      activeProvider
    })) return;

    this.error = null;
    const targetChatTitle = targetChat?.title || this.defaultTitleForMode(normalizeContextMode(targetChat?.contextMode));
    const workContext = activeContextMode === 'work' && activeWorkspace
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
      metadata: (activeComposerMode === 'agent' || activeSearchMode !== 'chat')
        ? {
            modelName: activeModelLabel,
            ...executionMetadata(activeBackendMode),
            currentActivity: 'planning',
            activityLabel: activeComposerMode === 'agent' ? 'Agent is planning' : 'Preparing search'
          }
        : undefined,
      workContext,
      agentSteps: (activeComposerMode === 'agent' || activeSearchMode !== 'chat')
        ? [{ id: createId('step'), type: 'thinking', label: 'Planning', status: 'running', detail: activeComposerMode === 'agent' ? 'Preparing tools and context' : 'Preparing search tools and context' }]
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
          researchSummary: (searchMeta as SearchMeta | null)?.researchSummary || '',
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

      const useToolLoop = (activeComposerMode === 'agent' || activeSearchMode !== 'chat') && targetChatId;
      const searchToolBudget = activeSearchMode === 'max'
        ? { maxIterations: 60, maxToolCalls: 180, maxTimeMs: 25 * 60 * 1000 }
        : activeSearchMode === 'deep'
          ? { maxIterations: 36, maxToolCalls: 108, maxTimeMs: 15 * 60 * 1000 }
          : { maxIterations: 12, maxToolCalls: 30, maxTimeMs: 6 * 60 * 1000 };

      if (useToolLoop) {
        const codeInstanceId = activeContextMode === 'code' ? targetChat.codeAgent?.instanceId : undefined;
        const beforeSnapshot = activeContextMode === 'code' ? await snapshotWorkspace(activeWorkspace?.rootPath) : null;
        const isCodeWorkspace = activeContextMode === 'code' && !!activeWorkspace?.rootPath;
        const agentResult = await runCodeAgent({
          chatId: targetChatId,
          systemPrompt,
          messages: requestMessages,
          rawPrompt: content,
          conversationContext: searchConversationContext,
          executionMode: isCodeWorkspace ? 'workspace' : 'sandbox',
          workspaceRoot: isCodeWorkspace ? activeWorkspace?.rootPath : undefined,
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          runtimeMode: activeContextMode === 'code' ? (targetChat.codeAgent?.runtimeMode || 'full') : undefined,
          toolMode: activeComposerMode === 'agent' ? 'agent' : 'search_chat',
          searchMode: activeSearchMode === 'chat' ? undefined : activeSearchMode,
          reasoningLevel: this.reasoningLevel,
          ...(activeSearchMode === 'chat' ? {} : searchToolBudget),
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
        }, codeInstanceId);
        if (activeContextMode === 'code') {
          const afterSnapshot = await snapshotWorkspace(activeWorkspace?.rootPath);
          const diffStats = computeSnapshotDiff(beforeSnapshot, afterSnapshot);
          if (diffStats.length) {
            assistantMessage.agentSteps = [
              ...(assistantMessage.agentSteps || []),
              {
                id: createId('step'),
                type: 'writing',
                label: 'Changed files',
                status: 'done',
                detail: `${diffStats.length} file${diffStats.length === 1 ? '' : 's'} changed`,
                diffStats,
                fileChanges: diffStats.map((stat) => ({ path: stat.path, kind: stat.kind }))
              }
            ];
          }
        }
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
        const prevSteps = assistantMessage.agentSteps || [];
        const diffSteps = prevSteps.filter((s) => s.diffStats?.length && !agentResult.steps.some((rs) => rs.id === s.id));
        assistantMessage.agentSteps = [...agentResult.steps, ...diffSteps];
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
        } else if (activeSearchMode !== 'chat') {
          assistantMessage.searchMeta = {
            ...(assistantMessage.searchMeta || {}),
            searchRequested: true,
            searchSucceeded: !agentResult.error,
            contextAvailable: false,
            sourceCount: assistantMessage.sources?.length || 0,
            requestedProvider: this.config.search?.provider || 'aggregator',
            searchError: agentResult.error || agentResult.warning || '',
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
          reasoningLevel: this.reasoningLevel,
          onChunk: (value) => {
            reasoningTimer.markStopped();
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
        if (!(streamingAssistant.content || '').trim()) {
          streamingAssistant.content = 'Stopped by user.';
        }
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
    // Need at least one user + one assistant message
    const userMsg = chat.messages.find((m) => m.role === 'user');
    const assistantMsg = chat.messages.find((m) => m.role === 'assistant' && m.done && m.content);
    if (!userMsg || !assistantMsg) return;

    const provisional = userMsg.content.trim().replace(/\s+/g, ' ').slice(0, 48);
    // Only auto-rewrite if title is still default or provisional quick title.
    if (!this.isDefaultTitle(chat) && chat.title !== provisional) return;

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

      if (generated && generated.length >= 4 && generated.length <= 80 && (this.isDefaultTitle(chat) || chat.title === provisional)) {
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
        const isCodeWorkspace = normalizeContextMode(chat.contextMode) === 'code' && !!activeWorkspace?.rootPath;
        const codeInstanceId = normalizeContextMode(chat.contextMode) === 'code' ? chat.codeAgent?.instanceId : undefined;
        const agentResult = await runCodeAgent({
          chatId: targetChatId,
          systemPrompt: styledSystemPrompt,
          messages: previousMessages,
          rawPrompt,
          executionMode: isCodeWorkspace ? 'workspace' : 'sandbox',
          workspaceRoot: isCodeWorkspace ? activeWorkspace?.rootPath : undefined,
          workspaceName: activeWorkspace?.rootName,
          workspaceFiles: activeWorkspace?.files,
          runtimeMode: isCodeWorkspace ? (chat.codeAgent?.runtimeMode || 'full') : undefined,
          reasoningLevel: chat.reasoningLevel ?? this.reasoningLevel,
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
        }, chat.codeAgent?.instanceId);
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
          reasoningLevel: this.reasoningLevel,
          onChunk: (value) => {
            reasoningTimer.markStopped();
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

  private async commitConfig(next: AppConfig, options: {
    refreshModels?: boolean;
    refreshLocalStatus?: boolean;
    detectTools?: boolean;
  } = {}) {
    this.config = next;
    await saveAppConfig(next);
    if (options.refreshModels) {
      await this.refreshModels();
    }
    if (isTauri() && options.detectTools) {
      detectToolSupport().catch(() => {});
      this.refreshReasoningCapabilities().catch(() => {});
    }
    if (isTauri() && options.refreshLocalStatus) {
      await modelsStore.refreshStatus();
    }
  }

  async refreshModels(force?: boolean) {
    if (this.backendMode === 'local' && isTauri()) {
      this.modelsRefreshing = true;
      try {
        await modelsStore.refreshIndex();
        const localModels = await Promise.all(modelsStore.availableModels.map(async (m) =>
          buildLocalModelOption(m, !!(m.path && await this.detectMmprojForModel(m.path)))
        ));
        this.models = localModels;
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
    const next = mergeProviderConfig(this.config, partial);
    await this.commitConfig(next, {
      refreshModels: true,
      detectTools: true,
      refreshLocalStatus: next.llm?.backend_mode === 'local'
    });
  }

  async setBackendMode(mode: 'local' | 'api') {
    const current = this.config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
    if (current === mode) return;
    await this.commitConfig(setBackendModeConfig(this.config, mode), {
      refreshModels: true,
      refreshLocalStatus: true
    });
  }

  async updateLocalModel(model: ModelOption) {
    await this.commitConfig(setLocalModelConfig(this.config, model), {
      refreshModels: true,
      refreshLocalStatus: true
    });
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
    await this.commitConfig(mergeLocalSettingsConfig(this.config, partial), {
      refreshLocalStatus: true
    });
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
    await this.commitConfig(mergeWorkspaceModeConfig(this.config, mode));
  }

  async updateUiSettings(partial: {
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
  }) {
    await this.commitConfig(mergeUiSettingsConfig(this.config, partial));
  }

  async updatePromptSettings(partial: {
    system_prompt?: string;
    user_prompt?: string;
    local_system_prompt?: string;
  }) {
    await this.commitConfig(mergePromptSettingsConfig(this.config, partial));
  }

  async updateSearchSettings(partial: {
    provider?: string;
    max_results?: number;
    context_budget_chars?: number;
    aggregator_engines?: string[];
    safe_search?: number;
    providers?: NonNullable<AppConfig['search']>['providers'];
  }) {
    await this.commitConfig(mergeSearchSettingsConfig(this.config, partial));
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
    await this.commitConfig(mergeTtsSettingsConfig(this.config, partial));
  }
}

export const appStore = new AppStore();
