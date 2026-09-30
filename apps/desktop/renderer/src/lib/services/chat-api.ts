import { isVisionModel } from '$shared/model-capabilities';
import OpenAI from 'openai';
import type { AppConfig, ChatMessage, ModelOption, ReasoningCapabilities, ReasoningLevel, ReasoningRequest } from '$lib/types/chat';
import type { LocalModel } from '$lib/types/bridge';
import { getIndexedModels, getLocalModels } from '$lib/services/models';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { normalizeStreamingContentDelta, normalizeStreamingReasoningDelta } from '$lib/services/streaming';
import { invoke, listen, isElectron } from '$lib/services/bridge';
import { createStreamIdleWatchdog, streamIdleTimeoutMessage } from '$lib/services/chat-stream-idle';
import { loadAppConfig } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';
import type { RoleplaySampling } from '$lib/services/roleplay-prompts';
import { DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_ID } from '$shared/providers';

const _openaiClients = new Map<string, OpenAI>();

type UnknownRecord = Record<string, unknown>;
type ProviderLike = {
  model?: unknown;
  base_url?: unknown;
  api_key?: unknown;
};
type LocalConfigLike = {
  model?: unknown;
  base_url?: unknown;
  selected_model_path?: unknown;
};
type AppConfigLike = {
  llm?: {
    backend_mode?: string;
    provider?: string;
    local?: LocalConfigLike;
    providers?: Record<string, ProviderLike>;
  };
  ui?: { agent_debug_logs?: boolean };
};

function getOpenAIClient(apiKey: string, baseUrl: string): OpenAI {
  const normalized = String(baseUrl || DEFAULT_PROVIDER_BASE_URL).replace(/\/+$/, '');
  const clientKey = `${apiKey}::${normalized}`;
  if (!_openaiClients.has(clientKey)) {
    _openaiClients.set(clientKey, new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL: normalized,
      dangerouslyAllowBrowser: true
    }));
  }
  return _openaiClients.get(clientKey)!;
}

function resolveProvider(config: AppConfig) {
  const providerName = config.llm?.provider || DEFAULT_PROVIDER_ID;
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {
    base_url: DEFAULT_PROVIDER_BASE_URL,
    model: ''
  };
  return { providerName, provider };
}

// ── Tool support detection ──────────────────────────────────────────────
// Instead of hardcoded model name patterns, we probe the actual API.
// For local models: GGUF metadata's chat_template_uses_tools flag.
// For API providers: lightweight completion test with a tool definition.
// Results are cached in-memory for the session.

const toolSupportCache = new Map<string, boolean>();

function toolSupportCacheKey(providerName: string, modelId: string): string {
  return `${providerName}:${modelId}`;
}

function resolveLocalModelName(config: AppConfigLike): string {
  return String(config?.llm?.local?.model || '').trim() || 'local-model';
}

function toolSupportIdentity(config: AppConfigLike): { providerName: string; modelId: string; provider: UnknownRecord } {
  if (config?.llm?.backend_mode === 'local') {
    const local = config?.llm?.local || {};
    return {
      providerName: 'local',
      modelId: resolveLocalModelName(config),
      provider: {
        base_url: local.base_url || 'http://127.0.0.1:11435/v1',
        model: resolveLocalModelName(config)
      }
    };
  }
  const providerName = config?.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = config?.llm?.providers?.[providerName] || {};
  return { providerName, modelId: String(provider?.model || ''), provider };
}

function debugToolSupport(config: AppConfigLike, message: string) {
  if (config?.ui?.agent_debug_logs) console.log(message);
}

/**
 * Synchronous check — reads from the probe cache.
 * For uncached first-party providers: always true (they support tools).
 * For uncached third-party providers: defaults to true (try native, the
 * agent's error handler will fall back to XML if the model rejects tools).
 * Call detectToolSupport() on model selection to populate the cache.
 */
export function supportsNativeTools(config: AppConfigLike): boolean {
  const { providerName, modelId } = toolSupportIdentity(config);
  const key = toolSupportCacheKey(providerName, modelId);

  if (toolSupportCache.has(key)) {
    const result = toolSupportCache.get(key)!;
    debugToolSupport(config, `[agent] supportsNativeTools | providerName=${providerName} | modelId=${modelId} | cached=${result}`);
    return result;
  }

  // First-party providers always support native tool calling
  if (providerName === 'deepseek') {
    toolSupportCache.set(key, true);
    debugToolSupport(config, `[agent] supportsNativeTools | providerName=${providerName} | modelId=${modelId} | first-party -> true`);
    return true;
  }

  if (providerName === 'local') {
    // Uncached local: try native. The agent falls back to XML when the model
    // rejects tools, so failing open is correct — failing closed silently
    // drops tool definitions that the local server would have honored.
    debugToolSupport(config, `[agent] supportsNativeTools | providerName=local | modelId=${modelId} | uncached -> true`);
    return true;
  }

  // Uncached third-party: default to true (agent will fall back on error)
  debugToolSupport(config, `[agent] supportsNativeTools | providerName=${providerName} | modelId=${modelId} | uncached -> true`);
  return true;
}

