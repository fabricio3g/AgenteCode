import OpenAI from 'openai';
import type { AppConfig, ChatMessage, ModelOption } from '$lib/types/chat';
import type { LocalModel } from '$lib/types/tauri';
import { getIndexedModels, getLocalModels } from '$lib/services/models';
import { ensureLocalRuntime, resolveLocalBaseUrl } from '$lib/services/runtime';
import { invoke, listen, isTauri } from '$lib/services/tauri';
import { loadAppConfig } from '$lib/utils/storage';

const _openaiClients = new Map<string, OpenAI>();

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

// Tool-capable model detection for OpenRouter.
// Many OpenRouter models don't support native function calling.
// Skip native tools and use simulated XML mode for those.
const TOOL_CAPABLE_PATTERNS = [
  /gpt-4[./o]/i, /gpt-5/i,
  /claude-3/i, /claude-sonnet-4/i, /claude-opus-4/i,
  /gemini-2\.5-pro/i, /gemini-3-pro/i, /gemini-3-flash/i,
  /llama-3\.3/i, /llama-4/i,
  /qwen2\.5/i, /qwen3/i,
  /deepseek-chat/i, /deepseek-r1/i,
  /o1/i, /o3/i, /o4/i
];
const TOOL_AVOID_PATTERNS = [
  /gemma-3/i,
  /gemini-2\.5-flash-lite/i,
  /mistral.*free/i,
  /mixtral.*free/i,
  /phi-3/i, /phi-4/i
];

export function supportsNativeTools(modelId: string, providerName: string): boolean {
  if (providerName !== 'openrouter') return true;
  const id = String(modelId || '');
  if (TOOL_AVOID_PATTERNS.some(p => p.test(id))) return false;
  if (TOOL_CAPABLE_PATTERNS.some(p => p.test(id))) return true;
  return false;
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

function toRequestMessages(messages: RequestMessage[], modelName?: string, hasMmproj?: boolean) {
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
}): Promise<void> {
  const config = await loadChatConfig();
  const baseUrl = await ensureLocalRuntime(config);
  const hasVisionModel = await hasLocalVisionModel(config);

  const response = await fetch(resolveLocalBaseUrl({
    llm: { local: { base_url: baseUrl } }
  } as AppConfig).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: args.signal,
    body: JSON.stringify({
      model: config.llm?.local?.model || config.llm?.providers?.[config.llm?.provider || 'openai']?.model || 'local-model',
      stream: true,
      messages: toRequestMessages(args.messages, config.llm?.local?.model, hasVisionModel),
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
        const delta = parsed?.choices?.[0]?.delta || {};
        const content = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (reasoning) args.onReasoning?.(String(reasoning));
        if (content) args.onChunk(String(content));
      } catch { /* skip */ }
    }
  }
  const trimmedTail = String(buffer || '').trim();
  if (trimmedTail.startsWith('data:')) {
    const payload = trimmedTail.slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta || {};
        const content = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (reasoning) args.onReasoning?.(String(reasoning));
        if (content) args.onChunk(String(content));
      } catch { /* skip */ }
    }
  }
}

export async function streamAssistantReply(args: {
  messages: RequestMessage[];
  signal?: AbortSignal;
  onChunk: (value: string) => void;
  onReasoning?: (value: string) => void;
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
    const delta = chunk.choices?.[0]?.delta || {};
    const content = (delta as any).content;
    const reasoning = (delta as any).reasoning_content ?? (delta as any).reasoning ?? (delta as any).thinking;
    if (reasoning) args.onReasoning?.(String(reasoning));
    if (content) args.onChunk(String(content));
  }
}

