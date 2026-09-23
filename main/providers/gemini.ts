// ── Gemini adapter ─────────────────────────────────────────────────────
// Google's generateContent wire differs enough to keep its own adapter —
// but it emits the same normalized StreamChunk protocol as everyone else.

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  LlmStreamError,
  classifyError,
  type CompletionResult,
  type FinishReason,
  type StreamChunk,
  type StreamParams
} from './protocol.ts';
import type { ReasoningCapabilities } from './base.ts';
import { numberOrNull, safeParseJson } from './helpers.ts';
import { probeToolSupport, type ToolProbeArgs } from './tool-probe.ts';

// Gemini 2.5 uses numeric thinkingBudget. 0 disables (where allowed); -1 is dynamic.
const GEMINI_BUDGET_BY_LEVEL: Record<string, number> = {
  off: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 24576
};

const GEMINI_LEVEL_ENUM: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH
};

function geminiApiBaseUrl(baseUrl: string | undefined): string {
  const value = String(baseUrl || 'https://generativelanguage.googleapis.com').trim().replace(/\/+$/, '');
  return value.endsWith('/v1beta') ? value : `${value}/v1beta`;
}

/** Gemini 3+ uses thinkingLevel; 2.5 uses thinkingBudget. */
function usesThinkingLevel(modelId?: string): boolean {
  const id = String(modelId || '').toLowerCase();
  return /gemini-([3-9]|[1-9]\d)/.test(id);
}

function isThinkingCapableModel(modelId?: string): boolean {
  const id = String(modelId || '').toLowerCase();
  if (!id.includes('gemini')) return false;
  if (/embedding|imagen|tts|aqa/.test(id)) return false;
  return /gemini-2\.5|gemini-3|gemini-2\.0-flash-thinking|thinking/.test(id) ||
    /gemini-([3-9]|[1-9]\d)/.test(id);
}

const clients = new Map<string, GoogleGenAI>();

function client(apiKey: string, baseUrl?: string): GoogleGenAI {
  const key = `${apiKey || ''}::${baseUrl || ''}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const created = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl: baseUrl.replace(/\/v1beta\/?$/, '') } } : {}) });
  clients.set(key, created);
  return created;
}

function convertTools(tools?: Array<Record<string, unknown>>) {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map((t) => {
      const fn = (t.function ?? t) as Record<string, any>;
      return {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} }
      };
    })
  }];
}

export function buildContents(messages: Array<Record<string, any>>) {
  let systemInstruction: string | null = null;
  const contents: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
    } else if (msg.role === 'tool') {
      const parent = messages.find((m) => m.tool_calls?.some((tc: Record<string, any>) => tc.id === msg.tool_call_id));
      const call = parent?.tool_calls?.find((tc: Record<string, any>) => tc.id === msg.tool_call_id);
      const part = { functionResponse: {
        id: msg.tool_call_id,
        name: msg.name || call?.function?.name || '',
        response: { result: safeParseJson(msg.content) ?? msg.content }
      } };
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.parts) && previous.parts.some((p) => p.functionResponse)) {
        previous.parts.push(part);
      } else contents.push({ role: 'user', parts: [part] });
    } else if (msg.role === 'assistant' && msg.providerState?.provider === 'gemini') {
      // Replay exact parts, including opaque thoughtSignature bytes, in order.
      contents.push({ role: 'model', parts: msg.providerState.blocks });
    } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
      contents.push({ role: 'model', parts: [
        ...(msg.content ? [{ text: msg.content }] : []),
        ...msg.tool_calls.map((tc: Record<string, any>) => ({ functionCall: {
          id: tc.id, name: tc.function?.name,
          args: safeParseJson(tc.function?.arguments) ?? {}
        } }))
      ] });
    } else {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content.map((part: Record<string, any>) => {
          if (part.type === 'text') return { text: part.text };
          if (part.type === 'image_url') {
            return {
              inlineData: {
                mimeType: 'image/jpeg',
                data: String(part.image_url?.url || '').replace(/^data:image\/\w+;base64,/, '')
              }
            };
          }
          return { text: '' };
        });
        contents.push({ role, parts });
      }
    }
  }

  return { systemInstruction, contents };
}

/**
 * Gemini 3+: thinkingLevel (+ includeThoughts).
 * Gemini 2.5: thinkingBudget (+ includeThoughts).
 */
export function mapThinkingConfig(reasoning?: StreamParams['reasoning'], modelId?: string): Record<string, unknown> {
  if (!reasoning || !reasoning.level) return {};

  const level = reasoning.level;
  const preferLevel = usesThinkingLevel(modelId);

  if (preferLevel) {
    if (level === 'off' || level === 'disabled' || level === 'none') {
      return { thinkingLevel: /pro/i.test(modelId || '') ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL, includeThoughts: true };
    }
    const enumLevel = GEMINI_LEVEL_ENUM[level] || GEMINI_LEVEL_ENUM.medium;
    return { thinkingLevel: enumLevel, includeThoughts: true };
  }

  if (level === 'off' || level === 'disabled' || level === 'none') {
    return /pro/i.test(modelId || '')
      ? { thinkingBudget: 128, includeThoughts: true }
      : { thinkingBudget: 0, includeThoughts: false };
  }
  const budget = GEMINI_BUDGET_BY_LEVEL[level];
  if (budget == null) return {};
  return { thinkingBudget: budget, includeThoughts: true };
}

function buildConfig(params: StreamParams) {
  const config: Record<string, unknown> = {};
  if (params.signal) config.abortSignal = params.signal;
  if (params.max_tokens) config.maxOutputTokens = params.max_tokens;
  if (params.temperature != null) config.temperature = params.temperature;
  if (params.top_p != null) config.topP = params.top_p;
  // Gemini rejects the request outright above five, so never send more than
  // the caller's own cap here.
  if (params.stop?.length) config.stopSequences = params.stop.slice(0, 5);

  const geminiTools = convertTools(params.tools);
  if (geminiTools?.length) config.tools = geminiTools;

  const thinkingConfig = mapThinkingConfig(params.reasoning, params.model);
  if (Object.keys(thinkingConfig).length) config.thinkingConfig = thinkingConfig;
  return config;
}

function extractTextAndThoughts(parts: Array<Record<string, unknown>> | undefined | null): { text: string; reasoning: string } {
  if (!parts?.length) return { text: '', reasoning: '' };
  let text = '';
  let reasoning = '';
  for (const part of parts) {
    const partText = typeof part.text === 'string' ? part.text : '';
    if (!partText) continue;
    if (part.thought === true) reasoning += partText;
    else text += partText;
  }
  return { text, reasoning };
}

function extractToolCalls(response: Record<string, any>): CompletionResult['toolCalls'] {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return null;
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const part of parts) {
    if (part.functionCall) {
      calls.push({
        id: part.functionCall.id || `call_${Math.random().toString(36).slice(2, 11)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? safeParseJson(part.functionCall.args) ?? {}
      });
    }
  }
  return calls.length ? calls : null;
}

