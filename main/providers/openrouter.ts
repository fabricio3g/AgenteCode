import { OpenRouter } from '@openrouter/sdk';
import { BaseProvider, type ReasoningCapabilities, type ReasoningRequest } from './base.ts';
import { normalizeOpenAiBaseUrl, safeParseJson } from './helpers.ts';

const OPENROUTER_DEFAULT_LEVELS = [
  'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
] as const;

type OpenRouterEffort =
  | 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

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
    const normalized = normalizeOpenAiBaseUrl(baseUrl) || 'https://openrouter.ai/api/v1';
    const clientKey = `${apiKey || ''}::${normalized}`;
    if (!this._clients.has(clientKey)) {
      this._clients.set(clientKey, new OpenRouter({
        apiKey: apiKey || '',
        serverURL: normalized,
        httpReferer: 'https://chatea.app',
        appTitle: 'Chatea'
      }));
    }
    return this._clients.get(clientKey) as OpenRouter;
  }

  logRequestError(stage, error, details = {}) {
    const status = error?.status ?? error?.code ?? error?.response?.status ?? error?.statusCode;
    const body = error?.error ?? error?.response?.data ?? error?.body ?? error?.data;
    console.error('[OpenRouter] request failed', {
      stage,
      status,
      message: error?.message || String(error),
      code: error?.code,
      type: error?.type,
      details,
      body
    });
  }

  _chatRequestBase({ model, messages, tools, reasoning, params, stream }) {
    const cleanParams = Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v !== undefined)
    );
    return {
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...this._reasoningBody(reasoning),
      ...cleanParams,
      stream
    };
  }

  async *streamChat({ apiKey, baseUrl, model, messages, tools, reasoning, signal, ...params }) {
    const client = this.createClient(apiKey, baseUrl);
    const requestDetails = {
      model,
      messageCount: messages?.length || 0,
      toolCount: tools?.length || 0,
      stream: true
    };

    let stream;
    try {
      console.log('[OpenRouter] stream request', requestDetails);
      stream = await client.chat.send({
        chatRequest: this._chatRequestBase({
          model, messages, tools, reasoning, params, stream: true
        }),
        httpReferer: 'https://chatea.app',
        appTitle: 'Chatea'
      }, signal ? { signal } : undefined);
    } catch (error) {
      this.logRequestError('stream.create', error, requestDetails);
      throw error;
    }

    try {
      // SDK returns EventStream when stream: true
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        const choices = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices;
        const delta = choices?.[0]?.delta || {};
        const content = delta.content as string | null | undefined;
        const reasoningText = (delta.reasoning ?? delta.reasoning_content ?? delta.thinking) as string | undefined;
        const toolCallDeltas = (delta.toolCalls ?? delta.tool_calls) as Array<Record<string, unknown>> | undefined;

        if (content || reasoningText || toolCallDeltas) {
          yield {
            content: content ?? '',
            reasoning: reasoningText ?? '',
            ...(toolCallDeltas ? {
              toolCallDeltas: toolCallDeltas.map((tc, i) => {
                const fn = (tc.function || {}) as { name?: string; arguments?: string };
                return {
                  index: (tc.index as number) ?? i,
                  id: (tc.id as string) ?? undefined,
                  name: fn.name ?? undefined,
                  arguments: fn.arguments ?? undefined
                };
              })
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
    const requestDetails = {
      model,
      messageCount: messages?.length || 0,
      toolCount: tools?.length || 0,
      stream: false
    };

    let response;
    try {
      console.log('[OpenRouter] completion request', requestDetails);
      response = await client.chat.send({
        chatRequest: this._chatRequestBase({
          model, messages, tools, reasoning, params, stream: false
        }),
        httpReferer: 'https://chatea.app',
        appTitle: 'Chatea'
      }, signal ? { signal } : undefined);
    } catch (error) {
      this.logRequestError('completion.create', error, requestDetails);
      throw error;
    }

    const result = response as {
      choices?: Array<{ message?: Record<string, unknown> }>;
      usage?: Record<string, unknown>;
    };
    const message = result?.choices?.[0]?.message || {};
    const rawReasoning = message.reasoning ?? message.reasoning_content ?? message.thinking;
    const toolCalls = message.toolCalls ?? message.tool_calls;

    return {
      content: (message.content as string) || '',
      reasoning: rawReasoning ? String(rawReasoning) : '',
      usage: result?.usage || null,
      toolCalls: Array.isArray(toolCalls) ? toolCalls.map((tc: Record<string, unknown>) => {
        const fn = (tc.function || {}) as { name?: string; arguments?: string };
        return {
          id: tc.id as string,
          name: fn.name || '',
          arguments: safeParseJson(fn.arguments) || fn.arguments || ''
        };
      }) : null
    };
  }

  /**
   * Use OpenRouter models.list reasoning metadata when available
   * (`supportedEfforts`, `mandatory`, etc.).
   */
  async getReasoningCapabilities(apiKey, baseUrl, modelId): Promise<ReasoningCapabilities> {
    try {
      const client = this.createClient(apiKey, baseUrl);
      const models = await collectOpenRouterModels(client);
      const found = models.find(m =>
        String(m.id || m.canonicalSlug || '') === String(modelId)
      );
      if (!found) {
        return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
      }

      const reasoningMeta = found.reasoning as {
        supportedEfforts?: Array<string | null> | null;
        mandatory?: boolean;
        defaultEffort?: string | null;
      } | undefined;

      if (!reasoningMeta) {
        const params = (found.supportedParameters ?? found.supported_parameters) as string[] | undefined;
        if (Array.isArray(params) && (params.includes('reasoning') || params.includes('include_reasoning'))) {
          return {
            supported: true,
            levels: [...OPENROUTER_DEFAULT_LEVELS] as ReasoningCapabilities['levels'],
            paramShape: 'openai_reasoning_effort',
            source: 'api'
          };
        }
        return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'api' };
      }

      const efforts = Array.isArray(reasoningMeta.supportedEfforts)
        ? reasoningMeta.supportedEfforts.filter((e): e is string => !!e)
        : [...OPENROUTER_DEFAULT_LEVELS].filter(l => l !== 'off');

      const levels = reasoningMeta.mandatory
        ? efforts
        : ['off', ...efforts.filter(e => e !== 'off')];

      return {
        supported: true,
        levels: levels as ReasoningCapabilities['levels'],
        paramShape: 'openai_reasoning_effort',
        source: 'api'
      };
    } catch {
      return { supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'unknown' };
    }
  }

  /**
   * Prefer unified `reasoning: { effort }` object (official OpenRouter shape).
   */
  _reasoningBody(reasoning?: ReasoningRequest): Record<string, unknown> {
    if (!reasoning || !reasoning.level || reasoning.level === 'off') return {};
    if (reasoning.level === 'enabled' || reasoning.level === 'on') {
      return { reasoning: { effort: 'medium' as OpenRouterEffort } };
    }
    if (reasoning.level === 'disabled') {
      return { reasoning: { effort: 'none' as OpenRouterEffort } };
    }
    const effort = reasoning.level as OpenRouterEffort;
    return { reasoning: { effort } };
  }

  applyReasoningToBody(body: Record<string, unknown>, reasoning?: ReasoningRequest): Record<string, unknown> {
    return { ...body, ...this._reasoningBody(reasoning) };
  }

  async fetchModels(apiKey, baseUrl) {
    try {
      const client = this.createClient(apiKey, baseUrl);
      const models = await collectOpenRouterModels(client);
      return [...new Set(models.map(m => String(m.id || '')).filter(Boolean))].sort();
    } catch {
      return [];
    }
  }

  async fetchModelMetadata(apiKey, baseUrl, modelId) {
    try {
      const client = this.createClient(apiKey, baseUrl);
      const parts = parseOpenRouterModelId(modelId);
      if (parts) {
        try {
          const detail = await client.models.get({
            author: parts.author,
            slug: parts.slug,
            httpReferer: 'https://chatea.app',
            appTitle: 'Chatea'
          });
          const meta = metadataFromOpenRouterModel(unwrapOpenRouterModelDetail(detail));
          if (meta) return meta;
        } catch {
          // fall through to list
        }
      }

      const models = await collectOpenRouterModels(client);
      const found = models.find(m => String(m.id || '') === String(modelId));
      return metadataFromOpenRouterModel(found || null);
    } catch {
      // fallback
    }
    return null;
  }
}

/**
 * OpenRouter SDK pages are shaped as:
 *   { result: { data: Model[], links, totalCount } }
 * Older/compat shapes may use top-level `data`.
 */
export function extractModelsFromOpenRouterListPage(page: unknown): Array<Record<string, unknown>> {
  if (!page || typeof page !== 'object') return [];
  const rec = page as Record<string, unknown>;

  const fromResult = rec.result;
  if (fromResult && typeof fromResult === 'object') {
    const result = fromResult as Record<string, unknown>;
    if (Array.isArray(result.data)) return result.data as Array<Record<string, unknown>>;
  }

  if (Array.isArray(rec.data)) return rec.data as Array<Record<string, unknown>>;

  // Single model object
  if (typeof rec.id === 'string' || typeof rec.canonicalSlug === 'string') {
    return [rec];
  }

  return [];
}

export function parseOpenRouterModelId(modelId: string): { author: string; slug: string } | null {
  const raw = String(modelId || '').trim();
  if (!raw || !raw.includes('/')) return null;
  const [author, ...rest] = raw.split('/');
  const slug = rest.join('/');
  if (!author || !slug) return null;
  return { author, slug };
}

export function metadataFromOpenRouterModel(model: Record<string, unknown> | null | undefined): {
  context_window: number;
  max_completion_tokens?: number;
} | null {
  if (!model || typeof model !== 'object') return null;
  const contextLength = model.contextLength ?? model.context_length;
  const n = Number(contextLength);
  if (!Number.isFinite(n) || n <= 0) return null;

  const result: { context_window: number; max_completion_tokens?: number } = {
    context_window: Math.floor(n)
  };

  const top = (model.topProvider ?? model.top_provider) as
    | { maxCompletionTokens?: number; max_completion_tokens?: number }
    | undefined;
  const maxOut = Number(top?.maxCompletionTokens ?? top?.max_completion_tokens);
  if (Number.isFinite(maxOut) && maxOut > 0) {
    result.max_completion_tokens = Math.floor(maxOut);
  }

  return result;
}

function unwrapOpenRouterModelDetail(detail: unknown): Record<string, unknown> | null {
  if (!detail || typeof detail !== 'object') return null;
  const rec = detail as Record<string, unknown>;
  // Possible wrappers: { data }, { result }, { result: { data } }
  if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  if (rec.result && typeof rec.result === 'object') {
    const result = rec.result as Record<string, unknown>;
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      return result.data as Record<string, unknown>;
    }
    if (typeof result.id === 'string' || typeof result.contextLength === 'number') {
      return result;
    }
  }
  if (typeof rec.id === 'string' || typeof rec.contextLength === 'number') {
    return rec;
  }
  return null;
}

async function collectOpenRouterModels(client: OpenRouter): Promise<Array<Record<string, unknown>>> {
  const page = await client.models.list({
    httpReferer: 'https://chatea.app',
    appTitle: 'Chatea'
  });
  const models: Array<Record<string, unknown>> = [];

  // PageIterator yields GetModelsResponse pages
  if (page && typeof (page as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    for await (const item of page as AsyncIterable<unknown>) {
      models.push(...extractModelsFromOpenRouterListPage(item));
      if (models.length > 5000) break;
    }
  }

  // Also accept a plain first page object
  if (!models.length) {
    models.push(...extractModelsFromOpenRouterListPage(page));
  }

  return models;
}

/** Exported for unit tests */
export function mapOpenRouterReasoningBody(reasoning?: ReasoningRequest): Record<string, unknown> {
  return new OpenRouterProvider()._reasoningBody(reasoning);
}