/**
 * Probe the API/GGUF metadata to detect native tool support.
 * Call this when the model selection changes (updateProvider, load local model, etc.).
 * Caches the result so supportsNativeTools() returns accurate values.
 */
export async function detectToolSupport(): Promise<boolean> {
  if (!isElectron()) return true;

  const config = await loadAppConfig();
  const { providerName, modelId, provider } = toolSupportIdentity(config);
  const key = toolSupportCacheKey(providerName, modelId);

  // Don't re-probe already-cached entries
  if (toolSupportCache.has(key)) return toolSupportCache.get(key)!;

  // First-party providers are known to support tools
  if (providerName === 'deepseek') {
    toolSupportCache.set(key, true);
    return true;
  }

  try {
    const result = await invoke<{ supportsTools: boolean; source: string }>('detect_tool_support', {
      baseUrl: provider?.base_url || '',
      apiKey: provider?.api_key || '',
      providerName,
      model: modelId,
      modelPath: config.llm?.local?.selected_model_path || ''
    });

    const supports = result?.supportsTools ?? true;
    toolSupportCache.set(key, supports);
    debugToolSupport(config, `[agent] detectToolSupport | ${providerName}/${modelId} -> ${supports} (source: ${result?.source})`);
    return supports;
  } catch (err: unknown) {
    console.warn('[agent] detectToolSupport probe failed, defaulting to true:', err);
    // Don't cache on probe failure — try again next time
    return true;
  }
}

/**
 * Record that a model does NOT support native tools.
 * Called by the agent when native tool calling fails at runtime.
 */
export function setToolSupportCache(config: AppConfigLike, supports: boolean): void {
  const { providerName, modelId } = toolSupportIdentity(config);
  const key = toolSupportCacheKey(providerName, modelId);
  toolSupportCache.set(key, supports);
  debugToolSupport(config, `[agent] setToolSupportCache | ${providerName}/${modelId} -> ${supports}`);
}

/**
 * Identity of the route a reasoning-capabilities probe belongs to. The store
 * skips re-probing when the identity is unchanged, so every settings save
 * doesn't hit the provider catalog — and a stale probe can never pass as
 * the current route's levels after a backend/provider/model switch.
 */
export function reasoningRouteIdentity(config: AppConfig | null | undefined): string {
  const backendMode = config?.llm?.backend_mode || 'local';
  if (backendMode === 'local') {
    const local = config?.llm?.local || {};
    return `local:${local.model || ''}:${local.selected_model_path || ''}`;
  }
  const providerName = config?.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = (config?.llm?.providers?.[providerName] || {}) as { base_url?: string; model?: string };
  return `api:${providerName}:${provider.base_url || ''}:${provider.model || ''}`;
}

/**
 * Ask the active provider what reasoning levels it supports for the current
 * model. The provider is the single source of truth — no model-name guessing
 * in the renderer. Returns `source: 'unknown'` (selector hidden) when the
 * provider can't confirm support.
 */
export async function fetchReasoningCapabilities(args: {
  baseUrl?: string;
  apiKey?: string;
  providerName?: string;
  model: string;
  modelPath?: string;
}): Promise<ReasoningCapabilities> {
  if (!isElectron()) {
    return { supported: false, levels: [], source: 'unknown' };
  }
  try {
    const result = await invoke<ReasoningCapabilities>('get_reasoning_capabilities', {
      baseUrl: args.baseUrl || '',
      apiKey: args.apiKey || '',
      providerName: args.providerName || '',
      model: args.model,
      modelPath: args.modelPath || ''
    });
    return result || { supported: false, levels: [], source: 'unknown' };
  } catch {
    return { supported: false, levels: [], source: 'unknown' };
  }
}

/**
 * Build a `reasoning` request object for the API body from a chat-level
 * `reasoningLevel`. null/undefined → omit (server default). 'off' is a real
 * level, not an alias for "unset": dialects that can disable thinking map it
 * (local → enable_thinking false, gemini → budget 0, deepseek → disabled)
 * while the rest ignore it.
 */
export function buildReasoningRequest(level?: ReasoningLevel | null): ReasoningRequest | undefined {
  if (!level) return undefined;
  return { level };
}

function resolveLocalModels(localModels: LocalModel[]): ModelOption[] {
  return localModels.map((entry) => ({
    id: entry.id,
    name: entry.name,
    source: 'local',
    path: entry.path,
    details: [entry.architecture, entry.size_label].filter(Boolean).join(' • ')
  }));
}

