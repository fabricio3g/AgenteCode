// ── The OpenAI-family core ─────────────────────────────────────────────
// ONE streaming/non-streaming/model-catalog implementation parameterized by
// a Dialect descriptor. Where six provider classes used to drift apart,
// there is now exactly one place a delta is mapped, one place usage is
// normalized, one place an error is classified.

import OpenAI from 'openai';
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
const PASSTHROUGH_PARAMS = ['temperature', 'max_tokens', 'top_p', 'stop'] as const;

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const;

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

// ── The shared chunk mapper ────────────────────────────────────────────

/**
 * Map one OpenAI-shaped streaming choice onto chunks. Every sdk and
 * fetch-sse dialect flows through here — casing variants of the reasoning
 * field are absorbed once, for good.
 */
/**
 * The provider's own error payload travels next to the finish reason on some
 * routes (OpenRouter: `choices[0].error` with an HTTP-200 `"error"` finish).
 * Pulled out here so `mapOpenAiFinishReason` can report the real cause
 * instead of `unknown finish reason "error"`.
 */
function providerErrorDetail(choice: Record<string, unknown> | undefined, raw: unknown): string | undefined {
  const err = (choice as { error?: unknown } | undefined)?.error
    ?? (raw as { error?: unknown } | undefined)?.error;
  if (!err) return undefined;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const record = err as { message?: unknown; code?: unknown };
    const message = typeof record.message === 'string' ? record.message : '';
    const code = typeof record.code === 'string' || typeof record.code === 'number' ? String(record.code) : '';
    const joined = [code, message].filter(Boolean).join(': ');
    if (joined) return joined;
  }
  return undefined;
}

function choiceToChunks(
  choice: { delta?: Record<string, unknown>; finish_reason?: string | null } | undefined,
  chunkUsage?: unknown,
  mapUsage: (u: unknown) => TokenUsage | null = normalizeOpenAiUsage,
  rawChunk?: unknown
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

  const finish = mapOpenAiFinishReason(
    choice?.finish_reason,
    providerErrorDetail(choice as Record<string, unknown> | undefined, rawChunk ?? chunkUsage)
  );
  if (finish) chunks.push({ type: 'finish', reason: finish });

  return chunks;
}

export function buildBody(dialect: Dialect, params: StreamParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages.map(({ providerState, ...message }) => ({
      ...message,
      ...(dialect.id === 'openrouter' && (providerState as CompletionResult['providerState'])?.provider === 'openrouter'
        ? { reasoning_details: (providerState as NonNullable<CompletionResult['providerState']>).blocks } : {})
    })),
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.tool_choice !== undefined && dialect.id !== 'ollama' ? { tool_choice: params.tool_choice } : {}),
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

  const reasoningDetails = new Map<number, Record<string, any>>();
  try {
    for await (const chunk of stream) {
      if (params.signal?.aborted) break;
      if (dialect.id === 'openrouter') {
        for (const block of chunk.choices?.[0]?.delta?.reasoning_details || []) {
          const index = block.index ?? 0;
          const previous = reasoningDetails.get(index) || {};
          const next = { ...previous, ...block };
          for (const field of ['text', 'summary', 'data', 'signature']) {
            if (typeof block[field] === 'string') next[field] = (previous[field] || '') + block[field];
          }
          reasoningDetails.set(index, next);
        }
      }
      yield* choiceToChunks(chunk.choices?.[0], chunk.usage, normalizeOpenAiUsage, chunk);
    }
    if (reasoningDetails.size) yield { type: 'provider-state', state: { provider: 'openrouter', blocks: [...reasoningDetails.values()] } };
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
    const finishReason = mapOpenAiFinishReason(
      choice.finishReason ?? choice.finish_reason,
      providerErrorDetail(choice, response)
    ) ?? undefined;
    // An error finish is a failure, not an empty answer — returning it as one
    // mislabels provider outages as "Empty response" downstream.
    if (finishReason?.kind === 'error') throw new LlmStreamError(finishReason.failure);
    return {
      content: message.content || '',
      reasoning: reasoning ? String(reasoning) : '',
      ...(dialect.id === 'openrouter' && Array.isArray(message.reasoning_details)
        ? { providerState: { provider: 'openrouter', blocks: message.reasoning_details } } : {}),
      usage: normalizeOpenAiUsage(response?.usage),
      toolCalls: toolCallsFromOpenAi(message),
      finishReason: finishReason as FinishReason | undefined
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
    const finishReason = mapOpenAiFinishReason(
      choice.finishReason ?? choice.finish_reason,
      providerErrorDetail(choice, data)
    ) ?? undefined;
    if (finishReason?.kind === 'error') throw new LlmStreamError(finishReason.failure);
    return {
      content: message.content || '',
      reasoning: reasoning ? String(reasoning) : '',
      usage: preserveLocalUsage(data),
      toolCalls: toolCallsFromOpenAi(message),
      finishReason: finishReason as FinishReason | undefined
    };
  } catch (err: unknown) {
    if (err instanceof LlmStreamError) throw err;
    throw new LlmStreamError(classifyError(err));
  }
}

