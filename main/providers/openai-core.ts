// ── The OpenAI-family core ─────────────────────────────────────────────
// ONE streaming/non-streaming/model-catalog implementation parameterized by
// a Dialect descriptor. Where six provider classes used to drift apart,
// there is now exactly one place a delta is mapped, one place usage is
// normalized, one place an error is classified.

import OpenAI from 'openai';
import { Mistral } from '@mistralai/mistralai';
import type { ReasoningCapabilities } from './base.ts';
import {
  LlmStreamError,
  classifyError,
  mapOpenAiFinishReason,
  type CompletionResult,
  type FinishReason,
  type StreamChunk,
  type StreamParams,
  type TokenUsage
} from './protocol.ts';
import type { Dialect } from './dialects.ts';
import { numberOrNull, safeParseJson } from './helpers.ts';
import { probeToolSupport, type ToolProbeArgs } from './tool-probe.ts';

/** Known request extras passed through to the wire, in one place. */
const PASSTHROUGH_PARAMS = ['temperature', 'max_tokens', 'top_p'] as const;

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const;
const MISTRAL_PROBE_LEVELS = ['off', 'none', 'high'] as const;

const clients = new Map<string, { client: unknown }>();

function sdkClient(dialect: Dialect, apiKey: string, baseUrl?: string): OpenAI {
  const normalized = dialect.normalizeBaseUrl
    ? dialect.normalizeBaseUrl(baseUrl)
    : (String(baseUrl || '').trim().replace(/\/+$/, '') || dialect.defaultBaseUrl);
  const key = `${dialect.id}::${apiKey || ''}::${normalized}`;
  const cached = clients.get(key);
  if (cached) return cached.client as OpenAI;
  const client = new OpenAI({
    apiKey: apiKey || 'not-needed',
    baseURL: normalized,
    ...(dialect.headers ? { defaultHeaders: dialect.headers(apiKey) } : {})
  });
  clients.set(key, { client });
  return client;
}

function mistralClient(dialect: Dialect, apiKey: string, baseUrl?: string): Mistral {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  const key = `${dialect.id}::${apiKey || ''}::${normalized}`;
  const cached = clients.get(key);
  if (cached) return cached.client as Mistral;
  const client = new Mistral({
    apiKey: apiKey || '',
    ...(normalized ? { serverURL: normalized } : {})
  });
  clients.set(key, { client });
  return client;
}

// ── Usage normalization ────────────────────────────────────────────────

/** Canonical usage from the OpenAI wire shape. */
function normalizeOpenAiUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, number>;
  const input = Number(record.prompt_tokens ?? 0);
  const output = Number(record.completion_tokens ?? 0);
  const total = Number(record.total_tokens ?? input + output);
  if (!input && !output && !total) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

/** Local runtimes report richer raw usage (+timings); pass it through untouched. */
function preserveLocalUsage(parsed: Record<string, unknown> | null | undefined): TokenUsage | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const timings = parsed.timings;
  if (!Object.keys(usage).length && !timings) return null;
  return { ...usage, ...(timings ? { timings } : {}) } as TokenUsage;
}

// ── Mistral helpers ────────────────────────────────────────────────────

/** Mistral content arrives as parts or a plain string; split thinking out. */
function extractMistralContentParts(content: unknown): { text: string; reasoning: string } {
  if (content == null) return { text: '', reasoning: '' };
  if (typeof content === 'string') return { text: content, reasoning: '' };
  if (!Array.isArray(content)) return { text: String(content), reasoning: '' };

  let text = '';
  let reasoning = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    const type = String(p.type || '').toLowerCase();
    const value = typeof p.text === 'string'
      ? p.text
      : typeof p.content === 'string'
        ? p.content
        : typeof p.thinking === 'string'
          ? p.thinking
          : '';
    if (type === 'thinking' || type === 'reasoning' || p.thinking === true) {
      reasoning += value;
    } else if (type === 'text' || type === 'output_text' || !type) {
      text += value;
    }
  }
  return { text, reasoning };
}

