import OpenAI from 'openai';
import type { AppConfig, ChatMessage, ModelOption } from '$lib/types/chat';
import type { LocalModel } from '$lib/types/tauri';
import { getIndexedModels, getLocalModels } from '$lib/services/models';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { createBufferedStreamDispatcher } from '$lib/services/streaming';
import { invoke, listen, isTauri } from '$lib/services/tauri';
import { loadAppConfig } from '$lib/utils/storage';
import { toErrorMessage } from '$lib/utils/errors';

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
  const normalized = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
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
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {
    base_url: 'https://api.openai.com/v1',
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
  const providerName = config?.llm?.provider || 'openai';
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
  if (['openai', 'anthropic', 'gemini', 'groq', 'mistral'].includes(providerName)) {
    toolSupportCache.set(key, true);
    debugToolSupport(config, `[agent] supportsNativeTools | providerName=${providerName} | modelId=${modelId} | first-party -> true`);
    return true;
  }

  if (providerName === 'local') {
    debugToolSupport(config, `[agent] supportsNativeTools | providerName=local | modelId=${modelId} | uncached -> false`);
    return false;
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
  if (!isTauri()) return true;

  const config = await loadAppConfig();
  const { providerName, modelId, provider } = toolSupportIdentity(config);
  const key = toolSupportCacheKey(providerName, modelId);

  // Don't re-probe already-cached entries
  if (toolSupportCache.has(key)) return toolSupportCache.get(key)!;

  // First-party providers are known to support tools
  if (['openai', 'anthropic', 'gemini', 'groq', 'mistral'].includes(providerName)) {
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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  attachments?: Array<{ kind?: string; base64?: string; name?: string; ocrText?: string }>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
      required?: string[];
    };
  };
}

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls?: NativeToolCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    eval_count?: number;
    eval_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
  } | null;
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
export function isVisionModel(modelName: string): boolean {
  return /\b(vl|vision|llava|multimodal|gemma[\s-]?3|qwen[\s-]?3[\s._-]?[0-9]|qwen[\s-]?vl)\b|gpt-4o|gpt-4\.1|gemini|claude-3/i.test(modelName);
}

async function hasLocalVisionModel(config: AppConfig): Promise<boolean> {
  const mmprojPath = String(config.llm?.local?.mmproj_path || '').trim();
  if (!mmprojPath) return false;
  if (!isTauri()) return true;
  try {
    return await invoke<boolean>('path_exists', { path: mmprojPath });
  } catch {
    return false;
  }
}

export async function hasConfiguredVisionModel(config: AppConfig): Promise<boolean> {
  const backendMode = config.llm?.backend_mode || (isTauri() ? 'local' : 'api');
  if (backendMode === 'local') {
    return hasLocalVisionModel(config);
  }
  const providerName = config.llm?.provider || 'openai';
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
      base.content = (message.content || '') + ocrContext;
    }

    if (message.tool_calls) base.tool_calls = message.tool_calls;
    if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
    if (message.name) base.name = message.name;
    return base;
  });
}

