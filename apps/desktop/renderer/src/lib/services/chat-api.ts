// Chat facade: discovery and transport orchestration live here; pure wire code lives in chat/.
import type { CompletionResult, RequestMessage, ToolDefinition } from './chat/types';
import { normalizeRuntimeUsage, readCompletionPayload } from './chat/completion';
import { toRequestMessages } from './chat/messages';
export type { ContentPart, RequestMessage, ToolParameterSchema, ToolDefinition, NativeToolCall, CompletionResult } from './chat/types';
export { normalizeRuntimeUsage, readCompletionWithTools } from './chat/completion';
export { toRequestMessages } from './chat/messages';
export { extractJsonFromResponse, type StructuredExtractionResult } from './chat/structured-response';

import { isVisionModel } from '$shared/model-capabilities';
import { activeLoadConfig } from '$shared/local-launch';
import { listedModels } from './listed-models';
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
import { defaultBaseUrl } from '$lib/utils/providers';
import { ModelListCache } from './model-list-cache';

const _openaiClients = new Map<string, OpenAI>();
const modelLists = new ModelListCache<ModelOption[]>();

function modelListRoute(config: AppConfig, apiKeyOverride?: string) {
  const { provider, providerName } = resolveProvider(config);
  const baseUrl = provider.base_url || defaultBaseUrl(providerName);
  const apiKey = apiKeyOverride ?? provider.api_key ?? '';
  return { provider, providerName, baseUrl, apiKey,
    key: JSON.stringify([providerName, baseUrl.replace(/\/+$/, ''), apiKey, !!provider.has_api_key, isElectron()]) };
}

export function cachedModels(config: AppConfig): ModelOption[] | undefined {
  return modelLists.peek(modelListRoute(config).key);
}

export function invalidateModels(): void { modelLists.clear(); }

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

export { reasoningRouteIdentity } from './reasoning-route';

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
  const mmprojPath = String(activeLoadConfig(config.llm?.local as Record<string, unknown> | undefined).mmproj_path || '').trim();
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
  const model = config.llm?.providers?.[providerName]?.model || '';
  // The core knows what the model takes; the name guess is the fallback.
  if (!isElectron() || !model) return isVisionModel(model);
  return invoke<boolean>('model_sees_images', { providerName, model }).catch(() => isVisionModel(model));
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
      // Only the address has a default. Sizing, threads, memory locking and
      // cache types stay unset unless someone chose them: a value here reads
      // as a choice and is passed to llama-server, which turns its own --fit
      // off (this used to pin a 4,096 context, CPU only and mlock).
      local: {
        base_url: config.llm?.local?.base_url || 'http://127.0.0.1:11435/v1',
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

export async function fetchModels(config?: AppConfig, apiKeyOverride?: string, force = false): Promise<ModelOption[]> {
  const resolvedConfig = config || (await loadChatConfig());
  const { provider, providerName, baseUrl, apiKey, key } = modelListRoute(resolvedConfig, apiKeyOverride);
  if (!baseUrl) return [];

  // Listing models needs a key. Calling without one throws in the main process
  // and logs a handler error on every startup, and the result is discarded here
  // anyway. Keyless local runtimes (llama.cpp, Ollama, LM Studio) still apply.
  const isLocalProvider = providerName === 'local'
    || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
  if (!apiKey && !provider.has_api_key && !isLocalProvider) return [];

  return modelLists.load(key, async () => {
    if (isElectron()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = invoke<unknown>('fetch_provider_models', {
          baseUrl,
          apiKey,
          providerName
        });
        const raw = await Promise.race([request, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Model discovery timed out')), 12_000);
        })]);
        // IPC errors must reach the picker; an empty successful list is authoritative.
        return listedModels(raw);
      } finally { clearTimeout(timer); }
    }
    const client = getOpenAIClient(apiKey, baseUrl);
    const response = await client.models.list({ timeout: 10_000, maxRetries: 0 });
    const list = response?.data;
    if (!Array.isArray(list)) throw new Error('Invalid provider model list');
    return list
      .map((m: { id: string }) => ({
        id: String(m.id || ''),
        name: String(m.id || 'Unnamed model'),
        source: 'api' as const
      }))
      .filter((entry: ModelOption) => !!entry.id);
  }, force);
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
  config?: AppConfig;
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
  reasoning?: ReasoningRequest;
  sampling?: RoleplaySampling;
  stop?: string[];
  /** Local sampler fields llama-server reads beyond the OpenAI body (min_p, DRY…). Main forwards them as `extra_params`. */
  extraParams?: Record<string, number | string>;
}): Promise<void> {
  const config = args.config ?? await loadChatConfig();
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
      ...(args.stop?.length ? { stop: args.stop } : {}),
      ...(args.extraParams && Object.keys(args.extraParams).length ? { extra_params: args.extraParams } : {})
    }
  }, args, true);
}

export async function streamAssistantReply(args: {
  config?: AppConfig;
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
  apiKey?: string;
  reasoningLevel?: ReasoningLevel | null;
  sampling?: RoleplaySampling;
  stop?: string[];
  /** Local-only sampler fields (see streamLocalReply). Ignored by cloud providers. */
  extraParams?: Record<string, number | string>;
}): Promise<void> {
  const config = args.config ?? await loadChatConfig();
  const reasoning = buildReasoningRequest(args.reasoningLevel);
  if (config.llm?.backend_mode === 'local' && isElectron()) {
    return streamLocalReply({ ...args, config, reasoning });
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
  config?: AppConfig;
  messages: RequestMessage[];
  signal?: AbortSignal;
  apiKey?: string;
  reasoningLevel?: ReasoningLevel | null;
  /**
   * When true (Search/Deep/Max research), do not apply the user/provider max_tokens
   * completion budget so long professional reports are not cut short.
   */
  omitMaxTokens?: boolean;
  /** A completion cap for this call alone (side calls such as summaries). Wins over the configured budget. */
  maxTokens?: number;
}): Promise<CompletionResult> {
  const config = args.config ?? await loadChatConfig();

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
        ...(args.maxTokens ? { max_tokens: args.maxTokens } : !omitMaxTokens && config.llm?.local?.max_tokens ? { max_tokens: config.llm.local.max_tokens } : {})
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
    ...(args.maxTokens ? { max_tokens: args.maxTokens } : !omitMaxTokens && provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
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
