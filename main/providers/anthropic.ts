import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.ts';
import { normalizeBaseUrl, safeParseJson } from './helpers.ts';

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

  async *streamChat({ apiKey, baseUrl, model, messages, max_tokens, tools, signal, ...params }) {
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

  async completeChat({ apiKey, baseUrl, model, messages, max_tokens, tools, signal, ...params }) {
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
      ...params
    }, { signal });

    const contentBlocks = response?.content || [];
    let content = '';
    let reasoning = '';
    const toolCalls = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') content += block.text;
      if (block.type === 'thinking') reasoning += block.thinking;
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
      reasoning,
      usage: response?.usage ? {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      } : null,
      toolCalls: toolCalls.length ? toolCalls : null
    };
  }

  async fetchModels(apiKey, _baseUrl) {
    const client = this.createClient(apiKey);
    try {
      const response = await client.models.list();
      const list = response?.data ?? [];
      return list.map(m => m.id).filter(Boolean).sort();
    } catch {
      return [];
    }
  }

  async fetchModelMetadata(apiKey, _baseUrl, modelId) {
    const KNOWN_CONTEXTS = {
      'claude-3-5-sonnet-20241022': 200_000,
      'claude-3-5-sonnet-20240620': 200_000,
      'claude-3-5-haiku-20241022': 200_000,
      'claude-3-5-haiku-20240307': 200_000,
      'claude-3-opus-20240229': 200_000,
      'claude-3-sonnet-20240229': 200_000,
      'claude-3-haiku-20240307': 200_000,
      'claude-2.1': 200_000,
      'claude-2.0': 200_000,
      'claude-instant-20230501': 100_000,
      'claude-instant-1.3': 100_000,
    };
    const contextWindow = KNOWN_CONTEXTS[modelId] ?? null;
    return contextWindow ? { context_window: contextWindow } : null;
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
