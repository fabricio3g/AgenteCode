// ── Provider bridge ────────────────────────────────────────────────────
// The only place the agent core meets the LLM world. Maps AgentMessage[] →
// OpenAI wire format, drives the existing provider registry (local llama.cpp
// + every cloud SDK), and folds the stream back into a single
// AssistantMessage. Failures come back as stopReason 'error', never throws.

import { accumulateToolCallDelta, finalizeToolCalls, resolveApiKey } from '../../chat-ipc.ts';
import { resolveProvider } from '../../providers/registry.ts';
import type { ReasoningRequest } from '../../providers/base.ts';
import type { AgentMessage, AssistantMessage, StreamFn, StreamRequest, ToolCall } from '../core/types.ts';

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
    let usage: AssistantMessage['usage'] = null;
    let aborted = false;

    const base: AssistantMessage = { role: 'assistant', content: '', ts: Date.now() };

    try {
      for await (const delta of provider.streamChat({
        apiKey,
        baseUrl: transport.baseUrl,
        model: transport.model,
        messages: wire,
        tools: request.tools.length ? request.tools : undefined,
        reasoning: transport.reasoning ?? undefined,
        signal: request.signal,
        ...Object.fromEntries(
          Object.entries({
            temperature: transport.params?.temperature,
            max_tokens: transport.params?.max_tokens,
            top_p: transport.params?.top_p
          }).filter(([, v]) => v !== undefined)
        )
      })) {
        if (request.signal.aborted) {
          aborted = true;
          break;
        }
        if (delta.usage) usage = delta.usage;
        if (delta.content) {
          content += delta.content;
          request.callbacks?.onTextDelta?.(delta.content);
        }
        if (delta.reasoning) {
          reasoning += delta.reasoning;
          request.callbacks?.onThinkingDelta?.(delta.reasoning);
        }
        for (const tc of delta.toolCallDeltas ?? []) {
          accumulateToolCallDelta(toolCallAccumulator, tc, { appendArguments: true });
        }
        if (delta.toolCallDelta) {
          accumulateToolCallDelta(toolCallAccumulator, delta.toolCallDelta, { appendArguments: false });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, content, reasoning: reasoning || undefined, stopReason: 'error', errorMessage: message, usage };
    }

    if (aborted) {
      return { ...base, content, reasoning: reasoning || undefined, stopReason: 'aborted', usage };
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

    return {
      ...base,
      content,
      reasoning: reasoning || undefined,
      usage,
      toolCalls: calls.length ? calls : undefined,
      stopReason: calls.length ? 'toolUse' : 'stop'
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