// Multimodal content part for vision APIs
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface RequestMessage {
  providerState?: { provider: string; blocks: Array<Record<string, unknown>> };
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  /** DeepSeek / OpenAI-compatible chain-of-thought; required when echoing tool-call turns. */
  reasoning_content?: string | null;
  attachments?: Array<{ kind?: string; base64?: string; name?: string; ocrText?: string }>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolParameterSchema {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  items?: ToolParameterSchema;
  required?: string[];
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | ToolParameterSchema;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameterSchema>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionResult {
  providerState?: RequestMessage['providerState'];
  content: string;
  reasoning: string;
  toolCalls?: NativeToolCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    eval_count?: number;
    eval_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    timings?: {
      prompt_n?: number;
      prompt_ms?: number;
      prompt_per_second?: number;
      predicted_n?: number;
      predicted_ms?: number;
      predicted_per_second?: number;
      total_ms?: number;
    };
  } | null;
}

/** Preserve llama.cpp's top-level runtime timings alongside OpenAI usage. */
export function normalizeRuntimeUsage(usage: unknown, timings?: unknown): CompletionResult['usage'] {
  const usageRecord = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const timingRecord = timings && typeof timings === 'object'
    ? timings as Record<string, unknown>
    : usageRecord.timings && typeof usageRecord.timings === 'object'
      ? usageRecord.timings as Record<string, unknown>
      : null;
  if (!Object.keys(usageRecord).length && !timingRecord) return null;
  return {
    ...usageRecord,
    ...(timingRecord ? { timings: timingRecord } : {})
  } as CompletionResult['usage'];
}

interface ChatStreamEvent {
  streamId: string;
  type: 'delta' | 'done' | 'error' | 'cancelled';
  content?: string;
  reasoning?: string;
  usage?: CompletionResult['usage'];
  error?: string;
}

/** Returns true if model name suggests vision capability */
export { isVisionModel };

async function hasLocalVisionModel(config: AppConfig): Promise<boolean> {
  const mmprojPath = String(config.llm?.local?.mmproj_path || '').trim();
  if (!mmprojPath) return false;
  if (!isElectron()) return true;
  try {
    return await invoke<boolean>('path_exists', { path: mmprojPath });
  } catch {
    return false;
  }
}

export async function hasConfiguredVisionModel(config: AppConfig): Promise<boolean> {
  const backendMode = config.llm?.backend_mode || (isElectron() ? 'local' : 'api');
  if (backendMode === 'local') {
    return hasLocalVisionModel(config);
  }
  const providerName = config.llm?.provider || DEFAULT_PROVIDER_ID;
  const provider = config.llm?.providers?.[providerName];
  return isVisionModel(provider?.model || '');
}

export function toRequestMessages(messages: RequestMessage[], modelName?: string, hasMmproj?: boolean) {
  const visionCapable = hasMmproj !== undefined ? hasMmproj : isVisionModel(modelName || '');
  return messages.map((message) => {
    const base: Record<string, unknown> = { role: message.role };

    const imageAttachments = message.attachments?.filter(
      (a) => a.kind === 'image' && a.base64 && String(a.base64).startsWith('data:')
    ) || [];

    const ocrTexts: string[] = [];
    for (const att of message.attachments || []) {
      if (att.ocrText) ocrTexts.push(`[${att.name}]: ${att.ocrText}`);
    }
    const ocrContext = ocrTexts.length ? '\n\n--- Attached file contents ---\n' + ocrTexts.join('\n\n') : '';

    if (message.role === 'user' && imageAttachments.length && visionCapable) {
      const parts: ContentPart[] = [];
      const textContent = (message.content || '') + ocrContext;
      if (textContent) parts.push({ type: 'text', text: String(textContent) });
      for (const img of imageAttachments) {
        parts.push({ type: 'image_url', image_url: { url: img.base64!, detail: 'auto' } });
      }
      base.content = parts;
    } else {
      base.content = Array.isArray(message.content)
        ? [...message.content, ...(ocrContext ? [{ type: 'text' as const, text: ocrContext }] : [])]
        : (message.content || '') + ocrContext;
    }

    if (message.tool_calls) base.tool_calls = message.tool_calls;
    if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
    if (message.name) base.name = message.name;
    if (message.reasoning_content != null) base.reasoning_content = message.reasoning_content;
    if (message.providerState) base.providerState = message.providerState;
    return base;
  });
}

export async function loadChatConfig(): Promise<AppConfig> {
  const config = await loadAppConfig();
  const next: AppConfig = {
    ...config,
    llm: {
      ...config.llm,
      provider: config.llm?.provider || DEFAULT_PROVIDER_ID,
      backend_mode: config.llm?.backend_mode || (isElectron() ? 'local' : 'api'),
      providers: {
        ...(config.llm?.providers || {}),
        openai: {
          base_url: DEFAULT_PROVIDER_BASE_URL,
          model: '',
          has_api_key: false,
          ...(config.llm?.providers?.openai || {})
        }
      },
      local: {
        base_url: config.llm?.local?.base_url || 'http://127.0.0.1:11435/v1',
        context_length: config.llm?.local?.context_length || 4096,
        gpu_layers: config.llm?.local?.gpu_layers ?? 0,
        cpu_threads: config.llm?.local?.cpu_threads || 4,
        batch_size: config.llm?.local?.batch_size || 512,
        flash_attention: config.llm?.local?.flash_attention ?? true,
        offload_kv_cache: config.llm?.local?.offload_kv_cache ?? true,
        keep_in_memory: config.llm?.local?.keep_in_memory ?? true,
        mmap: config.llm?.local?.mmap ?? true,
        seed: config.llm?.local?.seed ?? null,
        rope_freq_base: config.llm?.local?.rope_freq_base ?? null,
        rope_freq_scale: config.llm?.local?.rope_freq_scale ?? null,
        parallel: config.llm?.local?.parallel ?? null,
        cache_type_k: config.llm?.local?.cache_type_k || 'f16',
        cache_type_v: config.llm?.local?.cache_type_v || 'f16',
        mmproj_path: config.llm?.local?.mmproj_path || undefined,
        ...(config.llm?.local || {})
      }
    },
    search: {
      provider: config.search?.provider || 'aggregator',
      max_results: config.search?.max_results || 6
    },
    tts: {
      enable_voice_output: config.tts?.enable_voice_output ?? true,
      auto_play_voice: config.tts?.auto_play_voice ?? false,
      voice: config.tts?.voice || '',
      speed: config.tts?.speed ?? 1
    },
    ui: {
      theme: config.ui?.theme,
      show_assistant_text: config.ui?.show_assistant_text ?? true,
      enable_thinking: config.ui?.enable_thinking ?? true
    }
  };
  return next;
}

export async function fetchModels(config?: AppConfig, apiKeyOverride?: string): Promise<ModelOption[]> {
  const resolvedConfig = config || (await loadChatConfig());
  // ...
  const { provider, providerName } = resolveProvider(resolvedConfig);
  const apiKey = (apiKeyOverride ?? provider.api_key) || '';
  if (!provider.base_url) return [];

  // Listing models needs a key. Calling without one throws in the main process
  // and logs a handler error on every startup, and the result is discarded here
  // anyway. Keyless local runtimes (llama.cpp, Ollama, LM Studio) still apply.
  const isLocalProvider = providerName === 'local'
    || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(provider.base_url);
  if (!apiKey && !provider.has_api_key && !isLocalProvider) return [];

  if (isElectron()) {
    try {
      const ids = await invoke<string[]>('fetch_provider_models', {
        baseUrl: provider.base_url,
        apiKey,
        providerName
      });
      const mapped: ModelOption[] = (ids || []).map((id) => ({
        id: String(id || ''),
        name: String(id || 'Unnamed model'),
        source: 'api' as const
      }));
      return mapped.filter((entry) => !!entry.id);
    } catch {
      return [];
    }
  }

  try {
    const client = getOpenAIClient(apiKey, provider.base_url || '');
    const response = await client.models.list();
    const list = response?.data ?? [];
    return list
      .map((m: { id: string }) => ({
        id: String(m.id || ''),
        name: String(m.id || 'Unnamed model'),
        source: 'api' as const
      }))
      .filter((entry: ModelOption) => !!entry.id);
  } catch {
    return [];
  }
}

/**
 * Sampling for one request body.
 *
 * A resolved per-turn override (roleplay: card → session → world) wins over the
 * configured default. Whatever is unconfigured is left off the request entirely
 * so the provider applies its own value rather than receiving a zero or a null.
 */
function mergeSampling(
  overrides: RoleplaySampling | undefined,
  defaults: { temperature?: number; maxTokens?: number; topP?: number }
): Record<string, number> {
  const temperature = overrides?.temperature ?? defaults.temperature;
  const maxTokens = overrides?.maxTokens ?? defaults.maxTokens;
  const topP = overrides?.topP ?? defaults.topP;
  return {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(Number.isFinite(topP) ? { top_p: topP } : {})
  };
}

async function localRequestContext(config: AppConfig) {
  const baseUrl = resolveLocalBaseUrl({
    llm: { local: { base_url: await ensureLocalRuntime(config) } }
  } as AppConfig);
  return { baseUrl, hasVisionModel: await hasLocalVisionModel(config), model: resolveLocalModelName(config) };
}

type ProviderSampling = { temperature?: number; max_tokens?: number; top_p?: number };

function providerStreamParams(provider: ProviderSampling, overrides?: RoleplaySampling, stop?: string[]) {
  return {
    ...mergeSampling(overrides, { temperature: provider.temperature, maxTokens: provider.max_tokens, topP: provider.top_p }),
    ...(stop?.length ? { stop } : {})
  };
}

export function createChatStreamWatchdog(getStreamId: () => string, fail: (error: Error) => void) {
  return createStreamIdleWatchdog({
    onStall: () => {
      void invoke('chat_stream_cancel', { streamId: getStreamId() }).catch(() => {});
      fail(new Error(streamIdleTimeoutMessage()));
    }
  });
}

type ChatStreamCallbacks = {
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
};
type StreamSettlement = { resolve: () => void; reject: (error: Error) => void };

function deliverChatDelta(event: ChatStreamEvent, callbacks: ChatStreamCallbacks, local: boolean): void {
  if (event.reasoning) callbacks.onReasoning?.(local ? normalizeStreamingReasoningDelta(String(event.reasoning)) : String(event.reasoning));
  if (event.content) callbacks.onChunk(local ? normalizeStreamingContentDelta(String(event.content)) : String(event.content));
}

function finishChatStream(event: ChatStreamEvent, callbacks: ChatStreamCallbacks, settlement: StreamSettlement): void {
  if (event.usage) callbacks.onUsage?.(event.usage);
  settlement.resolve();
}

function isChatStreamFinished(event: ChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'cancelled';
}

function chatStreamError(event: ChatStreamEvent): Error {
  return new Error(event.error || 'Streaming request failed');
}

function deliverChatEvent(
  event: ChatStreamEvent, callbacks: ChatStreamCallbacks, settlement: StreamSettlement, local: boolean
): void {
  if (event.type === 'delta') deliverChatDelta(event, callbacks, local);
  else if (isChatStreamFinished(event)) finishChatStream(event, callbacks, settlement);
  else if (event.type === 'error') settlement.reject(chatStreamError(event));
}

async function streamChatRequest(request: UnknownRecord, callbacks: ChatStreamCallbacks, local: boolean): Promise<void> {
  let streamId = '';
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const streamPromise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const settlement = { resolve, reject };
  const idle = createChatStreamWatchdog(() => streamId, reject);
  const off = await listen<ChatStreamEvent>('chat-stream-event', (event) => {
    if (event?.streamId !== streamId) return;
    idle.arm();
    deliverChatEvent(event, callbacks, settlement, local);
  });
  try {
    const started = await invoke<{ streamId: string }>('chat_stream_start', request);
    streamId = started?.streamId || '';
    await waitChatStream(streamId, callbacks.signal, streamPromise, idle);
  } finally {
    idle.clear();
    off();
  }
}

async function waitChatStream(
  streamId: string, signal: AbortSignal | undefined, streamPromise: Promise<void>,
  idle: ReturnType<typeof createStreamIdleWatchdog>
): Promise<void> {
  if (!streamId) throw new Error('Failed to start chat stream');
  idle.arm();
  const abort = () => { void invoke('chat_stream_cancel', { streamId }).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await streamPromise;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function streamLocalReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
  reasoning?: ReasoningRequest;
  sampling?: RoleplaySampling;
  stop?: string[];
}): Promise<void> {
  const config = await loadChatConfig();
  // Proxied through the main process (chat_stream_start), not fetched from
  // here: llama-server is launched with a per-run `--api-key` that only main
  // knows (see main/llama-session.ts — it deliberately never reaches the
  // renderer, so a stray web page cannot drive the local model). A direct
  // fetch cannot authenticate and llama.cpp answers 401 "Invalid API Key".
  const { baseUrl, hasVisionModel, model } = await localRequestContext(config);

  await streamChatRequest({
    baseUrl,
    apiKey: '',
    providerName: 'local',
    body: {
      model,
      stream: true,
      messages: toRequestMessages(args.messages, model, hasVisionModel),
      ...(args.reasoning ? { reasoning: args.reasoning } : {}),
      ...mergeSampling(args.sampling, {
        temperature: config.llm?.local?.temperature, maxTokens: config.llm?.local?.max_tokens
      }),
      ...(args.stop?.length ? { stop: args.stop } : {})
    }
  }, args, true);
}

export async function streamAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
  apiKey?: string;
  reasoningLevel?: ReasoningLevel | null;
  sampling?: RoleplaySampling;
  stop?: string[];
}): Promise<void> {
  const config = await loadChatConfig();
  const reasoning = buildReasoningRequest(args.reasoningLevel);
  if (config.llm?.backend_mode === 'local' && isElectron()) {
    return streamLocalReply({ ...args, reasoning });
  }
  const { provider, providerName } = resolveProvider(config);
  const apiKey = (args.apiKey ?? provider.api_key) || '';

  if (isElectron()) {
    return streamChatRequest({
      baseUrl: provider.base_url, apiKey, providerName,
      body: {
        model: provider.model, stream: true,
        messages: toRequestMessages(args.messages, provider.model),
        ...(reasoning ? { reasoning } : {}),
        ...providerStreamParams(provider, args.sampling, args.stop)
      }
    }, args, false);
  }

  // Browser path (no Electron IPC): use OpenAI SDK directly
  const client = getOpenAIClient(apiKey, provider.base_url || '');

  const stream = await client.chat.completions.create({
    model: provider.model,
    stream: true,
    messages: toRequestMessages(args.messages, provider.model) as any,
    ...providerStreamParams(provider, args.sampling, args.stop),
  });

  for await (const chunk of stream) {
    const delta = (chunk.choices?.[0]?.delta || {}) as UnknownRecord;
    const content = delta.content;
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (reasoning) args.onReasoning?.(String(reasoning));
    if (content) args.onChunk(String(content));
  }
}