function readCompletionPayload(payload: any): CompletionResult {
  // Flat format from main-process providers: { content: "...", reasoning: "..." }
  if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
    return {
      content: payload.content,
      reasoning: String(payload.reasoning || '')
    };
  }
  // Raw OpenAI API format: { choices: [{ message: { content: "..." } }] }
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
        model: config.llm?.local?.model || config.llm?.providers?.[config.llm?.provider || 'openai']?.model || 'local-model',
        stream: false,
        messages: toRequestMessages(args.messages, config.llm?.local?.model, hasVisionModel),
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
    console.log('[chat-api] completeAssistantReply local result:', { content_len: result.content.length, model: config.llm?.local?.model });
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
    const payload = await invoke<any>('chat_complete', {
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
    console.log('[chat-api] completeAssistantReply IPC raw payload:', JSON.stringify(payload));
    const result = readCompletionPayload(payload);
    console.log('[chat-api] completeAssistantReply IPC result:', { content_len: result.content.length, model: provider.model });
    return result;
  }

  const client = getOpenAIClient(apiKey, provider.base_url || '');
  const response = await client.chat.completions.create({
    model: provider.model,
    stream: false,
    messages: toRequestMessages(args.messages) as any,
    ...genParams
  } as any);

  const message = response?.choices?.[0]?.message || {};
  const rawContent = message.content;
  const rawReasoning = (message as any).reasoning_content ?? (message as any).reasoning ?? (message as any).thinking;
  console.log('[chat-api] completeAssistantReply direct result:', { content_len: String(rawContent || '').length, model: provider.model });
  return {
    content: rawContent != null ? String(rawContent) : '',
    reasoning: rawReasoning != null ? String(rawReasoning) : ''
  };
}

function readCompletionWithTools(payload: any): CompletionResult {
  // Flat format from main-process providers: { content: "...", reasoning: "...", toolCalls: [...] }
  if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
    const toolCalls: NativeToolCall[] = (payload.toolCalls || []).map((tc: any) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
      name: String(tc.function?.name || ''),
      arguments: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
    })).filter((tc: NativeToolCall) => !!tc.name);
    return {
      content: payload.content,
      reasoning: String(payload.reasoning || ''),
      toolCalls: toolCalls.length ? toolCalls : undefined
    };
  }
  // Raw OpenAI API format: { choices: [{ message: { content: "...", tool_calls: [...] } }] }
  const message = payload?.choices?.[0]?.message || {};
  const toolCalls: NativeToolCall[] = (message.tool_calls || []).map((tc: any) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
    name: String(tc.function?.name || ''),
    arguments: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
  })).filter((tc: NativeToolCall) => !!tc.name);

  return {
    content: String(message.content || ''),
    reasoning: String((message as any).reasoning_content || (message as any).reasoning || (message as any).thinking || ''),
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
      const payload = await invoke<any>('chat_complete', {
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
      console.log('[chat-api] completeWithTools IPC raw payload:', JSON.stringify(payload));
      const result = readCompletionWithTools(payload);
      console.log('[chat-api] completeWithTools IPC result:', { content_len: result.content.length, has_tools: !!result.toolCalls?.length, model: provider.model });
      return result;
    } catch (err) {
      console.warn('[chat-api] completeWithTools IPC call failed:', err);
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
      tool_choice: 'auto' as any,
      ...genParams
    } as any);

    const message = response?.choices?.[0]?.message || {};
    const toolCalls: NativeToolCall[] = (message.tool_calls || []).map((tc: any) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
      name: String(tc.function?.name || ''),
      arguments: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
    })).filter((tc: NativeToolCall) => !!tc.name);

    console.log('[chat-api] completeWithTools direct result:', { content_len: String(message.content || '').length, has_tools: !!toolCalls.length, model: provider.model });
    return {
      content: String(message.content || ''),
      reasoning: String((message as any).reasoning_content || (message as any).reasoning || (message as any).thinking || ''),
      toolCalls: toolCalls.length ? toolCalls : undefined
    };
  } catch (err) {
    console.warn('[chat-api] completeWithTools direct call failed:', err);
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
    const payload = await invoke<any>('chat_complete', {
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
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return null;
    try { return JSON.parse(content) as T; } catch { return null; }
  }

  try {
    const client = getOpenAIClient(apiKey, provider.base_url || '');
    const response = await client.chat.completions.create({
      model: provider.model,
      stream: false,
      messages: toRequestMessages(args.messages, provider.model) as any,
      response_format: {
        type: 'json_schema',
        json_schema: args.schema as any,
      },
    } as any);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) return null;
    try { return JSON.parse(content) as T; } catch { return null; }
  } catch {
    return null;
  }
}
