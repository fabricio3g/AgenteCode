import { Mistral } from '@mistralai/mistralai';
import { BaseProvider } from './base.ts';
import { normalizeBaseUrl, numberOrNull, safeParseJson } from './helpers.ts';

export class MistralProvider extends BaseProvider {
  name = 'mistral';
  label = 'Mistral';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'mistral' || url.includes('api.mistral.ai');
  }

  createClient(apiKey, baseUrl) {
    const clientKey = `${apiKey || ''}::${normalizeBaseUrl(baseUrl) || 'https://api.mistral.ai'}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new Mistral({
        apiKey,
        ...(normalizeBaseUrl(baseUrl) ? { serverURL: normalizeBaseUrl(baseUrl) } : {})
      }));
    }
    return this._clients.get(clientKey);
  }

  _buildMessages(messages) {
    const systemMessages = [];
    const chatMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content);
      } else {
        chatMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return {
      systemMessage: systemMessages.length ? systemMessages.join('\n') : undefined,
      messages: chatMessages
    };
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, max_tokens, temperature, top_p, signal }) {
    const client = this.createClient(apiKey, baseUrl);
    const { systemMessage, messages: chatMessages } = this._buildMessages(messages);

    const request = {
      model,
      messages: chatMessages,
      ...(systemMessage ? { systemMessage } : {}),
      ...(max_tokens ? { maxTokens: max_tokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(top_p != null ? { topP: top_p } : {}),
      ...(tools?.length ? { tools } : {}),
      stream: true
    };

    const stream = await client.chat.stream(request, { signal });
    for await (const chunk of stream) {
      const delta = chunk.data?.choices?.[0]?.delta || {};
      const content = delta.content;
      const toolCallDeltas = delta.tool_calls;

      if (content || toolCallDeltas) {
        yield {
          content: content ?? '',
          reasoning: '',
          ...(toolCallDeltas ? {
            toolCallDeltas: toolCallDeltas.map((tc, i) => ({
              index: tc.index ?? i,
              id: tc.id ?? undefined,
              name: tc.function?.name ?? undefined,
              arguments: tc.function?.arguments ?? undefined
            }))
          } : {})
        };
      }
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, tools, max_tokens, temperature, top_p, signal }) {
    const client = this.createClient(apiKey, baseUrl);
    const { systemMessage, messages: chatMessages } = this._buildMessages(messages);

    const request = {
      model,
      messages: chatMessages,
      ...(systemMessage ? { systemMessage } : {}),
      ...(max_tokens ? { maxTokens: max_tokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(top_p != null ? { topP: top_p } : {}),
      ...(tools?.length ? { tools } : {}),
      stream: false
    };

    const response = await client.chat.complete(request, { signal });
    const choice = response?.choices?.[0] || {};
    const message = choice.message || {};

    return {
      content: message.content || '',
      reasoning: '',
      usage: response?.usage ? {
        input_tokens: response.usage.promptTokens,
        output_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens
      } : null,
      toolCalls: message.toolCalls ? message.toolCalls.map(tc => ({
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
      const detail = await client.models.retrieve({ modelId });
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
