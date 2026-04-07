import { BaseProvider } from './base.js';

export class LocalProvider extends BaseProvider {
  name = 'local';
  label = 'Local (llama.cpp)';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name === 'local' || name === 'llama_cpp' || name === 'llamacpp' ||
      url.includes('127.0.0.1') || url.includes('localhost');
  }

  resolveUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return 'http://127.0.0.1:11435/v1/chat/completions';
    return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
  }

  buildHeaders(_apiKey) {
    return { 'Content-Type': 'application/json' };
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

  async fetchModels(_apiKey, baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return [];
    const url = `${normalized}/models`;
    const headers = { 'Accept': 'application/json' };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const list = data?.data ?? data?.models ?? [];
    return list.map((m) => m.id).filter(Boolean).sort();
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}
