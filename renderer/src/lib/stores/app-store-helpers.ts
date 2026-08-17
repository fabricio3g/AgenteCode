import type { AgentActivity, AgentOutcome, AgentStopReason, ChatContextMode, ChatFolder, ChatMessage, ChatSession, MessageVersion, ModelOption, SearchMeta } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/tauri';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import { runAgentTask } from '$lib/services/agent';
import { normalizeStreamingReasoningDelta } from '$lib/services/streaming';
import { isTauri } from '$lib/services/tauri';
import { createId as createSharedId } from '$lib/utils/id';
import { activityLabel } from '$lib/utils/tool-ui';
import type { GenerationBackendMode } from '$lib/stores/app-store-types';
import type { ApiModelMetadataValue, ContextBudgetValue } from '$lib/stores/app-context-budget';

export type ContextBudget = ContextBudgetValue;
export type ApiModelMetadata = ApiModelMetadataValue;

export type ElectronApi = {
  invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
};

export type LocalModelLoadTarget = Omit<ModelOption, 'source'> & { source?: string };
export type MainView = 'chat';

export const USER_NAME_KEY = 'chatealm_user_name';

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
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

export function getElectronApi(): ElectronApi | null {
  if (typeof window === 'undefined') return null;
  return (window as { electronAPI?: ElectronApi }).electronAPI || null;
}

export function toInvoke(api: ElectronApi): ElectronApi['invoke'] {
  return (channel, payload) => api.invoke(channel, payload);
}

export const createId = createSharedId;

type AgentStoreResult = Awaited<ReturnType<typeof runAgentTask>>;

export function hasUsableAgentResult(result: AgentStoreResult): boolean {
  return !!(
    result.content?.trim() ||
    result.sources?.length ||
    result.artifact ||
    result.steps?.some((step) => step.status === 'done' || step.output)
  );
}

export function agentOutcome(result: AgentStoreResult): AgentOutcome {
  if (result.outcome) return result.outcome;
  if (result.error && hasUsableAgentResult(result)) return 'stopped';
  if (result.error) return 'failed';
  if (result.warning) return 'partial';
  return 'completed';
}

export function agentStopReason(result: AgentStoreResult): AgentStopReason {
  if (result.stopReason) return result.stopReason;
  const text = `${result.error || ''} ${result.warning || ''}`.toLowerCase();
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('loop')) return 'loop';
  if (text.includes('tool') && (text.includes('limit') || text.includes('budget'))) return 'tool_limit';
  if (text.includes('iteration')) return 'iteration_limit';
  if (text.includes('requested file') || text.includes('artifact')) return 'missing_artifacts';
  return result.error ? 'error' : 'none';
}

