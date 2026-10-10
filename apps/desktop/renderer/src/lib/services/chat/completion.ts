/** Read provider response shapes and preserve local runtime usage. */
import type { CompletionResult, NativeToolCall } from './types';
type UnknownRecord = Record<string, unknown>;

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

function firstCompletionMessage(payload: UnknownRecord): UnknownRecord {
  const choices = Array.isArray(payload?.choices) ? payload.choices as UnknownRecord[] : [];
  return (choices[0]?.message as UnknownRecord | undefined) || {};
}

export function readCompletionPayload(payload: UnknownRecord): CompletionResult {
  const flat = typeof payload?.content === 'string';
  const message = flat ? payload : firstCompletionMessage(payload);
  const reasoning = flat ? message.reasoning : message.reasoning_content ?? message.reasoning ?? message.thinking;
  return {
    content: message.content != null ? String(message.content) : '',
    reasoning: reasoning != null ? String(reasoning) : '',
    usage: payload?.usage || null
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