function firstCompletionMessage(payload: UnknownRecord): UnknownRecord {
  const choices = Array.isArray(payload?.choices) ? payload.choices as UnknownRecord[] : [];
  return (choices[0]?.message as UnknownRecord | undefined) || {};
}

function readCompletionPayload(payload: UnknownRecord): CompletionResult {
  const flat = typeof payload?.content === 'string';
  const message = flat ? payload : firstCompletionMessage(payload);
  const reasoning = flat ? message.reasoning : message.reasoning_content ?? message.reasoning ?? message.thinking;
  return {
    content: message.content != null ? String(message.content) : '',
    reasoning: reasoning != null ? String(reasoning) : '',
    usage: payload?.usage || null
  };
}

async function invokeProviderCompletion(
  route: ReturnType<typeof resolveProvider>, apiKey: string, body: UnknownRecord
): Promise<UnknownRecord> {
  return invoke<UnknownRecord>('chat_complete', {
    baseUrl: route.provider.base_url, apiKey, providerName: route.providerName, body
  });
}

async function fetchProviderCompletion(provider: ProviderSampling & { base_url?: string }, apiKey: string, body: UnknownRecord) {
  const client = getOpenAIClient(apiKey, provider.base_url || '');
  return client.chat.completions.create(body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
}

export async function completeAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  apiKey?: string;
  reasoningLevel?: ReasoningLevel | null;
  /**
   * When true (Search/Deep/Max research), do not apply the user/provider max_tokens
   * completion budget so long professional reports are not cut short.
   */
  omitMaxTokens?: boolean;
}): Promise<CompletionResult> {
  const config = await loadChatConfig();

  const reasoning = buildReasoningRequest(args.reasoningLevel);
  const omitMaxTokens = !!args.omitMaxTokens;

  if (config.llm?.backend_mode === 'local' && isElectron()) {
    // Proxied through main (chat_complete) for the same reason as
    // streamLocalReply: the llama-server `--api-key` session credential never
    // reaches the renderer.
    const { baseUrl, hasVisionModel, model } = await localRequestContext(config);
    const payload = await invoke<UnknownRecord>('chat_complete', {
      baseUrl,
      apiKey: '',
      providerName: 'local',
      body: {
        model,
        stream: false,
        messages: toRequestMessages(args.messages, model, hasVisionModel),
        ...(reasoning ? { reasoning } : {}),
        ...(Number.isFinite(config.llm?.local?.temperature) ? { temperature: config.llm!.local!.temperature } : {}),
        ...(!omitMaxTokens && config.llm?.local?.max_tokens ? { max_tokens: config.llm.local.max_tokens } : {})
      }
    });
    const result = readCompletionPayload(payload);
    result.usage = normalizeRuntimeUsage(payload?.usage) || result.usage || null;
    return result;
  }

  const route = resolveProvider(config);
  const { provider } = route;
  const apiKey = (args.apiKey ?? provider.api_key) || '';
  const body = {
    model: provider.model,
    stream: false,
    messages: toRequestMessages(args.messages),
    ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
    ...(!omitMaxTokens && provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
    ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
  };
  if (isElectron()) {
    const payload = await invokeProviderCompletion(route, apiKey, { ...body, ...(reasoning ? { reasoning } : {}) });
    return readCompletionPayload(payload);
  }
  const response = await fetchProviderCompletion(provider, apiKey, body);
  const result = readCompletionPayload(response as unknown as UnknownRecord);
  result.usage = response.usage ? {
    input_tokens: response.usage.prompt_tokens,
    output_tokens: response.usage.completion_tokens,
    total_tokens: response.usage.total_tokens
  } : null;
  return result;
}

function tryParseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function tryParseJsonValue<T>(value: unknown): T | null {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return null;
  }
}

