import { BaseProvider } from './base.js';

export class OpenAIProvider extends BaseProvider {
  name = 'openai';
  label = 'OpenAI';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'openai' || url.includes('api.openai.com');
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
    const normalized = normalizeBaseUrl(baseUrl || 'https://api.openai.com/v1');
    const url = `${normalized}/models`;
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const list = data?.data ?? data?.models ?? [];
    return list.map((m) => m.id).filter(Boolean).sort();
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}
