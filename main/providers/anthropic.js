import { BaseProvider } from './base.js';

export class AnthropicProvider extends BaseProvider {
  name = 'anthropic';
  label = 'Anthropic';
  supportsStreaming = true;

  detect(providerName, baseUrl) {
    if (!providerName && !baseUrl) return false;
    const name = (providerName || '').toLowerCase();
    const url = (baseUrl || '').toLowerCase();
    return name.includes('anthropic') || name.includes('claude') ||
      url.includes('anthropic.com') || url.includes('claude.ai') ||
      name === 'claude';
  }

  resolveUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized.includes('anthropic.com') || normalized.includes('claude.ai')) {
      return normalized.replace(/\/chat\/completions$/, '').replace(/\/v1\/?$/, '/v1') + '/messages';
    }
    return 'https://api.anthropic.com/v1/messages';
  }

  buildHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-01-01';
    }
    return headers;
  }

  transformBody(body) {
    const openaiMessages = Array.isArray(body?.messages) ? body.messages : [];
    let systemPrompt = null;
    const otherMessages = [];

    for (const msg of openaiMessages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else {
        otherMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return {
      model: body.model,
      max_tokens: body.max_tokens || 4096,
      stream: body.stream,
      system: systemPrompt ? [{ type: 'text', text: systemPrompt }] : undefined,
      messages: otherMessages
    };
  }

  parseStreamDelta(line) {
    const trimmed = String(line || '').trim();

    if (trimmed.startsWith('event:')) {
      return { _eventType: trimmed.slice(5).trim() };
    }

    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!payload) return null;
      try {
        return { _data: JSON.parse(payload) };
      } catch {
        return null;
      }
    }

    return null;
  }

  parseResponse(data) {
    const contentBlocks = data?.content || [];
    let content = '';
    let reasoning = '';
    for (const block of contentBlocks) {
      if (block.type === 'text') content += block.text;
      if (block.type === 'thinking') reasoning += block.thinking;
    }
    return {
      content,
      reasoning,
      usage: data?.usage ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens } : null
    };
  }

  async fetchModels(apiKey, _baseUrl) {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-01-01',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const list = data?.data ?? [];
    return list.map((m) => m.id).filter(Boolean).sort();
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}