function readToolCall(value: unknown, flat: boolean): NativeToolCall {
  const call = (value || {}) as UnknownRecord;
  const fn = (call.function as UnknownRecord | undefined) || {};
  const args = flat ? call.arguments : undefined;
  return {
    id: String(call.id || `call_${Math.random().toString(36).slice(2, 9)}`),
    name: String(fn.name || (flat ? call.name : '') || ''),
    arguments: args && typeof args === 'object'
      ? args as UnknownRecord
      : tryParseJsonObject(fn.arguments || args || '{}')
  };
}

export function readCompletionWithTools(payload: UnknownRecord): CompletionResult {
  const flat = typeof payload?.content === 'string';
  const message = flat ? payload : firstCompletionMessage(payload);
  const rawCalls = flat ? payload.toolCalls : message.tool_calls;
  const toolCalls = (Array.isArray(rawCalls) ? rawCalls : [])
    .map((call) => readToolCall(call, flat)).filter((call) => !!call.name);
  return {
    ...readCompletionPayload(payload),
    ...(flat && payload.providerState ? { providerState: payload.providerState as CompletionResult['providerState'] } : {}),
    toolCalls: toolCalls.length ? toolCalls : undefined
  };
}

// ── Phase 5: Structured Output ─────────────────────────────────────────────

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaDefinition {
  name: string;
  description?: string;
  schema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  strict?: boolean;
}

