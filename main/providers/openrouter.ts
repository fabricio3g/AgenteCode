import OpenAI from 'openai';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { normalizeOpenAiBaseUrl, safeParseJson } from './helpers.ts';

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
    const clientKey = `${apiKey || ''}::${normalizeOpenAiBaseUrl(baseUrl)}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new OpenAI({
        apiKey: apiKey || 'not-needed',
        baseURL: normalizeOpenAiBaseUrl(baseUrl) || 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://chatea.app',
          'X-Title': 'Chatea'
        }
      }));
    }
    return this._clients.get(clientKey);
  }

  logRequestError(stage, error, details = {}) {
    const status = error?.status ?? error?.code ?? error?.response?.status;
    const headers = error?.headers ?? error?.response?.headers;
    const body = error?.error ?? error?.response?.data ?? error?.body;
    console.error('[OpenRouter] request failed', {
      stage,
      status,
      message: error?.message || String(error),
      code: error?.code,
      type: error?.type,
      details,
      headers,
      body
    });
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const requestDetails = {
      model,
      baseUrl: normalizeOpenAiBaseUrl(baseUrl) || 'https://openrouter.ai/api/v1',
      messageCount: messages?.length || 0,
      toolCount: tools?.length || 0,
      stream: true,
      params: Object.keys(params || {})
    };

    let stream;
    try {
      console.log('[OpenRouter] stream request', requestDetails);
      stream = await client.chat.completions.create({
        model,
        messages,
        ...(tools?.length ? { tools } : {}),
        ...this._reasoningBody(reasoning),
        ...params,
        stream: true,
        stream_options: { include_usage: true }
      }, { signal });
    } catch (error) {
      this.logRequestError('stream.create', error, requestDetails);
      throw error;
    }

    try {
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
    } catch (error) {
      this.logRequestError('stream.iterate', error, requestDetails);
      throw error;
    }
  }

  async completeChat({ apiKey, baseUrl, model, messages, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined)
    );
    const requestDetails = {
      model,
      baseUrl: normalizeOpenAiBaseUrl(baseUrl) || 'https://openrouter.ai/api/v1',
      messageCount: messages?.length || 0,
      toolCount: tools?.length || 0,
      stream: false,
      params: Object.keys(cleanParams || {})
    };

    let response;
    try {
      console.log('[OpenRouter] completion request', requestDetails);
      response = await client.chat.completions.create({
        model,
        messages,
        ...(tools?.length ? { tools } : {}),
        ...this._reasoningBody(reasoning),
        ...cleanParams,
        stream: false
      }, { signal });
    } catch (error) {
      this.logRequestError('completion.create', error, requestDetails);
      throw error;
    }

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

  /**
   * OpenRouter routes to many underlying providers, each with its own
   * reasoning support. OpenRouter's `/models` endpoint does not reliably
   * expose reasoning capability fields per model, so we return 'unknown'
   * (selector hidden) by default. If OpenRouter exposes a clear field in
   * the future, override this to read it.
   */
  async getReasoningCapabilities(): Promise<ReasoningCapabilities> {
    return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
  }

  /**
   * OpenRouter follows the OpenAI `reasoning_effort` convention for models
   * that support it. We forward the param when a level is chosen; the
   * upstream provider (via OpenRouter) will reject it if unsupported.
   */
  _reasoningBody(reasoning?: ReasoningRequest): Record<string, unknown> {
    if (!reasoning || !reasoning.level || reasoning.level === 'off') return {};
    return { reasoning_effort: reasoning.level };
  }

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    return { ...body, ...this._reasoningBody(reasoning) };
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
    try {
      const client = this.createClient(apiKey, baseUrl);
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
