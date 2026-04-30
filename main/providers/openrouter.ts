import OpenAI from 'openai';
import { BaseProvider } from './base.ts';
import { normalizeBaseUrl, safeParseJson } from './helpers.ts';

export class OpenRouterProvider extends BaseProvider {
  name = 'openrouter';
  label = 'OpenRouter';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'openrouter' || url.includes('openrouter.ai');
  }

  createClient(apiKey, baseUrl) {
    const clientKey = `${apiKey || ''}::${normalizeBaseUrl(baseUrl)}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new OpenAI({
        apiKey: apiKey || 'not-needed',
        baseURL: normalizeBaseUrl(baseUrl) || 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://chatea.app',
          'X-Title': 'Chatea LM'
        }
      }));
    }
    return this._clients.get(clientKey);
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);

    const stream = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...params,
      stream: true
    }, { signal });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta || {};
      const content = delta.content;
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      const toolCallDeltas = delta.tool_calls;

      if (content || reasoning || toolCallDeltas) {
        yield {
          content: content ?? '',
          reasoning: reasoning ?? '',
          ...(toolCallDeltas ? {
            toolCallDeltas: toolCallDeltas.map(tc => ({
              index: tc.index ?? 0,
              id: tc.id ?? undefined,
              name: tc.function?.name ?? undefined,
              arguments: tc.function?.arguments ?? undefined
            }))
          } : {})
        };
      }
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, tools, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined)
    );

    const response = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...cleanParams,
      stream: false
    }, { signal });

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
    const client = this.createClient(apiKey, 'https://openrouter.ai/api/v1');
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
      const client = this.createClient(apiKey, 'https://openrouter.ai/api/v1');
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