export interface StructuredExtractionResult<T = Record<string, unknown>> {
  data: T | null;
  raw: string;
  parsed: boolean;
  error?: string;
}

export function extractJsonFromResponse<T = Record<string, unknown>>(raw: string): StructuredExtractionResult<T> {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { data: null, raw: trimmed, parsed: false, error: 'Empty response' };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    return { data, raw: trimmed, parsed: true };
  } catch {
    // Continue to extraction strategies
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const data = JSON.parse(codeBlockMatch[1].trim()) as T;
      return { data, raw: trimmed, parsed: true };
    } catch {
      // Continue
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const data = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
      return { data, raw: trimmed, parsed: true };
    } catch {
      // Continue
    }
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const data = JSON.parse(trimmed.slice(firstBracket, lastBracket + 1)) as T;
      return { data, raw: trimmed, parsed: true };
    } catch {
      // Continue
    }
  }

  return { data: null, raw: trimmed, parsed: false, error: 'Could not extract valid JSON from response' };
}

export function buildJsonSystemPrompt(schema: JsonSchemaDefinition): string {
  const propertiesDesc = Object.entries(schema.schema.properties)
    .map(([key, prop]) => {
      let desc = `  "${key}" (${prop.type})`;
      if (prop.description) desc += `: ${prop.description}`;
      if (prop.enum) desc += `. Allowed values: ${prop.enum.map(v => `"${v}"`).join(', ')}`;
      if (prop.type === 'array' && prop.items) {
        desc += `. Items: { type: "${prop.items.type}"${prop.items.description ? `, description: "${prop.items.description}"` : ''} }`;
      }
      if (prop.type === 'object' && prop.properties) {
        const nestedFields = Object.entries(prop.properties)
          .map(([k, v]) => `"${k}": ${v.type}`)
          .join(', ');
        desc += `. Fields: { ${nestedFields} }`;
      }
      return desc;
    })
    .join('\n');

  const requiredFields = schema.schema.required?.length
    ? `\nRequired fields: ${schema.schema.required.join(', ')}`
    : '';

  return [
    `You are a structured data extraction assistant.`,
    schema.description ? `Task: ${schema.description}` : '',
    `You MUST respond with a valid JSON object matching this schema:`,
    `{`,
    propertiesDesc,
    `}`,
    requiredFields,
    ``,
    `IMPORTANT: Respond ONLY with the JSON object. No markdown, no explanation, no code fences.`,
    `The response must be valid JSON that can be parsed directly.`
  ].filter(Boolean).join('\n');
}

