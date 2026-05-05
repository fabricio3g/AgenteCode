import OpenAI from 'openai';
import { BaseProvider } from './base.ts';
import { normalizeBaseUrl, numberOrNull, safeParseJson } from './helpers.ts';

export class OpenAICompatibleProvider extends BaseProvider {
  name = 'openai_compatible';
  label = 'OpenAI Compatible';
  supportsStreaming = true;

  detect(_providerName, _baseUrl) {
    return true;
  }

  createClient(apiKey, baseUrl) {
    const clientKey = `${apiKey || ''}::${normalizeBaseUrl(baseUrl)}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new OpenAI({
        apiKey: apiKey || 'not-needed',
        baseURL: normalizeBaseUrl(baseUrl) || 'https://api.openai.com/v1'
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
      const usage = chunk.usage || null;

      if (content || reasoning || toolCallDeltas || usage) {
        yield {
          content: content ?? '',
          reasoning: reasoning ?? '',
          ...(usage ? { usage: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens
          } } : {}),
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

    const response = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...params,
      stream: false
    }, { signal });

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

  async fetchModelMetadata(apiKey, baseUrl, modelId) {
    const client = this.createClient(apiKey, baseUrl);

    const parseMetadata = (record) => {
      if (!record || typeof record !== 'object') return null;
      const contextWindow = numberOrNull(
        record.context_window
        ?? record.context_length
        ?? record.max_context_length
        ?? record.inputTokenLimit
        ?? record.input_token_limit
        ?? record.top_provider?.context_length
      );
      if (!contextWindow) return null;

      const maxCompletionTokens = numberOrNull(
        record.max_completion_tokens
        ?? record.max_output_tokens
        ?? record.outputTokenLimit
        ?? record.output_token_limit
        ?? record.top_provider?.max_completion_tokens
      );

      const promptPerToken = numberOrNull(record.pricing?.prompt ?? record.prompt_cost_per_token);
      const completionPerToken = numberOrNull(record.pricing?.completion ?? record.completion_cost_per_token);

      return {
        context_window: contextWindow,
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
        ...(promptPerToken ? { prompt_cost_per_million: promptPerToken * 1_000_000 } : {}),
        ...(completionPerToken ? { completion_cost_per_million: completionPerToken * 1_000_000 } : {})
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