export function reliableUsageMetadata(
  usage: CompletionResult['usage'],
  _elapsedSeconds: number,
  source: 'provider' | 'runtime'
): NonNullable<MessageVersion['metadata']> | null {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.prompt_eval_count ?? 0) || undefined;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.eval_count ?? 0) || undefined;
  const totalTokens = Number(usage.total_tokens ?? ((inputTokens || 0) + (outputTokens || 0))) || undefined;
  const runtimeTimings = usage.timings;
  const predictedMs = Number(runtimeTimings?.predicted_ms || 0);
  const legacyEvalDurationSeconds = Number(usage.eval_duration || 0) > 0
    ? Number(usage.eval_duration) / 1_000_000_000
    : 0;
  const timing = predictedMs > 0 ? predictedMs / 1000 : legacyEvalDurationSeconds || undefined;
  const nativeTokensPerSecond = Number(runtimeTimings?.predicted_per_second || 0);
  const tokensPerSecond = nativeTokensPerSecond > 0
    ? nativeTokensPerSecond
    : outputTokens && timing && timing > 0 ? outputTokens / timing : undefined;
  if (!inputTokens && !outputTokens && !totalTokens && !timing) return null;
  return {
    usageSource: source,
    timingScope: timing ? 'model' : 'unknown',
    inputTokens,
    outputTokens,
    totalTokens,
    promptEvalTimingSeconds: Number(runtimeTimings?.prompt_ms || 0) > 0
      ? Number(runtimeTimings?.prompt_ms) / 1000
      : undefined,
    tokens: outputTokens,
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

export function executionMetadata(backendMode: GenerationBackendMode): NonNullable<MessageVersion['metadata']> {
  return {
    executionBackend: backendMode,
    executionTransport: backendMode === 'local' ? 'local_runtime' : (isTauri() ? 'provider_ipc' : 'sdk')
  };
}

export type AssistantMetadata = NonNullable<MessageVersion['metadata']>;

export function finalizeAssistantMetadata(options: {
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

export function startReasoningTimer() {
  return {
    startedAt: 0,
    stoppedAt: 0,
    markStarted() {
      if (!this.startedAt) this.startedAt = Date.now();
    },
    markStopped() {
      if (this.startedAt && !this.stoppedAt) this.stoppedAt = Date.now();
    },
    elapsedSeconds() {
      if (!this.startedAt) return undefined;
      const end = this.stoppedAt || Date.now();
      return (end - this.startedAt) / 1000;
    }
  };
}

/**
 * Map free-form progress text to an activity. The label always comes from the
 * shared vocabulary in `tool-ui.ts` so the single-line working UI shows one verb
 * per state rather than whichever phrasing this file happened to use.
 */
export function activityFromProgress(text: string): { currentActivity: AgentActivity; activityLabel: string } {
  const value = String(text || '').toLowerCase();

  const activity: AgentActivity =
    value.includes('search')
      ? 'searching'
      : value.includes('fetch') || value.includes('read') || value.includes('source')
        ? 'reading'
        : /document|spreadsheet|presentation|pdf|file|artifact|write/.test(value)
          ? 'creating_files'
          : /final|answer|response|producing/.test(value)
            ? 'writing'
            : 'planning';

  return { currentActivity: activity, activityLabel: activityLabel(activity) };
}

/** Skip metadata writes when activity type is unchanged (cuts UI thrash). */
export function setAgentActivity(message: ChatMessage, activity: AgentActivity, activityLabel: string) {
  const prev = message.metadata?.currentActivity;
  const prevLabel = message.metadata?.activityLabel;
  if (prev === activity && prevLabel === activityLabel) return;

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

export function markAgentWriting(message: ChatMessage) {
  const label = activityLabel('writing');
  setAgentActivity(message, 'writing', label);

  const steps = message.agentSteps || [];
  const last = steps[steps.length - 1];
  if (last?.label === label || last?.label === 'Writing answer') {
    last.status = 'running';
    last.label = label;
    last.detail = 'Preparing final response';
    message.agentSteps = [...steps];
    return;
  }
  message.agentSteps = [
    ...steps.map((step) => step.status === 'running' ? { ...step, status: 'done' as const } : step),
    { id: createId('step'), type: 'thinking', label, status: 'running', detail: 'Preparing final response' }
  ];
}

export function markAgentStopped(message: ChatMessage) {
  const steps = message.agentSteps || [];
  if (!steps.length) return;

  // A run stopped before tools started should not leave a misleading Planning card.
  const hasWorkStep = steps.some((step) =>
    !['thinking', 'planning'].includes(step.type)
    || !!step.output
    || !!step.diffStats?.length
  );
  if (!hasWorkStep) {
    message.agentSteps = [];
    return;
  }

  let activeIndex = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].status === 'running' || steps[index].status === 'pending') {
      activeIndex = index;
      break;
    }
  }
  message.agentSteps = steps.map((step, index) => {
    if (step.status !== 'running' && step.status !== 'pending') return step;
    if (index === activeIndex && (step.type === 'thinking' || step.type === 'planning')) {
      return { ...step, label: 'Stopped', status: 'done', detail: 'Stopped by user' };
    }
    return { ...step, status: 'done', detail: index === activeIndex ? 'Stopped by user' : step.detail };
  });
}

export function updateStreamingVersion(message: ChatMessage, content: string, reasoning: string, metadata: MessageVersion['metadata']) {
  message.versions = [{
    content,
    createdAt: message.createdAt,
    reasoning,
    metadata
  }];
}

export function appendStreamingContent(
  message: ChatMessage,
  chunk: string,
  reasoning: string,
  metadata: MessageVersion['metadata']
) {
  if (!chunk) return;
  message.content += chunk;
  updateStreamingVersion(message, message.content, reasoning, metadata);
}

export function appendStreamingReasoning(current: string, chunk: string): string {
  const cleaned = normalizeStreamingReasoningDelta(chunk);
  if (!cleaned) return current;
  return `${current || ''}${cleaned}`;
}

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

export const WORKSPACE_MAX_FILES = 120;
export const WORKSPACE_MAX_FILE_SIZE_BYTES = 512 * 1024;

export const WEB_RAG_MIN_ANSWER_CHARS = 200;
export const WEB_RAG_MAX_SOURCES = 12;

export function normalizeText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function buildWebRagPayload({ query, answer, sources }: { query: string; answer: string; sources: SearchResult[] }) {
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

export function isAbortLikeError(value: unknown): boolean {
  const text = String(value || '').toLowerCase();
  return text.includes('abort') || text.includes('cancel');
}

/**
 * Parse <write_file path="...">content</write_file> blocks from an LLM response.
 * Returns an array of {path, content} objects.
 */
export function parseWriteFileBlocks(text: string): Array<{ path: string; content: string }> {
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
export function stripWriteFileBlocks(text: string, created: Array<{ path: string }>): string {
  if (!created.length) return text;
  let cleaned = text.replace(/<write_file\s+path="[^"]+"\s*>[\s\S]*?<\/write_file>/g, '').trim();
  // Remove double blank lines left behind
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function getAssistantActiveVersion(message: Partial<ChatMessage>): MessageVersion | null {
  if (!Array.isArray(message.versions) || !message.versions.length) return null;
  const index = typeof message.activeVersion === 'number'
    ? Math.max(0, Math.min(message.activeVersion, message.versions.length - 1))
    : 0;
  return message.versions[index] || message.versions[0] || null;
}

export function getMessageRequestContent(message: Partial<ChatMessage>) {
  if (message.role === 'assistant') {
    return getAssistantActiveVersion(message)?.content || String(message.content || '');
  }
  return String(message.content || '');
}

export function buildRequestMessagesFromHistory(messages: ChatMessage[], upToIndex = messages.length - 1): RequestMessage[] {
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

export function normalizeMessage(message: Partial<ChatMessage>, index: number): ChatMessage {
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

export function normalizeContextMode(mode: unknown): ChatContextMode {
  // Legacy 'code' sessions migrate to Work.
  if (mode === 'work' || mode === 'code') return 'work';
  return 'chat';
}

export function normalizeSessionComposerMode(
  mode: unknown,
  contextMode: ChatContextMode
): 'chat' | 'agent' {
  if (mode === 'chat' || mode === 'agent') return mode;
  return contextMode === 'work' ? 'agent' : 'chat';
}

export function normalizeSessionSearchMode(mode: unknown): 'chat' | 'search' | 'deep' | 'max' {
  return mode === 'search' || mode === 'deep' || mode === 'max' || mode === 'chat' ? mode : 'chat';
}

/** One-time identity fix: workspace-backed sessions belong in Work. Legacy code → work. */
export function resolveImmutableContextMode(chat: Partial<ChatSession>): ChatContextMode {
  const mode = normalizeContextMode(chat.contextMode);
  if (mode === 'work') return 'work';
  if (chat.workspace) return 'work';
  return 'chat';
}

export function normalizeChat(chat: Partial<ChatSession>, index: number): ChatSession {
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map((message, messageIndex) => normalizeMessage(message, messageIndex))
    : [];
  const contextMode = resolveImmutableContextMode(chat);

  return {
    id: String(chat.id || createId(`chat-${index}`)),
    title: String(chat.title || 'New chat'),
    createdAt: Number.isFinite(chat.createdAt) ? Number(chat.createdAt) : Date.now(),
    updatedAt: Number.isFinite(chat.updatedAt) ? Number(chat.updatedAt) : Date.now(),
    folderId: chat.folderId ?? null,
    draft: String(chat.draft || ''),
    contextMode,
    // Agente Coding conversations carry their project + engine session
    // identity through persistence — resume depends on both surviving.
    codeAgent: chat.codeAgent ?? null,
    projectId: chat.projectId ?? null,
    workspace: chat.workspace || null,
    reasoningLevel: chat.reasoningLevel ?? null,
    composerMode: normalizeSessionComposerMode(chat.composerMode, contextMode),
    searchMode: normalizeSessionSearchMode(chat.searchMode),
    messages
  };
}

export function normalizeFolder(folder: Partial<ChatFolder>, index: number): ChatFolder {
  return {
    id: String(folder.id || createId(`folder-${index}`)),
    name: String(folder.name || 'Folder'),
    parentId: folder.parentId ?? null,
    createdAt: Number.isFinite(folder.createdAt) ? Number(folder.createdAt) : Date.now()
  };
}

export function buildSearchConversationContext(chat: ChatSession | null, currentUserMessageId?: string) {
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

export function canStartGeneration(args: {
  backendMode: GenerationBackendMode;
  targetChatId: string;
  activeProvider?: { has_api_key?: boolean; api_key?: string; model?: string } | null;
  selectedLocalModelPath?: string;
  localModelActive?: boolean;
  localBusyActionText?: string;
  isChatGenerating: (chatId: string) => boolean;
  hasOtherChatGeneration: (chatId: string) => boolean;
  info: (message: string, duration?: number) => void;
  error: (message: string) => void;
}): boolean {
  if (args.isChatGenerating(args.targetChatId)) return false;

  if (args.backendMode === 'local' && args.hasOtherChatGeneration(args.targetChatId)) {
    const actionText = args.localBusyActionText || 'starting a local response here';
    args.info(`Local model is busy in another chat. Stop that run before ${actionText}.`, 3200);
    return false;
  }

  if (args.backendMode === 'local') {
    if (!args.selectedLocalModelPath) {
      args.error('No local model selected. Open Models to download and load a model.');
      return false;
    }
    if (!args.localModelActive) {
      args.error('No model is loaded yet. Load a model from Models first, then try again.');
      return false;
    }
  }

  if (args.backendMode === 'api' && !args.activeProvider?.has_api_key && !args.activeProvider?.api_key) {
    args.error('No API key configured. Open Settings to add a provider key.');
    return false;
  }
  if (args.backendMode === 'api' && !args.activeProvider?.model) {
    args.error('No API model selected. Choose a model in the selector first.');
    return false;
  }

  return true;
}

export function buildContextualPrompt(args: {
  content: string;
  searchContext?: string;
  researchSummary?: string;
  ragContext?: string;
  workspaceContext?: string;
  mode: 'chat' | 'agent';
  searchMode?: 'chat' | 'search' | 'deep' | 'max';
}) {
  const extras: string[] = [];
  const guidance: string[] = [];
  if (args.ragContext) extras.push(`<documents>\n${args.ragContext}\n</documents>`);
  if (args.searchContext) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    extras.push(`<web_search_results date="${dateStr}" time="${timeStr}">\n${args.searchContext}\n</web_search_results>`);
  }
  if (args.researchSummary) extras.push(`<deep_research_brief>\n${args.researchSummary}\n</deep_research_brief>`);
  if (args.workspaceContext) extras.push(`<workspace>\n${args.workspaceContext}\n</workspace>`);
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
      searchModeLabel !== 'chat'
        ? `Use the web_search tool with mode "${searchModeLabel}" before answering when the task needs online or current information.`
        : 'For weather call get_weather; for currency conversion call convert_currency; for stock/crypto prices call get_quote. For other current news/version questions call web_search. Never invent live numbers.',
      'Turn useful work into artifacts instead of only replying in chat.',
      'For research or competitor analysis, create a report file the user can open or download.',
      'When the user asks for slides, a deck, a document, an Excel workbook, or a PDF, use the matching artifact tool so the chat gets a real file and viewer.',
      'For code requests, create the actual files, test them when possible, and include a previewable HTML result when it helps.'
    ].join(' '));
  }
  if (!extras.length && !guidance.length) return args.content;
  if (!guidance.length) guidance.push('Answer the user using the supplemental context when it is relevant. Cite concrete details from the context instead of inventing facts.');

  return [guidance.join(' '), extras.join('\n\n'), `User question:\n${args.content}`].join('\n\n');
}

