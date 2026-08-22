// ── Anthropic adapter ──────────────────────────────────────────────────
// Anthropic's Messages wire genuinely differs (system as top-level blocks,
// tool_use/tool_result content blocks, thinking config), so it stays its
// own adapter — but it emits the same normalized StreamChunk protocol as
// every other provider, so consumers never branch on it.

import Anthropic from '@anthropic-ai/sdk';
import {
  LlmStreamError,
  classifyError,
  type CompletionResult,
  type FinishReason,
  type StreamChunk,
  type StreamParams,
  type TokenUsage
} from './protocol.ts';
import type { ReasoningCapabilities } from './base.ts';
import { normalizeBaseUrl, safeParseJson } from './helpers.ts';
import { probeToolSupport, type ToolProbeArgs } from './tool-probe.ts';

/** Adaptive effort levels (Claude 4.6+). Legacy `enabled` keeps budget_tokens for older models. */
const ANTHROPIC_LEVELS = ['off', 'low', 'medium', 'high', 'max', 'enabled', 'disabled'] as const;

const ANTHROPIC_EFFORT: Record<string, 'low' | 'medium' | 'high' | 'max'> = {
  low: 'low',
  minimal: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  xhigh: 'max',
  on: 'high'
};

const clients = new Map<string, Anthropic>();

