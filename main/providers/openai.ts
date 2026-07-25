import OpenAI from 'openai';
import { BaseProvider } from './base.ts';
import { normalizeOpenAiBaseUrl, numberOrNull, safeParseJson } from './helpers.ts';
import type { ReasoningCapabilities, ReasoningRequest } from './base.ts';

const OPENAI_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export class OpenAIProvider extends BaseProvider {
  name = 'openai';
  label = 'OpenAI';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'openai' || url.includes('api.openai.com');
  }

  createClient(apiKey, baseUrl) {
    const clientKey = `${apiKey || ''}::${normalizeOpenAiBaseUrl(baseUrl) || 'https://api.openai.com/v1'}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new OpenAI({
        apiKey,
        baseURL: normalizeOpenAiBaseUrl(baseUrl) || 'https://api.openai.com/v1'
      }));
    }
    return this._clients.get(clientKey);
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const stream = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...this._reasoningBody(reasoning),
      ...params,
      stream: true,
      stream_options: { include_usage: true }
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

  async completeChat({ apiKey, baseUrl, model, messages, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const response = await client.chat.completions.create({
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...this._reasoningBody(reasoning),
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

  /**
   * Inspect `models.retrieve()` for reasoning capability fields. OpenAI's API
   * exposes support via fields like `supported_parameters` containing
   * 'reasoning_effort', or a `reasoning` capability object. We do not guess
   * from model name prefixes — only return supported: true when the API
   * confirms it. Falls back to 'unknown' (selector hidden) on any error.
   */
  async getReasoningCapabilities(apiKey, baseUrl, modelId): Promise<ReasoningCapabilities> {
    const client = this.createClient(apiKey, baseUrl);
    try {
      const detail = await client.models.retrieve(modelId);
      const record = (detail || {}) as Record<string, unknown>;
      const supportedParameters = Array.isArray(record.supported_parameters)
        ? record.supported_parameters as string[]
        : [];
      const reasoningCapability = record.reasoning as Record<string, unknown> | undefined;
      const acceptsReasoningEffort =
        supportedParameters.includes('reasoning_effort') ||
        supportedParameters.includes('reasoning') ||
        !!reasoningCapability;
      if (!acceptsReasoningEffort) {
        return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'api' };
      }
      // The API doesn't always expose the exact subset of levels per model;
      // return the full OpenAI enum and let the server reject an unsupported
      // value if a model only accepts a subset.
      return {
        supported: true,
        levels: OPENAI_REASONING_LEVELS as ReasoningCapabilities['levels'],
        paramShape: 'openai_reasoning_effort',
        source: 'api'
      };
    } catch {
      return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
    }
  }

  /**
   * Translate a reasoning level into the OpenAI Chat Completions body shape.
   * 'off' means "do not send the param" (provider default).
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
    const client = this.createClient(apiKey, baseUrl);

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
