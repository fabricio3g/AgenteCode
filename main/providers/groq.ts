import Groq from 'groq-sdk';
import { BaseProvider } from './base.ts';
import { numberOrNull, safeParseJson } from './helpers.ts';

export class GroqProvider extends BaseProvider {
  name = 'groq';
  label = 'Groq';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'groq' || url.includes('api.groq.com');
  }

  createClient(apiKey, _baseUrl) {
    const key = apiKey || '';
    if (!this._clients.has(key)) {
      this._clients.set(key, new Groq({ apiKey }));
    }
    return this._clients.get(key);
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, ...params }) {
    const client = this.createClient(apiKey);
    const stream = await client.chat.completions.create({
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
    const response = await client.chat.completions.create({
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
      usage: response?.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens
      } : null,
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
    const client = this.createClient(apiKey);

    const parseMetadata = (record) => {
      if (!record || typeof record !== 'object') return null;
      const contextWindow = numberOrNull(
        record.context_window ?? record.context_length ?? record.max_context_length
      );
      if (!contextWindow) return null;
      const maxCompletionTokens = numberOrNull(record.max_completion_tokens ?? record.max_output_tokens);
      return {
        context_window: contextWindow,
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {})
      };
    };

    try {
      const detail = await client.models.retrieve(modelId);
      const parsed = parseMetadata(detail);
      if (parsed) return parsed;
    } catch {
      // fall through
    }

    try {
      const response = await client.models.list();
      const list = response?.data ?? [];
      const found = list.find(entry => String(entry?.id || '') === String(modelId));
      return parseMetadata(found || null);
    } catch {
      return null;
    }
  }
}
