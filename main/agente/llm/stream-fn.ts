// ── Provider bridge ────────────────────────────────────────────────────
// The only place the agent core meets the LLM world. Maps AgentMessage[] →
// OpenAI wire format, drives the normalized provider protocol (every
// adapter emits the same StreamChunk union), and folds the stream back into
// a single AssistantMessage. Failures come back as stopReason 'error' with
// a classified code — never throws past this boundary.

import { accumulateToolCallDelta, finalizeToolCalls, resolveApiKey } from '../../chat-ipc.ts';
import { resolveProvider } from '../../providers/registry.ts';
import { LlmStreamError, classifyError, type FinishReason } from '../../providers/protocol.ts';
import type { ReasoningRequest } from '../../providers/base.ts';
import type { AgentMessage, AssistantMessage, StreamFn, StreamRequest, StopReason, ToolCall, CoreTokenUsage } from '../../../shared/agent-core/types.ts';

export interface AgenteTransport {
  providerName: string;
  baseUrl: string;
  model: string;
  reasoning?: ReasoningRequest | null;
  params?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
  };
}

/**
 * Floor for agent runs when the user configured no cap. Provider defaults are
 * often tiny; a truncated tool-call JSON array is unrecoverable mid-stream.
 */
export const AGENT_MAX_TOKENS_FLOOR = 4096;

/** Provider TokenUsage → the agent core's snake_case vocabulary (CoreTokenUsage). */
function toCoreUsage(usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null | undefined): CoreTokenUsage | null {
  if (!usage) return null;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? prompt + completion);
  if (!prompt && !completion && !total) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/** Typed FinishReason → the loop's StopReason vocabulary. */
function finishToStopReason(finish: FinishReason | undefined): StopReason | null {
  if (!finish) return null;
  switch (finish.kind) {
    case 'stop': return 'stop';
    case 'max-tokens': return 'length';
    case 'tool-calls': return 'toolUse';
    case 'aborted': return 'aborted';
    case 'error': return 'error';
    default: return null;
  }
}

/** AgentMessage[] → OpenAI-compatible wire messages (the convertToLlm choke point). */
export function toWireMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const parts: Array<Record<string, unknown>> = [{ type: 'text', text: message.content }];
      for (const image of message.images ?? []) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.data}` }
        });
      }
      wire.push(message.images?.length ? { role: 'user', content: parts } : { role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: message.content || '' };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call: ToolCall) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
        }));
      }
      wire.push(entry);
    } else if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content
      });
    }
  }
  return wire;
}

export function createProviderStreamFn(transport: AgenteTransport): StreamFn {
  return async (request: StreamRequest): Promise<AssistantMessage> => {
    const provider = resolveProvider(transport.providerName, transport.baseUrl);
    const apiKey = resolveApiKey('', transport.baseUrl, transport.providerName);

    const wire = [
      { role: 'system', content: request.systemPrompt },
      ...toWireMessages(request.messages)
    ];

    const toolCallAccumulator = new Map();
    let content = '';
    let reasoning = '';
    let usage: CoreTokenUsage | null = null;
    let finish: FinishReason | undefined;
    let aborted = false;

    const base: AssistantMessage = { role: 'assistant', content: '', ts: Date.now() };

    try {
      for await (const chunk of provider.stream({
        apiKey,
        baseUrl: transport.baseUrl,
        model: transport.model,
        messages: wire,
        tools: request.tools.length ? request.tools : undefined,
        reasoning: transport.reasoning ?? undefined,
        signal: request.signal,
        temperature: transport.params?.temperature,
        max_tokens: transport.params?.max_tokens
          ?? (transport.providerName === 'local' ? undefined : AGENT_MAX_TOKENS_FLOOR),
        top_p: transport.params?.top_p
      })) {
        if (request.signal.aborted) {
          aborted = true;
          break;
        }
        switch (chunk.type) {
          case 'text-delta':
            content += chunk.text;
            request.callbacks?.onTextDelta?.(chunk.text);
            break;
          case 'reasoning-delta':
            reasoning += chunk.text;
            request.callbacks?.onThinkingDelta?.(chunk.text);
            break;
          case 'tool-call-delta':
            accumulateToolCallDelta(toolCallAccumulator, {
              index: chunk.delta.index,
              id: chunk.delta.id,
              name: chunk.delta.name,
              arguments: chunk.delta.argumentsDelta
            }, { appendArguments: true });
            break;
          case 'usage':
            usage = toCoreUsage(chunk.usage);
            break;
          case 'finish':
            finish = chunk.reason;
            break;
        }
      }
    } catch (err: unknown) {
      const failure = err instanceof LlmStreamError ? err.failure : classifyError(err);
      return {
        ...base,
        content,
        reasoning: reasoning || undefined,
        stopReason: 'error',
        errorMessage: failure.message,
        errorCode: failure.code,
        usage
      };
    }

    if (aborted) {
      return { ...base, content, reasoning: reasoning || undefined, stopReason: 'aborted', usage };
    }

    if (finish?.kind === 'error') {
      return {
        ...base,
        content,
        reasoning: reasoning || undefined,
        stopReason: 'error',
        errorMessage: finish.failure.message,
        errorCode: finish.failure.code,
        usage
      };
    }

    const toolCalls = finalizeToolCalls(toolCallAccumulator) as Array<{ id: string; name: string; arguments: unknown }> | undefined;
    const calls: ToolCall[] = (toolCalls ?? [])
      .filter((call) => call.name)
      .map((call) => ({
        id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.name,
        arguments:
          call.arguments && typeof call.arguments === 'object'
            ? (call.arguments as Record<string, unknown>)
            : safeParseObject(call.arguments)
      }));

    // An explicit finish reason wins; the tool-call heuristic is the
    // fallback for providers that never surface one.
    const stopFromFinish = finishToStopReason(finish);
    return {
      ...base,
      content,
      reasoning: reasoning || undefined,
      usage,
      toolCalls: calls.length ? calls : undefined,
      stopReason: stopFromFinish ?? (calls.length ? 'toolUse' : 'stop')
    };
  };
}

function safeParseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