// ── Model catalog ──────────────────────────────────────────────────────

async function fetchModelsByTransport(dialect: Dialect, apiKey: string, baseUrl?: string): Promise<string[]> {
  try {
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

  // 2. Local models: report what the template the server will actually
  // render with grants. Embedded GGUF template first, then the same
  // sidecar/family/generic fallback that process-manager passes to
  // llama-server — so the UI can never disagree with rendering (the old
  // path read only the GGUF and wiped the user's level when a re-quant had
  // no template).
  if (dialect.id === 'local') {
    const LOCAL_UNKNOWN = { supported: false, levels: [], paramShape: 'local_enable_thinking', source: 'unknown' } as const;
    if (!modelPath) return LOCAL_UNKNOWN;
    try {
      const { readGgufMetadataFields } = await import('../runtime-config-resolver.ts');
      const { resolveEffectiveTemplate, detectTemplateThinkingSupport } = await import('../chat-templates.ts');
      const fields = readGgufMetadataFields(modelPath);
      const effective = resolveEffectiveTemplate({
        modelPath,
        fields,
        ggufTemplate: fields?.chat_template ?? null
      });
      const supportsThinking = detectTemplateThinkingSupport(effective.template);
      return {
        supported: supportsThinking,
        levels: supportsThinking ? ['off', 'on'] as ReasoningCapabilities['levels'] : [],
        paramShape: 'local_enable_thinking',
        // The UI treats any non-'unknown' source as trustworthy; the template
        // origin (embedded file, sidecar, or built-in fallback) is what the
        // support verdict is actually made from.
        source: 'metadata'
      };
    } catch {
      return LOCAL_UNKNOWN;
    }
  }

  // 3. Endpoint probing.
  try {
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
    'fetch-sse': streamFetchSse
  } as const;
  const completeTransports = {
    sdk: completeSdk,
    'fetch-sse': completeFetchSse
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
      // A positive read of the *effective* template (embedded, sidecar, or
      // fallback) is definitive. Anything else — unreadable file, no template
      // anywhere — means "unknown", not "no tools", so fall through to the
      // live probe instead of vetoing tools the model may well support.
      if (dialect.id === 'local' && args.modelPath) {
        return (async () => {
          try {
            const { readGgufMetadataFields } = await import('../runtime-config-resolver.ts');
            const { resolveEffectiveTemplate, detectTemplateToolSupport } = await import('../chat-templates.ts');
            const fields = readGgufMetadataFields(args.modelPath!);
            const effective = resolveEffectiveTemplate({
              modelPath: args.modelPath!,
              fields,
              ggufTemplate: fields?.chat_template ?? null
            });
            if (detectTemplateToolSupport(effective.template)) {
              return { supportsTools: true, source: 'gguf_metadata' };
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
