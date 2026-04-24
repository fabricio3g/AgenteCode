import { OpenRouter } from '@openrouter/sdk';
import { BaseProvider } from './base.js';
import { safeParseJson } from './helpers.js';

export class OpenRouterProvider extends BaseProvider {
  name = 'openrouter';
  label = 'OpenRouter';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'openrouter' || url.includes('openrouter.ai');
  }

  createClient(apiKey, _baseUrl) {
    const key = apiKey || '';
    if (!this._clients.has(key)) {
      this._clients.set(key, new OpenRouter({ apiKey }));
    }
    return this._clients.get(key);
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, ...params }) {
    const client = this.createClient(apiKey);
    const stream = await client.chat.send({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...params,
      stream: true
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta || {};
      const content = delta.content;
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (content || reasoning) {
        yield {
          content: content ?? '',
          reasoning: reasoning ?? ''
        };
      }
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, tools, ...params }) {
    const client = this.createClient(apiKey);
    const response = await client.chat.send({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...params,
      stream: false
    });

    const choice = response?.choices?.[0] || {};
    const message = choice.message || {};
    const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;

    return {
      content: message.content || '',
      reasoning: rawReasoning ? String(rawReasoning) : '',
      usage: response?.usage || null,
      toolCalls: message.tool_calls ? message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: safeParseJson(tc.function?.arguments) || tc.function?.arguments || ''
      })) : null
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
    try {
      const client = this.createClient(apiKey);
      const response = await client.models.list();
      const list = response?.data ?? [];
      const found = list.find(entry => String(entry?.id || '') === String(modelId));
      if (found?.context_length) {
        const result = { context_window: found.context_length };
        if (found.top_provider?.max_completion_tokens) {
          result.max_completion_tokens = found.top_provider.max_completion_tokens;
        }
        return result;
      }
    } catch {
      // fallback
    }
    return null;
  }
}