export async function extractStructured<T = Record<string, unknown>>(args: {
  messages: RequestMessage[];
  schema: JsonSchemaDefinition;
  signal?: AbortSignal;
}): Promise<StructuredExtractionResult<T>> {
  const config = await loadChatConfig();
  const { provider, providerName } = resolveProvider(config);

  const schemaPrompt = buildJsonSystemPrompt(args.schema);

  const messagesWithSystem: RequestMessage[] = [
    { role: 'system', content: schemaPrompt },
    ...args.messages.filter((m) => m.role !== 'system')
  ];

  const bodyBase: Record<string, unknown> = {
    model: provider.model,
    stream: false,
    messages: toRequestMessages(messagesWithSystem, provider.model)
  };

  const isLocalMode = config.llm?.backend_mode === 'local' && isElectron();
  const supportsNativeJson =
    !isLocalMode &&
    (/\bgpt-4o\b|\bgpt-4\.1\b|\bclaude-3\b|\bgemini\b|\bo1\b|\bo3\b|\bo4\b/i.test(provider.model || '') ||
     providerName === 'openrouter');

  if (supportsNativeJson) {
    try {
      const result = await completeAssistantReply({
        messages: messagesWithSystem,
        signal: args.signal
      });

      if (result.content) {
        const extracted = extractJsonFromResponse<T>(result.content);
        if (extracted.parsed) return extracted;
      }
    } catch {
      // Fall through to prompt-based approach
    }
  }

  const result = await completeAssistantReply({
    messages: messagesWithSystem,
    signal: args.signal
  });

  return extractJsonFromResponse<T>(result.content);
}

