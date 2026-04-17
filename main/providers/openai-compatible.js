import { BaseProvider } from './base.js';

/**
 * Generic OpenAI-compatible provider fallback.
 * Handles DeepSeek, Together AI, Fireworks, Perplexity, OpenRouter,
 * LM Studio, Ollama, and any other OpenAI-compatible API.
 */
export class OpenAICompatibleProvider extends BaseProvider {
  name = 'openai_compatible';
  label = 'OpenAI Compatible';
  supportsStreaming = true;

  detect(_providerName, _baseUrl) {
    // Always matches as last resort
    return true;
  }

  resolveUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return 'https://api.openai.com/v1/chat/completions';
    return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
  }

  buildHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  transformBody(body) {
    return body;
  }

  parseStreamDelta(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return null;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;

    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta || parsed?.choices?.[0]?.message || {};
      const rawContent = delta.content;
      const rawReasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      const content = rawContent != null ? String(rawContent) : '';
      const reasoning = rawReasoning != null ? String(rawReasoning) : '';
      if (!content && !reasoning) return null;
      return { content, reasoning };
    } catch {
      return null;
    }
  }

  parseResponse(data) {
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    const rawReasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
    return {
      content: message.content || '',
      reasoning: rawReasoning ? String(rawReasoning) : '',
      usage: data?.usage || null
    };
  }

  async fetchModels(apiKey, baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return [];
    const url = `${normalized}/models`;
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const list = data?.data ?? data?.models ?? [];
    return list.map((m) => m.id).filter(Boolean).sort();
  }

  async fetchModelMetadata(apiKey, baseUrl, modelId) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return null;

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

    const detailUrl = `${normalized}/models/${encodeURIComponent(modelId)}`;
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    try {
      const detailRes = await fetch(detailUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (detailRes.ok) {
        const detail = await detailRes.json();
        const parsed = parseMetadata(detail?.data || detail);
        if (parsed) return parsed;
      }
    } catch {
      // Continue to list fallback.
    }

    try {
      const listUrl = `${normalized}/models`;
      const listRes = await fetch(listUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (!listRes.ok) return null;
      const payload = await listRes.json();
      const list = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];
      const found = list.find((entry) => String(entry?.id || '') === String(modelId));
      return parseMetadata(found || null);
    } catch {
      return null;
    }
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
