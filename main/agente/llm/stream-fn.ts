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
// Coding turns write whole files in one tool call; 4096 cut them off mid-JSON.
export const AGENT_MAX_TOKENS_FLOOR = 16_384;

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

/**
 * AgentMessage[] → OpenAI-compatible wire messages (the convertToLlm choke point).
 *
 * Tool messages can only carry text on most providers, so images a tool
 * returned (browser screenshots) follow the batch of tool results as one user
 * message — after every result of the batch, so tool-call pairing stays valid.
 */
export function toWireMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  let pendingImages: Array<{ toolName: string; data: string; mimeType: string }> = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    const names = [...new Set(pendingImages.map((image) => image.toolName))].join(', ');
    wire.push({
      role: 'user',
      content: [
        { type: 'text', text: `[Images returned by ${names}]` },
        ...pendingImages.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))
      ]
    });
    pendingImages = [];
  };
  // Only the latest batch's images are sent: older screenshots would fill the
  // context with pictures of pages that have since changed.
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index;
  });
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool') flushImages();
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
      if (index > lastAssistant) {
        for (const image of message.images ?? []) pendingImages.push({ toolName: message.toolName, ...image });
      } else if (message.images?.length) {
        wire[wire.length - 1]!.content = `${message.content}\n(Earlier screenshot omitted — take a new one if you need to see the page.)`;
      }
    }
  }
  flushImages();
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

    const { calls, cutOff } = parseToolCalls(
      finalizeToolCalls(toolCallAccumulator) as Array<{ id: string; name: string; arguments: unknown }> | undefined
    );

    // An explicit finish reason wins; the tool-call heuristic is the
    // fallback for providers that never surface one. Arguments that are not
    // complete JSON mean the output was cut off even when the provider
    // reports a normal finish: treat that as a length stop, so the loop
    // refuses to run the half-written call.
    const stopFromFinish = finishToStopReason(finish);
    return {
      ...base,
      content,
      reasoning: reasoning || undefined,
      usage,
      toolCalls: calls.length ? calls : undefined,
      stopReason: cutOff ? 'length' : stopFromFinish ?? (calls.length ? 'toolUse' : 'stop')
    };
  };
}

/**
 * Assembled tool calls with parsed arguments. `cutOff` is true when any
 * call's arguments are not complete JSON — the output limit hit mid-call.
 */
export function parseToolCalls(raw: Array<{ id: string; name: string; arguments: unknown }> | undefined): { calls: ToolCall[]; cutOff: boolean } {
  let cutOff = false;
  const calls = (raw ?? [])
    .filter((call) => call.name)
    .map((call) => {
      const parsed = call.arguments && typeof call.arguments === 'object'
        ? (call.arguments as Record<string, unknown>)
        : safeParseObject(call.arguments);
      if (parsed === null) cutOff = true;
      return {
        id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.name,
        arguments: parsed ?? {}
      };
    });
  return { calls, cutOff };
}

/** Tool arguments as an object; null when the JSON is incomplete (the stream was cut). */
function safeParseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}