export function validateStructuredOutput<T = Record<string, unknown>>(
  data: unknown,
  schema: JsonSchemaDefinition
): { valid: true; data: T } | { valid: false; errors: string[] } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, errors: ['Root must be a JSON object'] };
  }

  const errors: string[] = [];
  const obj = data as Record<string, unknown>;
  const required = schema.schema.required || [];

  for (const field of required) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  for (const [key, propSchema] of Object.entries(schema.schema.properties)) {
    if (!(key in obj)) continue;
    const value = obj[key];
    const typeError = checkType(value, propSchema, key);
    if (typeError) errors.push(typeError);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: data as T };
}

function checkType(value: unknown, prop: JsonSchemaProperty, path: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') return `"${path}" must be a string`;
      if (prop.enum && !prop.enum.includes(value)) {
        return `"${path}" must be one of: ${prop.enum.join(', ')}`;
      }
      return null;
    case 'number':
      if (typeof value !== 'number') return `"${path}" must be a number`;
      return null;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return `"${path}" must be an integer`;
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') return `"${path}" must be a boolean`;
      return null;
    case 'array':
      if (!Array.isArray(value)) return `"${path}" must be an array`;
      if (prop.items) {
        for (let i = 0; i < value.length; i++) {
          const err = checkType(value[i], prop.items, `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `"${path}" must be an object`;
      }
      if (prop.properties) {
        const nested = value as Record<string, unknown>;
        for (const [k, subSchema] of Object.entries(prop.properties)) {
          if (k in nested) {
            const err = checkType(nested[k], subSchema, `${path}.${k}`);
            if (err) return err;
          }
        }
      }
      return null;
    default:
      return null;
  }
}

export async function extractStructuredWithRetry<T = Record<string, unknown>>(args: {
  messages: RequestMessage[];
  schema: JsonSchemaDefinition;
  signal?: AbortSignal;
  maxRetries?: number;
}): Promise<StructuredExtractionResult<T>> {
  const maxRetries = Math.min(Math.max(args.maxRetries ?? 1, 0), 3);
  let lastResult: StructuredExtractionResult<T> = {
    data: null,
    raw: '',
    parsed: false,
    error: 'No attempts made'
  };

  let currentMessages = [...args.messages];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await extractStructured<T>({
      messages: currentMessages,
      schema: args.schema,
      signal: args.signal
    });
    lastResult = result;

    if (!result.parsed || !result.data) {
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: result.raw || '[no response]' },
        { role: 'user', content: 'Your previous response was not valid JSON. Please respond with ONLY the JSON object, no markdown or explanation.' }
      ];
      continue;
    }

    const validation = validateStructuredOutput<T>(result.data, args.schema);
    if (validation.valid) {
      return { ...result, data: validation.data };
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: result.raw },
      { role: 'user', content: `The JSON had validation errors: ${validation.errors.join('; ')}. Please fix and return the corrected JSON object only.` }
    ];
  }

  return lastResult;
}

export async function completeStructuredOutput<T>(
  args: {
    messages: RequestMessage[];
    schema: Record<string, unknown>;
    signal?: AbortSignal;
  },
  config?: AppConfig
): Promise<T | null> {
  const cfg = config || await loadChatConfig();
  const route = resolveProvider(cfg);
  const { provider } = route;
  const apiKey = provider.api_key || '';
  const body = {
    model: provider.model,
    stream: false,
    messages: toRequestMessages(args.messages, provider.model),
    response_format: { type: 'json_schema', json_schema: args.schema }
  };
  if (isElectron()) {
    const payload = await invokeProviderCompletion(route, apiKey, body);
    const content = firstCompletionMessage(payload).content;
    return content ? tryParseJsonValue<T>(content) : null;
  }
  try {
    const response = await fetchProviderCompletion(provider, apiKey, body);
    const content = response?.choices?.[0]?.message?.content;
    return content ? tryParseJsonValue<T>(content) : null;
  } catch {
    return null;
  }
}
