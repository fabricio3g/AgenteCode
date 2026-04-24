import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';

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

  createClient(apiKey, _baseUrl) {
    const key = apiKey || '';
    if (!this._clients.has(key)) {
      this._clients.set(key, new Anthropic({ apiKey }));
    }
    return this._clients.get(key);
  }

  _buildMessages(messages) {
    const systemMessages = [];
    const chatMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push({ type: 'text', text: msg.content });
      } else {
        chatMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return {
      system: systemMessages.length ? systemMessages : undefined,
      messages: chatMessages
    };
  }

  async *streamChat({ apiKey, baseUrl, model, messages, max_tokens, ...params }) {
    const client = this.createClient(apiKey);
    const { system, messages: chatMessages } = this._buildMessages(messages);

    const maxTokens = max_tokens || 4096;

    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: chatMessages,
      ...(system ? { system } : {}),
      ...params
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { content: delta.text ?? '', reasoning: '' };
        } else if (delta.type === 'thinking_delta') {
          yield { content: '', reasoning: delta.thinking ?? '' };
        }
      }
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, max_tokens, ...params }) {
    const client = this.createClient(apiKey);
    const { system, messages: chatMessages } = this._buildMessages(messages);

    const maxTokens = max_tokens || 4096;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: chatMessages,
      ...(system ? { system } : {}),
      ...params
    });

    const contentBlocks = response?.content || [];
    let content = '';
    let reasoning = '';
    for (const block of contentBlocks) {
      if (block.type === 'text') content += block.text;
      if (block.type === 'thinking') reasoning += block.thinking;
    }

    return {
      content,
      reasoning,
      usage: response?.usage ? {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      } : null,
      toolCalls: null
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