function mapFinishReason(raw: string | undefined | null): FinishReason | null {
  if (!raw) return null;
  switch (raw) {
    case 'MAX_TOKENS': return { kind: 'max-tokens' };
    case 'STOP': return { kind: 'stop' };
    default:
      if (/safety|blocked|prohibited/i.test(raw)) {
        return { kind: 'error', failure: { message: `Gemini blocked the response (${raw})`, code: 'INVALID_REQUEST' } };
      }
      return { kind: 'error', failure: { message: `unknown finish reason "${raw}"`, code: 'UNKNOWN' } };
  }
}

async function* stream(params: StreamParams): AsyncGenerator<StreamChunk> {
  const genai = client(params.apiKey, params.baseUrl);
  const { systemInstruction, contents } = buildContents(params.messages);
  const config = { ...buildConfig(params), ...(systemInstruction ? { systemInstruction } : {}) };

  let responseStream: AsyncIterable<Record<string, any>>;
  try {
    responseStream = await genai.models.generateContentStream({
      model: params.model || 'gemini-2.0-flash',
      contents,
      config
    } as never) as never;
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }

  let toolCallIndex = 0;
  const responseParts: Array<Record<string, unknown>> = [];
  try {
    for await (const chunk of responseStream) {
      if (params.signal?.aborted) break;
      const candidate = chunk.candidates?.[0] as Record<string, unknown> | undefined;
      const parts = (candidate?.content?.parts || []) as Array<Record<string, unknown>>;
      responseParts.push(...parts);
      const { text, reasoning } = extractTextAndThoughts(parts);

      if (text) yield { type: 'text-delta', text };
      if (reasoning) yield { type: 'reasoning-delta', text: reasoning };

      // Gemini delivers complete function calls, not argument fragments.
      for (const part of parts) {
        if (!part.functionCall) continue;
        const call = part.functionCall as { id?: string; name?: string; args?: unknown };
        yield {
          type: 'tool-call-delta',
          delta: {
            index: toolCallIndex++,
            id: call.id || `call_${Math.random().toString(36).slice(2, 11)}`,
            name: call?.name,
            argumentsDelta: typeof call?.args === 'string' ? call.args : JSON.stringify(call?.args || {})
          }
        };
      }

      if (chunk.usageMetadata) {
        yield { type: 'usage', usage: {
          input_tokens: chunk.usageMetadata.promptTokenCount,
          output_tokens: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
          total_tokens: chunk.usageMetadata.totalTokenCount
        } };
      }

      const finish = mapFinishReason(candidate?.finishReason as string | undefined);
      if (finish) yield { type: 'finish', reason: finish };
    }
    if (responseParts.length) yield { type: 'provider-state', state: { provider: 'gemini', blocks: responseParts } };
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function complete(params: StreamParams): Promise<CompletionResult> {
  const genai = client(params.apiKey, params.baseUrl);
  const { systemInstruction, contents } = buildContents(params.messages);
  const config = { ...buildConfig(params), ...(systemInstruction ? { systemInstruction } : {}) };

  try {
    const response = await genai.models.generateContent({
      model: params.model || 'gemini-2.0-flash',
      contents,
      config
    } as never) as Record<string, any>;

    const parts = (response.candidates?.[0]?.content?.parts || []) as Array<Record<string, unknown>>;
    const { text, reasoning } = extractTextAndThoughts(parts);
    // Fallback: some SDK paths expose .text only for non-thought parts.
    const fallbackText = !text && typeof response.text === 'string' ? response.text : text;

    const usageMeta = response.usageMetadata as Record<string, number> | undefined;
    const finish = mapFinishReason(response.candidates?.[0]?.finishReason as string | undefined);

    return {
      content: fallbackText ?? '',
      reasoning,
      providerState: { provider: 'gemini', blocks: parts },
      usage: usageMeta
        ? {
            input_tokens: usageMeta.promptTokenCount,
            output_tokens: (usageMeta.candidatesTokenCount || 0) + (usageMeta.thoughtsTokenCount || 0),
            total_tokens: usageMeta.totalTokenCount
          }
        : null,
      toolCalls: extractToolCalls(response),
      finishReason: finish ?? undefined
    };
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function fetchModels(apiKey: string, baseUrl?: string): Promise<string[]> {
  try {
    const url = `${geminiApiBaseUrl(baseUrl)}/models?key=${encodeURIComponent(apiKey || '')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = data?.models ?? [];
    return list
      .filter((m: Record<string, unknown>) => (m.supportedGenerationMethods as string[] | undefined)?.includes('generateContent'))
      .map((m: Record<string, unknown>) => String(m.name || '').replace(/^models\//, '') || String(m.name || ''))
      .filter(Boolean)
      .sort();
  } catch {
    // Fallback via SDK if REST fails
    try {
      const pager = await client(apiKey).models.list();
      const ids: string[] = [];
      for await (const m of pager as AsyncIterable<Record<string, unknown>>) {
        const name = String(m.name || '').replace(/^models\//, '');
        if (name) ids.push(name);
      }
      return ids.sort();
    } catch {
      return [];
    }
  }
}

async function fetchModelMetadata(apiKey: string, baseUrl: string | undefined, modelId: string): Promise<unknown> {
  const normalizedModelId = String(modelId || '').startsWith('models/') ? String(modelId) : `models/${modelId}`;
  const url = `${geminiApiBaseUrl(baseUrl)}/${normalizedModelId}?key=${encodeURIComponent(apiKey || '')}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const contextWindow = numberOrNull(data?.inputTokenLimit ?? data?.input_token_limit);
    if (!contextWindow) return null;
    const maxCompletionTokens = numberOrNull(data?.outputTokenLimit ?? data?.output_token_limit);
    return {
      context_window: contextWindow,
      ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {})
    };
  } catch {
    return null;
  }
}

async function getReasoningCapabilities(_apiKey: string, _baseUrl: string | undefined, modelId?: string): Promise<ReasoningCapabilities> {
  if (!isThinkingCapableModel(modelId)) {
    return { supported: false, levels: [], paramShape: 'gemini_thinking_budget', source: 'sdk' };
  }
  return {
    supported: true,
    levels: usesThinkingLevel(modelId)
      ? (/pro/i.test(modelId || '') ? ['low', 'high'] : ['minimal', 'low', 'medium', 'high'])
      : /pro/i.test(modelId || '') ? ['low', 'medium', 'high'] : ['off', 'low', 'medium', 'high'],
    paramShape: 'gemini_thinking_budget',
    source: 'sdk'
  };
}

export const geminiProvider = {
  name: 'gemini',
  label: 'Google Gemini',
  stream,
  complete,
  fetchModels,
  fetchModelMetadata,
  getReasoningCapabilities,
  checkToolSupport(args: ToolProbeArgs) {
    return probeToolSupport(complete, args);
  }
};