interface MistralSplit {
  systemMessage?: string;
  messages: Array<Record<string, unknown>>;
}

function splitMistralMessages(messages: Array<Record<string, unknown>>): MistralSplit {
  const system: string[] = [];
  const chat: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === 'system') system.push(String(msg.content ?? ''));
    else chat.push({ role: msg.role, content: msg.content });
  }
  return {
    systemMessage: system.length ? system.join('\n') : undefined,
    messages: chat
  };
}

function buildMistralRequest(dialect: Dialect, params: StreamParams, stream: boolean): Record<string, unknown> {
  const { systemMessage, messages } = splitMistralMessages(params.messages);
  return {
    model: params.model,
    messages,
    ...(systemMessage ? { systemMessage } : {}),
    ...(params.max_tokens ? { maxTokens: params.max_tokens } : {}),
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.top_p != null ? { topP: params.top_p } : {}),
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...dialect.reasoningBody?.(params.reasoning?.level ?? undefined, params.model),
    stream
  };
}

// ── The shared chunk mapper ────────────────────────────────────────────

/**
 * Map one OpenAI-shaped streaming choice onto chunks. Every sdk and
 * fetch-sse dialect flows through here — casing variants of the reasoning
 * field are absorbed once, for good.
 */
function choiceToChunks(
  choice: { delta?: Record<string, unknown>; finish_reason?: string | null } | undefined,
  chunkUsage?: unknown,
  mapUsage: (u: unknown) => TokenUsage | null = normalizeOpenAiUsage
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const delta = choice?.delta ?? {};

  const content = delta.content;
  if (content) chunks.push({ type: 'text-delta', text: String(content) });

  const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (reasoning) chunks.push({ type: 'reasoning-delta', text: String(reasoning) });

  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    toolCalls.forEach((tc, i) => {
      const call = tc as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
      chunks.push({
        type: 'tool-call-delta',
        delta: {
          index: call.index ?? i,
          id: call.id ?? undefined,
          name: call.function?.name ?? undefined,
          argumentsDelta: call.function?.arguments ?? ''
        }
      });
    });
  }

  const usage = mapUsage(chunkUsage);
  if (usage) chunks.push({ type: 'usage', usage });

  const finish = mapOpenAiFinishReason(choice?.finish_reason);
  if (finish) chunks.push({ type: 'finish', reason: finish });

  return chunks;
}

