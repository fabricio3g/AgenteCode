import type { AppConfig, ChatMessage, ModelOption } from '$lib/types/chat';
import type { LocalModel } from '$lib/types/tauri';
import { getIndexedModels, getLocalModels } from '$lib/services/models';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { invoke, listen, isTauri } from '$lib/services/tauri';
import { loadAppConfig } from '$lib/utils/storage';

function resolveProvider(config: AppConfig) {
  const providerName = config.llm?.provider || 'openai';
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {
    base_url: 'https://api.openai.com/v1',
    model: 'default-model'
  };
  console.log('[chat-api] resolveProvider:', { 
    providerName, 
    hasProvider: !!providers[providerName],
    hasApiKey: !!(provider as any).api_key,
    hasApiKeyFlag: !!(provider as any).has_api_key,
    availableProviders: Object.keys(providers)
  });
  return { providerName, provider };
}

function resolveChatUrl(baseUrl: string): string {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  if (!normalized) return 'https://api.openai.com/v1/chat/completions';
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function resolveModelsUrl(baseUrl: string): string {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  if (!normalized) return 'https://api.openai.com/v1/models';
  return normalized.endsWith('/models') ? normalized : `${normalized}/models`;
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
}

interface ChatStreamEvent {
  streamId: string;
  type: 'delta' | 'done' | 'error' | 'cancelled';
  content?: string;
  reasoning?: string;
  error?: string;
}

/** Returns true if model name suggests vision capability */
function isVisionModel(modelName: string): boolean {
  return /\b(vl|vision|llava|multimodal|gemma[\s-]?3|qwen[\s-]?3[\s._-]?[0-9]|qwen[\s-]?vl)\b|gpt-4o|gpt-4\.1|gemini|claude-3/i.test(modelName);
}

function toRequestMessages(messages: RequestMessage[], modelName?: string, hasMmproj?: boolean) {
  // Local mode: hasMmproj is explicitly passed (true/false) — only mmproj determines vision
  // API mode: hasMmproj is undefined — fall back to model name heuristic
  const visionCapable = hasMmproj !== undefined ? hasMmproj : isVisionModel(modelName || '');
  return messages.map((message) => {
    const base: Record<string, unknown> = { role: message.role };

    // Build multimodal content if user message has image attachments
    const imageAttachments = message.attachments?.filter(
      (a) => a.kind === 'image' && a.base64 && String(a.base64).startsWith('data:')
    ) || [];

    // Collect OCR text from all attachments (images + documents)
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

// Parse a single SSE data line and return delta content/reasoning.
// Handles `data: <json>` lines; returns null for non-data or [DONE] lines.
function parseSseLine(line: string): { content: string; reasoning: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const parsed = JSON.parse(payload);
    const delta = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message || {};
    // Explicitly guard against null values — String(null) = "null" which is wrong
    const rawContent = delta.content;
    const rawReasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    const content = rawContent != null ? String(rawContent) : '';
    const reasoning = rawReasoning != null ? String(rawReasoning) : '';
    if (!content && !reasoning) return null;
    return { content, reasoning };
  } catch {
    return null;
  }
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
          model: 'default-model',
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
      provider: config.search?.provider || 'auto',
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

export async function fetchModels(config?: AppConfig): Promise<ModelOption[]> {
  const resolvedConfig = config || (await loadChatConfig());
  if (resolvedConfig.llm?.backend_mode === 'local' && isTauri()) {
    try {
      const indexed = await getIndexedModels();
      if (indexed.length) {
        return indexed.map((entry) => ({
          id: entry.id,
          name: entry.name,
          source: 'local',
          path: entry.path,
          details: [entry.architecture, entry.size_label].filter(Boolean).join(' • ')
        }));
      }
    } catch {
      // fallback below
    }

    try {
      const localModels = await getLocalModels();
      return resolveLocalModels(localModels);
    } catch {
      return [];
    }
  }

  const { provider, providerName } = resolveProvider(resolvedConfig);
  if (!provider.base_url) return [];

  if (isTauri()) {
    try {
      const ids = await invoke<string[]>('fetch_provider_models', {
        baseUrl: provider.base_url,
        apiKey: provider.api_key,
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

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  const response = await fetch(resolveModelsUrl(provider.base_url), { headers });
  if (!response.ok) return [];
  const payload = await response.json();
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items.map((entry: any) => ({
    id: String(entry.id || ''),
    name: String(entry.id || entry.name || 'Unnamed model'),
    source: 'api'
  })).filter((entry: ModelOption) => !!entry.id);
}

async function streamLocalReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
}): Promise<void> {
  const config = await loadChatConfig();
  const baseUrl = await ensureLocalRuntime(config);

  const response = await fetch(resolveChatUrl(resolveLocalBaseUrl({
    llm: {
      local: {
        base_url: baseUrl
      }
    }
  })), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    signal: args.signal,
    body: JSON.stringify({
      model: config.llm?.local?.model || config.llm?.providers?.[config.llm?.provider || 'openai']?.model || 'local-model',
      stream: true,
      messages: toRequestMessages(args.messages, config.llm?.local?.model, !!(config.llm?.local?.mmproj_path)),
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
      const delta = parseSseLine(line);
      if (!delta) continue;
      if (delta.reasoning) args.onReasoning?.(delta.reasoning);
      if (delta.content) args.onChunk(delta.content);
    }
  }
  // Flush any remaining buffered line
  const tailLocal = parseSseLine(buffer);
  if (tailLocal?.reasoning) args.onReasoning?.(tailLocal.reasoning);
  if (tailLocal?.content) args.onChunk(tailLocal.content);
}

export async function streamAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
}): Promise<void> {
  const config = await loadChatConfig();
  if (config.llm?.backend_mode === 'local' && isTauri()) {
    return streamLocalReply(args);
  }
  const { provider, providerName } = resolveProvider(config);

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
        apiKey: provider.api_key,
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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  const response = await fetch(resolveChatUrl(provider.base_url), {
    method: 'POST',
    headers,
    signal: args.signal,
    body: JSON.stringify({
      model: provider.model,
      stream: true,
      messages: toRequestMessages(args.messages, provider.model),
      ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
      ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
      ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'Request failed');
    throw new Error(detail || `HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream available');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const delta = parseSseLine(line);
      if (!delta) continue;
      if (delta.reasoning) args.onReasoning?.(delta.reasoning);
      if (delta.content) args.onChunk(delta.content);
    }
  }
  // Flush any remaining buffered line
  const tail = parseSseLine(buffer);
  if (tail?.reasoning) args.onReasoning?.(tail.reasoning);
  if (tail?.content) args.onChunk(tail.content);
}

function readCompletionPayload(payload: any): CompletionResult {
  const message = payload?.choices?.[0]?.message || {};
  const rawContent = message.content;
  const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
  return {
    content: rawContent != null ? String(rawContent) : '',
    reasoning: rawReasoning != null ? String(rawReasoning) : ''
  };
}

export async function completeAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
}): Promise<CompletionResult> {
  const config = await loadChatConfig();

  if (config.llm?.backend_mode === 'local' && isTauri()) {
    const baseUrl = await ensureLocalRuntime(config);
    const response = await fetch(resolveChatUrl(resolveLocalBaseUrl({
      llm: {
        local: {
          base_url: baseUrl
        }
      }
    })), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: args.signal,
      body: JSON.stringify({
        model: config.llm?.local?.model || config.llm?.providers?.[config.llm?.provider || 'openai']?.model || 'local-model',
        stream: false,
        messages: toRequestMessages(args.messages)
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'Local request failed');
      throw new Error(detail || `HTTP ${response.status}`);
    }

    const payload = await response.json();
    return readCompletionPayload(payload);
  }

  const { provider, providerName } = resolveProvider(config);

  if (isTauri()) {
    const payload = await invoke<any>('chat_complete', {
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      providerName,
      body: {
        model: provider.model,
        stream: false,
        messages: toRequestMessages(args.messages)
      }
    });
    return readCompletionPayload(payload);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  const response = await fetch(resolveChatUrl(provider.base_url), {
    method: 'POST',
    headers,
    signal: args.signal,
    body: JSON.stringify({
      model: provider.model,
      stream: false,
      messages: toRequestMessages(args.messages)
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'Request failed');
    throw new Error(detail || `HTTP ${response.status}`);
  }

  const payload = await response.json();
  return readCompletionPayload(payload);
}

function readCompletionWithTools(payload: any): CompletionResult {
  const message = payload?.choices?.[0]?.message || {};
  const toolCalls: NativeToolCall[] = (message.tool_calls || []).map((tc: any) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
    name: String(tc.function?.name || ''),
    arguments: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
  })).filter((tc: NativeToolCall) => !!tc.name);

  return {
    content: String(message.content || ''),
    reasoning: String(message.reasoning_content || message.reasoning || message.thinking || ''),
    toolCalls: toolCalls.length ? toolCalls : undefined
  };
}

// Complete a request with native tool definitions (OpenAI tool_calls format).
// Only works for API mode — returns null for local mode so caller can fall back to XML.
export async function completeWithTools(args: {
  messages: RequestMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): Promise<CompletionResult | null> {
  const config = await loadChatConfig();
  if (config.llm?.backend_mode === 'local' && isTauri()) return null;

  const { provider, providerName } = resolveProvider(config);
  if (!provider.base_url) return null;

  if (isTauri()) {
    try {
      const payload = await invoke<any>('chat_complete', {
        baseUrl: provider.base_url,
        apiKey: provider.api_key,
        providerName,
        body: {
          model: provider.model,
          stream: false,
          messages: toRequestMessages(args.messages, provider.model),
          tools: args.tools,
          tool_choice: 'auto'
        }
      });
      return readCompletionWithTools(payload);
    } catch {
      return null;
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  let response: Response;
  try {
    response = await fetch(resolveChatUrl(provider.base_url), {
      method: 'POST',
      headers,
      signal: args.signal,
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        messages: toRequestMessages(args.messages, provider.model),
        tools: args.tools,
        tool_choice: 'auto'
      })
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  const payload = await response.json();
  return readCompletionWithTools(payload);
}