function client(apiKey: string, baseUrl?: string): Anthropic {
  const normalized = normalizeBaseUrl(baseUrl) || 'https://api.anthropic.com';
  const key = `${apiKey || ''}::${normalized}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const created = new Anthropic({
    apiKey,
    ...(normalizeBaseUrl(baseUrl) ? { baseURL: normalizeBaseUrl(baseUrl) } : {})
  });
  clients.set(key, created);
  return created;
}

function convertTools(tools?: Array<Record<string, unknown>>) {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const fn = (t.function ?? t) as Record<string, any>;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} }
    };
  });
}

function findLastAssistantBlock(messages: Array<Record<string, any>>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) return msg;
  }
  return null;
}

function buildMessages(messages: Array<Record<string, any>>) {
  const systemMessages: Array<Record<string, unknown>> = [];
  const chatMessages: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push({ type: 'text', text: msg.content });
    } else if (msg.role === 'tool') {
      const lastAssistant = findLastAssistantBlock(chatMessages);
      if (lastAssistant) {
        const toolUseBlocks = lastAssistant.content.filter((b: Record<string, any>) => b.type === 'tool_use');
        const matchingTool = toolUseBlocks.find((b: Record<string, any>) => b.id === msg.tool_call_id);
        if (matchingTool) {
          chatMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            }]
          });
          continue;
        }
      }
      chatMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || msg.name || '',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }]
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        const content: Array<Record<string, unknown>> = [];
        const textContent = typeof msg.content === 'string' ? msg.content : '';
        if (textContent) content.push({ type: 'text', text: textContent });
        for (const tc of msg.tool_calls) {
          const args = typeof tc.function?.arguments === 'string'
            ? safeParseJson(tc.function.arguments) || {}
            : tc.function?.arguments || {};
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name || '',
            input: args
          });
        }
        chatMessages.push({ role: 'assistant', content });
      } else {
        chatMessages.push({
          role: 'assistant',
          content: typeof msg.content === 'string' ? msg.content : String(msg.content || '')
        });
      }
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return {
    system: systemMessages.length ? systemMessages : undefined,
    messages: chatMessages
  };
}

/**
 * Map UI level → Anthropic Messages body.
 * - off / omit → no thinking param (provider default)
 * - disabled → thinking off
 * - enabled → legacy manual budget (Claude ≤4.5 / 4.6 compat)
 * - low|medium|high|max → adaptive + output_config.effort
 */
export function mapThinkingBody(reasoning?: StreamParams['reasoning'], maxTokens = 4096): Record<string, unknown> {
  if (!reasoning || !reasoning.level || reasoning.level === 'off') return {};
  if (reasoning.level === 'disabled' || reasoning.level === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  if (reasoning.level === 'enabled') {
    const budget = Math.min(
      reasoning.budgetTokens ?? 10000,
      Math.max(1024, Math.floor(maxTokens * 0.75))
    );
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  const effort = ANTHROPIC_EFFORT[reasoning.level];
  if (!effort) return {};
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort }
  };
}

function mapStopReason(raw: string | undefined | null): FinishReason | null {
  if (!raw) return null;
  switch (raw) {
    case 'max_tokens': return { kind: 'max-tokens' };
    case 'tool_use': return { kind: 'tool-calls' };
    case 'stop_sequence':
    case 'end_turn':
    case 'stop': return { kind: 'stop' };
    default: return { kind: 'error', failure: { message: `unknown finish reason "${raw}"`, code: 'UNKNOWN' } };
  }
}

async function* stream(params: StreamParams): AsyncGenerator<StreamChunk> {
  const anthropic = client(params.apiKey, params.baseUrl);
  const { system, messages: chatMessages } = buildMessages(params.messages);
  const anthropicTools = convertTools(params.tools);
  const maxTokens = Number(params.max_tokens) || 4096;

  let eventStream: AsyncIterable<Record<string, any>>;
  try {
    eventStream = anthropic.messages.stream({
      model: params.model,
      max_tokens: maxTokens,
      messages: chatMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
      ...mapThinkingBody(params.reasoning, maxTokens),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.top_p != null ? { top_p: params.top_p } : {})
    } as never, { signal: params.signal }) as never;
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }

  // Tool-call identity arrives on content_block_start; argument fragments on
  // the deltas that follow. Unlike the old adapter, we forward FRAGMENTS and
  // let the consumer accumulate — one convention everywhere.
  const toolIds = new Map<number, { id: string; name: string }>();

  try {
    for await (const event of eventStream) {
      if (params.signal?.aborted) break;
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          toolIds.set(event.index, { id: block.id || '', name: block.name || '' });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          if (delta.text) yield { type: 'text-delta', text: delta.text ?? '' };
        } else if (delta.type === 'thinking_delta') {
          if (delta.thinking) yield { type: 'reasoning-delta', text: delta.thinking ?? '' };
        } else if (delta.type === 'input_json_delta') {
          const known = toolIds.get(event.index);
          yield {
            type: 'tool-call-delta',
            delta: {
              index: event.index,
              id: known?.id,
              name: known?.name,
              argumentsDelta: delta.partial_json || ''
            }
          };
        }
      } else if (event.type === 'message_delta') {
        // Anthropic parks the stop reason on the final message_delta event.
        const reason = (event.delta as { stop_reason?: string } | undefined)?.stop_reason;
        const finish = mapStopReason(reason);
        if (finish) yield { type: 'finish', reason: finish };
      }
    }
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function complete(params: StreamParams): Promise<CompletionResult> {
  const anthropic = client(params.apiKey, params.baseUrl);
  const { system, messages: chatMessages } = buildMessages(params.messages);
  const anthropicTools = convertTools(params.tools);
  const maxTokens = Number(params.max_tokens) || 4096;

  try {
    const response = await anthropic.messages.create({
      model: params.model,
      max_tokens: maxTokens,
      messages: chatMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
      ...mapThinkingBody(params.reasoning, maxTokens),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.top_p != null ? { top_p: params.top_p } : {})
    } as never, { signal: params.signal }) as Record<string, any>;

    const contentBlocks = response?.content || [];
    let content = '';
    let thinkingContent = '';
    const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') content += block.text;
      if (block.type === 'thinking') thinkingContent += block.thinking;
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      }
    }

    const usage: TokenUsage | null = response?.usage
      ? {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens
        }
      : null;

    return {
      content,
      reasoning: thinkingContent,
      usage,
      toolCalls: toolCalls.length ? toolCalls : null,
      finishReason: mapStopReason(response?.stop_reason) ?? undefined
    };
  } catch (err: unknown) {
    throw new LlmStreamError(classifyError(err));
  }
}

async function fetchModels(apiKey: string, baseUrl?: string): Promise<string[]> {
  try {
    const response = await client(apiKey, baseUrl).models.list();
    const list = response?.data ?? [];
    return list.map((m) => String(m.id || '')).filter(Boolean).sort();
  } catch {
    return [];
  }
}

async function fetchModelMetadata(_apiKey: string, _baseUrl: string | undefined, modelId: string): Promise<unknown> {
  // Claude 3+ and Claude 4/5 families use 200k context by default.
  const id = String(modelId || '').toLowerCase();
  if (/claude-(opus|sonnet|haiku)-[345]|claude-[345]/.test(id) || /claude-3/.test(id)) {
    return { context_window: 200_000 };
  }
  if (/claude-2|claude-instant/.test(id)) {
    return { context_window: id.includes('instant') ? 100_000 : 200_000 };
  }
  return null;
}

async function getReasoningCapabilities(): Promise<ReasoningCapabilities> {
  return {
    supported: true,
    levels: [...ANTHROPIC_LEVELS] as ReasoningCapabilities['levels'],
    paramShape: 'anthropic_thinking',
    source: 'sdk'
  };
}

export const anthropicProvider = {
  name: 'anthropic',
  label: 'Anthropic',
  stream,
  complete,
  fetchModels,
  fetchModelMetadata,
  getReasoningCapabilities,
  checkToolSupport(args: ToolProbeArgs) {
    return probeToolSupport(complete, args);
  }
};