function buildBody(dialect: Dialect, params: StreamParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.tool_choice !== undefined ? { tool_choice: params.tool_choice } : {}),
    ...dialect.reasoningBody?.(params.reasoning?.level ?? undefined, params.model),
    ...(stream && dialect.streamUsage ? { stream_options: { include_usage: true } } : {}),
    stream
  };
  for (const key of PASSTHROUGH_PARAMS) {
    const value = params[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

// ── Streaming transports ───────────────────────────────────────────────

async function* streamSdk(dialect: Dialect, params: StreamParams): AsyncGenerator<StreamChunk> {
  const client = sdkClient(dialect, params.apiKey, params.baseUrl);
  let stream: AsyncIterable<Record<string, any>>;
  try {
    stream = await client.chat.completions.create(
      buildBody(dialect, params, true) as Parameters<typeof client.chat.completions.create>[0],
      { signal: params.signal }
    );
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }

  try {
    for await (const chunk of stream) {
      if (params.signal?.aborted) break;
      yield* choiceToChunks(chunk.choices?.[0], chunk.usage);
    }
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function* streamFetchSse(dialect: Dialect, params: StreamParams): AsyncGenerator<StreamChunk> {
  const base = dialect.normalizeBaseUrl
    ? dialect.normalizeBaseUrl(params.baseUrl)
    : String(params.baseUrl || '').trim().replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const mapUsage = dialect.id === 'local' ? preserveLocalUsage : normalizeOpenAiUsage;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {})
      },
      signal: params.signal,
      body: JSON.stringify(buildBody(dialect, params, true))
    });
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LlmStreamError(classifyError(new Error(detail || `HTTP ${response.status}`)));
  }

  const reader = response.body?.getReader();
  if (!reader) throw new LlmStreamError({ message: 'No response stream available', code: 'TRANSPORT' });

  const decoder = new TextDecoder();
  let buffer = '';
  try {
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
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // skip malformed lines
        }
        if (params.signal?.aborted) break;
        yield* choiceToChunks(parsed?.choices?.[0], parsed, mapUsage);
      }
    }
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function* streamMistral(dialect: Dialect, params: StreamParams): AsyncGenerator<StreamChunk> {
  const client = mistralClient(dialect, params.apiKey, params.baseUrl);
  let stream: AsyncIterable<Record<string, any>>;
  try {
    stream = await client.chat.stream(
      buildMistralRequest(dialect, params, true) as never,
      { signal: params.signal }
    );
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }

  try {
    for await (const chunk of stream) {
      if (params.signal?.aborted) break;
      const choice = chunk?.data?.choices?.[0];
      const delta = choice?.delta ?? {};
      const extracted = extractMistralContentParts(delta.content);

      if (extracted.text) yield { type: 'text-delta', text: extracted.text };
      if (extracted.reasoning) yield { type: 'reasoning-delta', text: extracted.reasoning };

      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i] as Record<string, any>;
          yield {
            type: 'tool-call-delta',
            delta: {
              index: tc.index ?? i,
              id: tc.id ?? undefined,
              name: tc.function?.name ?? undefined,
              argumentsDelta: tc.function?.arguments ?? ''
            }
          };
        }
      }

      const finish = mapOpenAiFinishReason(choice?.finish_reason);
      if (finish) yield { type: 'finish', reason: finish };
    }
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

// ── Non-streaming transports ───────────────────────────────────────────

function toolCallsFromOpenAi(message: Record<string, any>): CompletionResult['toolCalls'] {
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return null;
  return calls.map((tc: Record<string, any>) => ({
    id: String(tc.id ?? ''),
    name: String(tc.function?.name ?? ''),
    arguments: safeParseJson(tc.function?.arguments) ?? tc.function?.arguments ?? ''
  }));
}

async function completeSdk(dialect: Dialect, params: StreamParams): Promise<CompletionResult> {
  const client = sdkClient(dialect, params.apiKey, params.baseUrl);
  try {
    const response = await client.chat.completions.create(
      buildBody(dialect, params, false) as Parameters<typeof client.chat.completions.create>[0],
      { signal: params.signal }
    ) as Record<string, any>;
    const choice = response?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
    return {
      content: message.content || '',
      reasoning: reasoning ? String(reasoning) : '',
      usage: normalizeOpenAiUsage(response?.usage),
      toolCalls: toolCallsFromOpenAi(message),
      finishReason: (mapOpenAiFinishReason(choice.finish_reason) ?? undefined) as FinishReason | undefined
    };
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function completeFetchSse(dialect: Dialect, params: StreamParams): Promise<CompletionResult> {
  const base = dialect.normalizeBaseUrl
    ? dialect.normalizeBaseUrl(params.baseUrl)
    : String(params.baseUrl || '').trim().replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {})
      },
      signal: params.signal,
      body: JSON.stringify(buildBody(dialect, params, false))
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmStreamError(classifyError(new Error(detail || `HTTP ${response.status}`)));
    }
    const data = await response.json() as Record<string, any>;
    const choice = data?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
    return {
      content: message.content || '',
      reasoning: reasoning ? String(reasoning) : '',
      usage: preserveLocalUsage(data),
      toolCalls: toolCallsFromOpenAi(message),
      finishReason: (mapOpenAiFinishReason(choice.finish_reason) ?? undefined) as FinishReason | undefined
    };
  } catch (err: unknown) {
    if (err instanceof LlmStreamError) throw err;
    throw new LlmStreamError(classifyError(err));
  }
}