export async function loadChatConfig(): Promise<AppConfig> {
  const config = await loadAppConfig();
  const next: AppConfig = {
    ...config,
    llm: {
      ...config.llm,
      provider: config.llm?.provider || 'openai',
      backend_mode: config.llm?.backend_mode || (isTauri() ? 'local' : 'api'),
      providers: {
        ...(config.llm?.providers || {}),
        openai: {
          base_url: 'https://api.openai.com/v1',
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
      workspace_mode: config.ui?.workspace_mode || 'modern',
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

  if (isTauri()) {
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

async function streamLocalReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
}): Promise<void> {
  const config = await loadChatConfig();
  const baseUrl = await ensureLocalRuntime(config);
  const hasVisionModel = await hasLocalVisionModel(config);
  const dispatcher = createBufferedStreamDispatcher({
    onContent: args.onChunk,
    onReasoning: args.onReasoning,
    delayMs: 55
  });

  const response = await fetch(resolveLocalBaseUrl({
    llm: { local: { base_url: baseUrl } }
  } as AppConfig).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: args.signal,
    body: JSON.stringify({
      model: resolveLocalModelName(config),
      stream: true,
      stream_options: { include_usage: true },
      messages: toRequestMessages(args.messages, resolveLocalModelName(config), hasVisionModel),
      ...(Number.isFinite(config.llm?.local?.temperature) ? { temperature: config.llm!.local!.temperature } : {}),
      ...(config.llm?.local?.max_tokens ? { max_tokens: config.llm.local.max_tokens } : {})
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'Local request failed');
    throw new Error(detail || `HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No local response stream available');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.usage) args.onUsage?.(parsed.usage);
        const delta = parsed?.choices?.[0]?.delta || {};
        const content = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (reasoning) dispatcher.pushReasoning(String(reasoning));
        if (content) dispatcher.pushContent(String(content));
      } catch { /* skip */ }
    }
  }
  const trimmedTail = String(buffer || '').trim();
  if (trimmedTail.startsWith('data:')) {
    const payload = trimmedTail.slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.usage) args.onUsage?.(parsed.usage);
        const delta = parsed?.choices?.[0]?.delta || {};
        const content = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (reasoning) dispatcher.pushReasoning(String(reasoning));
        if (content) dispatcher.pushContent(String(content));
      } catch { /* skip */ }
    }
  }
  dispatcher.flush();
}

export async function streamAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
  onUsage?: (usage: CompletionResult['usage']) => void;
  apiKey?: string;
}): Promise<void> {
  const config = await loadChatConfig();
  if (config.llm?.backend_mode === 'local' && isTauri()) {
    return streamLocalReply(args);
  }
  const { provider, providerName } = resolveProvider(config);
  const apiKey = (args.apiKey ?? provider.api_key) || '';

  if (isTauri()) {
    let streamId = '';
    let resolveStream: (() => void) | null = null;
    let rejectStream: ((error: Error) => void) | null = null;
    const streamPromise = new Promise<void>((resolve, reject) => {
      resolveStream = resolve;
      rejectStream = reject;
    });

    const off = await listen<ChatStreamEvent>('chat-stream-event', (event) => {
      if (!event || event.streamId !== streamId) return;

      if (event.type === 'delta') {
        if (event.reasoning) args.onReasoning?.(String(event.reasoning));
        if (event.content) args.onChunk(String(event.content));
        return;
      }

      if (event.type === 'done' || event.type === 'cancelled') {
        if (event.usage) args.onUsage?.(event.usage);
        resolveStream?.();
        return;
      }

      if (event.type === 'error') {
        rejectStream?.(new Error(event.error || 'Streaming request failed'));
      }
    });

    let abortListener: (() => void) | null = null;

    try {
      const started = await invoke<{ streamId: string }>('chat_stream_start', {
        baseUrl: provider.base_url,
        apiKey,
        providerName,
        body: {
          model: provider.model,
          stream: true,
          messages: toRequestMessages(args.messages, provider.model),
          ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
          ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
          ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
        }
      });

      streamId = started?.streamId || '';
      if (!streamId) throw new Error('Failed to start chat stream');

      if (args.signal) {
        abortListener = () => {
          void invoke('chat_stream_cancel', { streamId }).catch(() => {});
        };
        args.signal.addEventListener('abort', abortListener, { once: true });
      }

      await streamPromise;
      return;
    } finally {
      off();
      if (args.signal && abortListener) {
        args.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  // Non-Tauri path: use OpenAI SDK directly
  const client = getOpenAIClient(apiKey, provider.base_url || '');

  const stream = await client.chat.completions.create({
    model: provider.model,
    stream: true,
    messages: toRequestMessages(args.messages, provider.model) as any,
    ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
    ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
    ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {}),
  });

  for await (const chunk of stream) {
    const delta = (chunk.choices?.[0]?.delta || {}) as UnknownRecord;
    const content = delta.content;
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (reasoning) args.onReasoning?.(String(reasoning));
    if (content) args.onChunk(String(content));
  }
}

function readCompletionPayload(payload: UnknownRecord): CompletionResult {
  // Flat format from main-process providers: { content: "...", reasoning: "..." }
  if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
    return {
      content: payload.content,
      reasoning: String(payload.reasoning || ''),
      usage: payload.usage || null
    };
  }
  // Raw OpenAI API format: { choices: [{ message: { content: "..." } }] }
  const choices = Array.isArray(payload?.choices) ? payload.choices as UnknownRecord[] : [];
  const message = (choices[0]?.message as UnknownRecord | undefined) || {};
  const rawContent = message.content;
  const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
  return {
    content: rawContent != null ? String(rawContent) : '',
    reasoning: rawReasoning != null ? String(rawReasoning) : '',
    usage: payload?.usage || null
  };
}

export async function completeAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  apiKey?: string;
}): Promise<CompletionResult> {
  const config = await loadChatConfig();

  if (config.llm?.backend_mode === 'local' && isTauri()) {
    const baseUrl = await ensureLocalRuntime(config);
    const hasVisionModel = await hasLocalVisionModel(config);
    const response = await fetch(resolveLocalBaseUrl({
      llm: { local: { base_url: baseUrl } }
    } as AppConfig).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: args.signal,
      body: JSON.stringify({
        model: resolveLocalModelName(config),
        stream: false,
        messages: toRequestMessages(args.messages, resolveLocalModelName(config), hasVisionModel),
        ...(Number.isFinite(config.llm?.local?.temperature) ? { temperature: config.llm!.local!.temperature } : {}),
        ...(config.llm?.local?.max_tokens ? { max_tokens: config.llm.local.max_tokens } : {})
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'Local request failed');
      throw new Error(detail || `HTTP ${response.status}`);
    }

    const payload = await response.json();
    const result = readCompletionPayload(payload);
    result.usage = payload?.usage || result.usage || null;
    return result;
  }

  const { provider, providerName } = resolveProvider(config);
  const apiKey = (args.apiKey ?? provider.api_key) || '';

  const genParams = {
    ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
    ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
    ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
  };

  if (isTauri()) {
    const payload = await invoke<UnknownRecord>('chat_complete', {
      baseUrl: provider.base_url,
      apiKey,
      providerName,
      body: {
        model: provider.model,
        stream: false,
        messages: toRequestMessages(args.messages),
        ...genParams
      }
    });
    const result = readCompletionPayload(payload);
    result.usage = payload?.usage || result.usage || null;
    return result;
  }

  const client = getOpenAIClient(apiKey, provider.base_url || '');
  const response = await client.chat.completions.create({
    model: provider.model,
    stream: false,
    messages: toRequestMessages(args.messages) as any,
    ...genParams
  });

  const message = (response?.choices?.[0]?.message || {}) as unknown as UnknownRecord;
  const rawContent = message.content;
  const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
  return {
    content: rawContent != null ? String(rawContent) : '',
    reasoning: rawReasoning != null ? String(rawReasoning) : '',
    usage: response?.usage ? {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens
    } : null
  };
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

export function readCompletionWithTools(payload: UnknownRecord): CompletionResult {
  // Flat format from main-process providers: { content: "...", reasoning: "...", toolCalls: [...] }
  if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
    const toolCalls: NativeToolCall[] = (Array.isArray(payload.toolCalls) ? payload.toolCalls : []).map((tc: unknown) => {
      const call = (tc || {}) as UnknownRecord;
      const fn = (call.function as UnknownRecord | undefined) || {};
      return {
        id: String(call.id || `call_${Math.random().toString(36).slice(2, 9)}`),
        name: String(fn.name || call.name || ''),
        arguments: call.arguments && typeof call.arguments === 'object'
          ? call.arguments as Record<string, unknown>
          : tryParseJsonObject(fn.arguments || call.arguments || '{}')
      };
    }).filter((toolCall: NativeToolCall) => !!toolCall.name);
    return {
      content: payload.content,
      reasoning: String(payload.reasoning || ''),
      usage: payload.usage || null,
      toolCalls: toolCalls.length ? toolCalls : undefined
    };
  }
  // Raw OpenAI API format: { choices: [{ message: { content: "...", tool_calls: [...] } }] }
  const choices = Array.isArray(payload?.choices) ? payload.choices as UnknownRecord[] : [];
  const message = (choices[0]?.message as UnknownRecord | undefined) || {};
  const toolCalls: NativeToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((tc: unknown) => {
    const call = (tc || {}) as UnknownRecord;
    const fn = (call.function as UnknownRecord | undefined) || {};
    return {
      id: String(call.id || `call_${Math.random().toString(36).slice(2, 9)}`),
      name: String(fn.name || ''),
      arguments: tryParseJsonObject(fn.arguments || '{}')
    };
  }).filter((toolCall: NativeToolCall) => !!toolCall.name);

  return {
    content: String(message.content || ''),
    reasoning: String(message.reasoning_content || message.reasoning || message.thinking || ''),
    usage: payload?.usage || null,
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

  const isLocalMode = config.llm?.backend_mode === 'local' && isTauri();
  const supportsNativeJson =
    !isLocalMode &&
    (/\bgpt-4o\b|\bgpt-4\.1\b|\bclaude-3\b|\bgemini\b|\bo1\b|\bo3\b|\bo4\b/i.test(provider.model || '') ||
     providerName === 'openai' ||
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

export async function completeWithTools(args: {
  messages: RequestMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  apiKey?: string;
}): Promise<CompletionResult | null> {
  const config = await loadChatConfig();
  if (config.llm?.backend_mode === 'local' && isTauri()) return null;

  const { provider, providerName } = resolveProvider(config);
  if (!provider.base_url) return null;
  const apiKey = (args.apiKey ?? provider.api_key) || '';

  const genParams = {
    ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
    ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
    ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
  };

  if (isTauri()) {
    try {
      const payload = await invoke<UnknownRecord>('chat_complete', {
        baseUrl: provider.base_url,
        apiKey,
        providerName,
        body: {
          model: provider.model,
          stream: false,
          messages: toRequestMessages(args.messages, provider.model),
          tools: args.tools,
          tool_choice: 'auto',
          ...genParams
        }
      });
      const result = readCompletionWithTools(payload);
      return result;
    } catch (err: unknown) {
      console.warn('[chat-api] completeWithTools IPC call failed:', toErrorMessage(err));
      return null;
    }
  }

  try {
    const client = getOpenAIClient(apiKey, provider.base_url || '');
    const response = await client.chat.completions.create({
      model: provider.model,
      stream: false,
      messages: toRequestMessages(args.messages, provider.model) as any,
      tools: args.tools as any,
      tool_choice: 'auto',
      ...genParams
    });

    const message = (response?.choices?.[0]?.message || {}) as unknown as UnknownRecord;
    const toolCalls: NativeToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((tc: unknown) => {
      const call = (tc || {}) as UnknownRecord;
      const fn = (call.function as UnknownRecord | undefined) || {};
      return {
        id: String(call.id || `call_${Math.random().toString(36).slice(2, 9)}`),
        name: String(fn.name || ''),
        arguments: tryParseJsonObject(fn.arguments || '{}')
      };
    }).filter((toolCall: NativeToolCall) => !!toolCall.name);

    return {
      content: String(message.content || ''),
      reasoning: String(message.reasoning_content || message.reasoning || message.thinking || ''),
      toolCalls: toolCalls.length ? toolCalls : undefined
    };
  } catch (err: unknown) {
    console.warn('[chat-api] completeWithTools direct call failed:', toErrorMessage(err));
    return null;
  }
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
  const { providerName, provider } = resolveProvider(cfg);
  const apiKey = provider.api_key || '';

  if (isTauri()) {
    const payload = await invoke<UnknownRecord>('chat_complete', {
      baseUrl: provider.base_url,
      apiKey,
      providerName,
      body: {
        model: provider.model,
        stream: false,
        messages: toRequestMessages(args.messages, provider.model),
        response_format: {
          type: 'json_schema',
          json_schema: args.schema
        }
      }
    });
    const choices = Array.isArray(payload?.choices) ? payload.choices as UnknownRecord[] : [];
    const message = (choices[0]?.message || {}) as UnknownRecord;
    const content = message.content;
    if (!content) return null;
    return tryParseJsonValue<T>(content);
  }

  try {
    const client = getOpenAIClient(apiKey, provider.base_url || '');
    const response = await client.chat.completions.create({
      model: provider.model,
      stream: false,
      messages: toRequestMessages(args.messages, provider.model) as any,
      response_format: {
        type: 'json_schema',
        json_schema: args.schema,
      } as any,
    } as any);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) return null;
    return tryParseJsonValue<T>(content);
  } catch {
    return null;
  }
}
