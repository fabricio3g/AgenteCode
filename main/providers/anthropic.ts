import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { normalizeBaseUrl, safeParseJson } from './helpers.ts';

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

export class AnthropicProvider extends BaseProvider {
  name = 'anthropic';
  label = 'Anthropic';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    if (!providerName && !baseUrl) return false;
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name.includes('anthropic') || name.includes('claude') ||
      url.includes('anthropic.com') || url.includes('claude.ai') ||
      name === 'claude';
  }

  createClient(apiKey, baseUrl) {
    const clientKey = `${apiKey || ''}::${normalizeBaseUrl(baseUrl) || 'https://api.anthropic.com'}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new Anthropic({
        apiKey,
        ...(normalizeBaseUrl(baseUrl) ? { baseURL: normalizeBaseUrl(baseUrl) } : {})
      }));
    }
    return this._clients.get(clientKey);
  }

  _convertTools(tools) {
    if (!tools?.length) return undefined;
    return tools.map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} }
      };
    });
  }

  _buildMessages(messages) {
    const systemMessages = [];
    const chatMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push({ type: 'text', text: msg.content });
      } else if (msg.role === 'tool') {
        const lastAssistant = findLastAssistantBlock(chatMessages);
        if (lastAssistant) {
          const toolUseBlocks = lastAssistant.content.filter(b => b.type === 'tool_use');
          const matchingTool = toolUseBlocks.find(b => b.id === msg.tool_call_id);
          if (matchingTool) {
            chatMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
              }]
            });
          }
        } else {
          chatMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.tool_call_id || msg.name || '',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            }]
          });
        }
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls?.length) {
          const content = [];
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

  async *streamChat({ apiKey, baseUrl, model, messages, max_tokens, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const { system, messages: chatMessages } = this._buildMessages(messages);
    const anthropicTools = this._convertTools(tools);
    const maxTokens = max_tokens || 4096;

    const toolCallAccumulator = new Map();

    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: chatMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
      ...this._thinkingBody(reasoning, maxTokens),
      ...params
    }, { signal });

    let currentToolIndex = -1;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          currentToolIndex = event.index;
          toolCallAccumulator.set(currentToolIndex, {
            id: block.id || '',
            name: block.name || '',
            arguments: ''
          });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { content: delta.text ?? '', reasoning: '' };
        } else if (delta.type === 'thinking_delta') {
          yield { content: '', reasoning: delta.thinking ?? '' };
        } else if (delta.type === 'input_json_delta') {
          const tc = toolCallAccumulator.get(currentToolIndex);
          if (tc) {
            tc.arguments += delta.partial_json || '';
            yield {
              content: '',
              reasoning: '',
              toolCallDelta: {
                index: currentToolIndex,
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments
              }
            };
          }
        }
      }
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, max_tokens, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const { system, messages: chatMessages } = this._buildMessages(messages);
    const anthropicTools = this._convertTools(tools);
    const maxTokens = max_tokens || 4096;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: chatMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
      ...this._thinkingBody(reasoning, maxTokens),
      ...params
    }, { signal });

    const contentBlocks = response?.content || [];
    let content = '';
    let thinkingContent = '';
    const toolCalls = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') content += block.text;
      if (block.type === 'thinking') thinkingContent += block.thinking;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input
        });
      }
    }

    return {
      content,
      reasoning: thinkingContent,
      usage: response?.usage ? {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      } : null,
      toolCalls: toolCalls.length ? toolCalls : null
    };
  }

  /**
   * Anthropic thinking:
   * - Adaptive (`type: 'adaptive'` + `output_config.effort`) is recommended on
   *   Claude 4.6 and required on 4.7+ (manual budget_tokens is rejected).
   * - Legacy manual (`type: 'enabled'` + budget_tokens) remains for older models
   *   when the UI still sends level `enabled`.
   */
  async getReasoningCapabilities(): Promise<ReasoningCapabilities> {
    return {
      supported: true,
      levels: [...ANTHROPIC_LEVELS] as ReasoningCapabilities['levels'],
      paramShape: 'anthropic_thinking',
      source: 'sdk'
    };
  }

  /**
   * Map UI level → Anthropic Messages body.
   * - off / omit → no thinking param (provider default)
   * - disabled → thinking off
   * - enabled → legacy manual budget (Claude ≤4.5 / 4.6 compat)
   * - low|medium|high|max → adaptive + output_config.effort
   */
  _thinkingBody(reasoning?: ReasoningRequest, maxTokens = 4096): Record<string, unknown> {
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

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    return { ...body, ...this._thinkingBody(reasoning, (body.max_tokens as number) || 4096) };
  }

  /** Exported for unit tests via mapAnthropicThinkingBody */
  mapThinkingBody(reasoning?: ReasoningRequest, maxTokens = 4096): Record<string, unknown> {
    return this._thinkingBody(reasoning, maxTokens);
  }

  async fetchModels(apiKey, baseUrl) {
    const client = this.createClient(apiKey, baseUrl);
    try {
      const response = await client.models.list();
      const list = response?.data ?? [];
      return list.map(m => m.id).filter(Boolean).sort();
    } catch {
      return [];
    }
  }

  async fetchModelMetadata(_apiKey, _baseUrl, modelId) {
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
}

function findLastAssistantBlock(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      return msg;
    }
  }
  return null;
}

/** Exported for unit tests */
export function mapAnthropicThinkingBody(
  reasoning?: ReasoningRequest,
  maxTokens = 4096
): Record<string, unknown> {
  return new AnthropicProvider()._thinkingBody(reasoning, maxTokens);
}