async function completeMistral(dialect: Dialect, params: StreamParams): Promise<CompletionResult> {
  const client = mistralClient(dialect, params.apiKey, params.baseUrl);
  try {
    const response = await client.chat.complete(
      buildMistralRequest(dialect, params, false) as never,
      { signal: params.signal }
    ) as Record<string, any>;
    const choice = response?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const extracted = extractMistralContentParts(message.content);
    const usageRecord = (response?.usage ?? {}) as Record<string, number>;
    const calls = message.toolCalls;
    return {
      content: extracted.text,
      reasoning: extracted.reasoning,
      usage: response?.usage
        ? {
            input_tokens: Number(usageRecord.promptTokens ?? 0),
            output_tokens: Number(usageRecord.completionTokens ?? 0),
            total_tokens: Number(usageRecord.totalTokens ?? 0)
          }
        : null,
      toolCalls: Array.isArray(calls) && calls.length
        ? calls.map((tc: Record<string, any>) => ({
            id: String(tc.id ?? ''),
            name: String(tc.function?.name ?? ''),
            arguments: safeParseJson(tc.function?.arguments) ?? tc.function?.arguments ?? ''
          }))
        : null,
      finishReason: (mapOpenAiFinishReason(choice.finish_reason) ?? undefined) as FinishReason | undefined
    };
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

// ── Model catalog ──────────────────────────────────────────────────────

async function fetchModelsByTransport(dialect: Dialect, apiKey: string, baseUrl?: string): Promise<string[]> {
  try {
    if (dialect.transport === 'mistral') {
      const client = mistralClient(dialect, apiKey, baseUrl);
      const response = await client.models.list() as Record<string, any>;
      const list = response?.data ?? [];
      return list.map((m: Record<string, unknown>) => String(m.id || '')).filter(Boolean).sort();
    }
    if (dialect.transport === 'fetch-sse') {
      const base = dialect.normalizeBaseUrl
        ? dialect.normalizeBaseUrl(baseUrl)
        : String(baseUrl || '').trim().replace(/\/+$/, '');
      if (!base) return [];
      const res = await fetch(`${base}/models`, {
        headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(5000)
      }).catch(() => null);
      if (!res || !res.ok) return [];
      const data = await res.json().catch(() => ({}));
      const list = data?.data ?? data?.models ?? [];
      return list.map((m: Record<string, unknown>) => String(m.id || '')).filter(Boolean).sort();
    }
    const client = sdkClient(dialect, apiKey, baseUrl);
    const response = await client.models.list();
    const list = response?.data ?? [];
    return list.map((m) => String(m.id || '')).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** Union metadata parser across every catalog shape we have met so far. */
export function parseModelMetadataRecord(record: unknown): {
  context_window: number;
  max_completion_tokens?: number;
  prompt_cost_per_million?: number;
  completion_cost_per_million?: number;
} | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, any>;
  const topProvider = r.top_provider ?? r.topProvider ?? {};
  const contextWindow = numberOrNull(
    r.context_window ?? r.context_length ?? r.max_context_length
    ?? topProvider.context_length ?? topProvider.contextLength
    ?? r.inputTokenLimit ?? r.input_token_limit
  );
  if (!contextWindow) return null;

  const maxOut = numberOrNull(
    r.max_completion_tokens ?? r.max_output_tokens
    ?? r.outputTokenLimit ?? r.output_token_limit
    ?? topProvider.max_completion_tokens ?? topProvider.maxCompletionTokens
  );

  const promptPerToken = numberOrNull(r.pricing?.prompt ?? r.prompt_cost_per_token);
  const completionPerToken = numberOrNull(r.pricing?.completion ?? r.completion_cost_per_token);

  return {
    context_window: Math.floor(contextWindow),
    ...(maxOut ? { max_completion_tokens: Math.floor(maxOut) } : {}),
    ...(promptPerToken ? { prompt_cost_per_million: promptPerToken * 1_000_000 } : {}),
    ...(completionPerToken ? { completion_cost_per_million: completionPerToken * 1_000_000 } : {})
  };
}

async function fetchModelMetadataByTransport(
  dialect: Dialect,
  apiKey: string,
  baseUrl: string | undefined,
  modelId: string
): Promise<unknown> {
  try {
    if (dialect.transport === 'fetch-sse') {
      const base = dialect.normalizeBaseUrl
        ? dialect.normalizeBaseUrl(baseUrl)
        : String(baseUrl || '').trim().replace(/\/+$/, '');
      if (!base) return null;
      const res = await fetch(`${base}/models`, {
        headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(5000)
      }).catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => ({}));
      const list = data?.data ?? data?.models ?? [];
      const found = list.find((entry: Record<string, unknown>) => String(entry?.id || '') === String(modelId));
      return parseModelMetadataRecord(found);
    }

    if (dialect.transport === 'mistral') {
      const client = mistralClient(dialect, apiKey, baseUrl);
      const response = await client.models.list() as Record<string, any>;
      const list = response?.data ?? [];
      const found = list.find((m: Record<string, unknown>) => String(m?.id || '') === String(modelId));
      return parseModelMetadataRecord(found);
    }

    const client = sdkClient(dialect, apiKey, baseUrl);
    try {
      const detail = await client.models.retrieve(modelId);
      const parsed = parseModelMetadataRecord(detail);
      if (parsed) return parsed;
    } catch {
      // fall through to the list
    }
    const response = await client.models.list();
    const list = response?.data ?? [];
    const found = list.find((entry) => String(entry?.id || '') === String(modelId));
    return parseModelMetadataRecord(found);
  } catch {
    return null;
  }
}

// ── Capabilities ───────────────────────────────────────────────────────

function supportedParametersCaps(record: unknown, levels: readonly string[]): ReasoningCapabilities {
  const r = (record ?? {}) as Record<string, unknown>;
  const params = Array.isArray(r.supported_parameters) ? r.supported_parameters as string[] : [];
  const accepts = params.includes('reasoning_effort') || params.includes('reasoning')
    || !!(r.reasoning && typeof r.reasoning === 'object');
  return {
    supported: accepts,
    levels: accepts ? [...levels] as ReasoningCapabilities['levels'] : [],
    paramShape: 'openai_reasoning_effort',
    source: 'api'
  };
}

async function getReasoningCapabilities(
  dialect: Dialect,
  apiKey: string,
  baseUrl: string | undefined,
  modelId?: string,
  modelPath?: string
): Promise<ReasoningCapabilities> {
  const UNKNOWN = { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' } as const;

  // 1. Family/static knowledge wins — no network.
  const known = dialect.reasoningCapabilities?.(modelId, modelPath);
  if (known) return known;

  // 2. Local models declare thinking support in their GGUF metadata.
  if (dialect.id === 'local') {
    const LOCAL_UNKNOWN = { supported: false, levels: [], paramShape: 'local_disable_thinking', source: 'unknown' } as const;
    if (!modelPath) return LOCAL_UNKNOWN;
    try {
      const { getGgufMetadata } = await import('../model-manager.ts');
      const meta = await getGgufMetadata(modelPath);
      if (typeof meta?.chat_template_supports_thinking === 'boolean') {
        return {
          supported: meta.chat_template_supports_thinking,
          levels: meta.chat_template_supports_thinking ? ['off', 'on'] as ReasoningCapabilities['levels'] : [],
          paramShape: 'local_disable_thinking',
          source: 'metadata'
        };
      }
      return LOCAL_UNKNOWN;
    } catch {
      return LOCAL_UNKNOWN;
    }
  }

  // 3. Endpoint probing.
  try {
    if (dialect.transport === 'mistral') {
      const client = mistralClient(dialect, apiKey, baseUrl);
      const response = await client.models.list() as Record<string, any>;
      const list = response?.data ?? [];
      const found = list.find((m: Record<string, unknown>) => String(m?.id || '') === String(modelId)) as Record<string, unknown> | undefined;
      const supportsReasoning = !!(found?.reasoning || found?.supports_reasoning
        || (Array.isArray(found?.capabilities) && (found!.capabilities as string[]).includes('reasoning')));
      return supportsReasoning
        ? { supported: true, levels: [...MISTRAL_PROBE_LEVELS], paramShape: 'mistral_reasoning_effort', source: 'api' }
        : { supported: false, levels: [], paramShape: 'mistral_reasoning_effort', source: 'api' };
    }

    const client = sdkClient(dialect, apiKey, baseUrl);
    try {
      return supportedParametersCaps(await client.models.retrieve(modelId ?? ''), EFFORT_LEVELS);
    } catch {
      const response = await client.models.list();
      const list = response?.data ?? [];
      const found = list.find((entry) => String(entry?.id || '') === String(modelId));
      return supportedParametersCaps(found, EFFORT_LEVELS);
    }
  } catch {
    return { ...UNKNOWN };
  }
}

// ── Assembly ───────────────────────────────────────────────────────────

export interface ProviderObject {
  name: string;
  label: string;
  dialect: Dialect;
  stream(params: StreamParams): AsyncGenerator<StreamChunk>;
  complete(params: StreamParams): Promise<CompletionResult>;
  fetchModels(apiKey: string, baseUrl?: string): Promise<string[]>;
  fetchModelMetadata(apiKey: string, baseUrl: string | undefined, modelId: string): Promise<unknown>;
  getReasoningCapabilities(apiKey: string, baseUrl: string | undefined, modelId?: string, modelPath?: string): Promise<ReasoningCapabilities>;
  checkToolSupport(args: { baseUrl?: string; apiKey: string; model?: string; modelPath?: string; providerName?: string }): Promise<{ supportsTools: boolean; source: string }>;
}

export function createOpenAiProvider(dialect: Dialect): ProviderObject {
  const streamTransports = {
    sdk: streamSdk,
    'fetch-sse': streamFetchSse,
    mistral: streamMistral
  } as const;
  const completeTransports = {
    sdk: completeSdk,
    'fetch-sse': completeFetchSse,
    mistral: completeMistral
  } as const;

  const provider: ProviderObject = {
    name: dialect.id,
    label: dialect.label,
    dialect,
    async *stream(params: StreamParams): AsyncGenerator<StreamChunk> {
      if (params.signal?.aborted) return;
      yield* streamTransports[dialect.transport](dialect, params);
    },
    complete(params: StreamParams): Promise<CompletionResult> {
      return completeTransports[dialect.transport](dialect, params);
    },
    fetchModels(apiKey: string, baseUrl?: string) {
      return fetchModelsByTransport(dialect, apiKey, baseUrl);
    },
    fetchModelMetadata(apiKey: string, baseUrl: string | undefined, modelId: string) {
      return fetchModelMetadataByTransport(dialect, apiKey, baseUrl, modelId);
    },
    getReasoningCapabilities(apiKey: string, baseUrl: string | undefined, modelId?: string, modelPath?: string) {
      return getReasoningCapabilities(dialect, apiKey, baseUrl, modelId, modelPath);
    },
    checkToolSupport(args: ToolProbeArgs) {
      // Local models declare tool support in GGUF metadata — definitive when present.
      if (dialect.id === 'local' && args.modelPath) {
        return (async () => {
          try {
            const { getGgufMetadata } = await import('../model-manager.ts');
            const meta = await getGgufMetadata(args.modelPath!);
            if (typeof meta?.chat_template_uses_tools === 'boolean') {
              return { supportsTools: meta.chat_template_uses_tools, source: 'gguf_metadata' };
            }
          } catch {
            // fall through to the probe
          }
          return probeToolSupport(provider.complete, args);
        })();
      }
      return probeToolSupport(provider.complete, args);
    }
  };
  return provider;
}
