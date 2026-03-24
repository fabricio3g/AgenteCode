import crypto from 'node:crypto';
import { loadConfigFromDisk } from './config.js';

const activeStreams = new Map();

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function resolveChatUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return 'https://api.openai.com/v1/chat/completions';
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

// Resolve the real API key: use the provided key if present, otherwise look it up
// from the on-disk config by providerName first, then by matching base_url.
// Throws a clear error if no API key can be resolved.
function resolveApiKey(apiKey, baseUrl, providerName) {
  if (apiKey) return apiKey;
  const cfg = loadConfigFromDisk();
  const providers = cfg?.llm?.providers || {};
  const defaultProvider = cfg?.llm?.provider;
  
  // Prefer exact name lookup (avoids URL mismatch issues)
  if (providerName && providers[providerName]?.api_key) {
    return providers[providerName].api_key;
  }
  // If requested provider exists but has no key, check if default provider is different
  if (providerName && defaultProvider && defaultProvider !== providerName && providers[defaultProvider]?.api_key) {
    console.log(`[chat-ipc] Provider "${providerName}" has no key, using default provider "${defaultProvider}" key`);
    return providers[defaultProvider].api_key;
  }
  // Try default provider if no specific provider requested
  if (!providerName && defaultProvider && providers[defaultProvider]?.api_key) {
    return providers[defaultProvider].api_key;
  }
  // Fallback: URL matching
  const normalizedBase = normalizeBaseUrl(baseUrl);
  for (const [name, provider] of Object.entries(providers)) {
    if (normalizeBaseUrl(provider.base_url) === normalizedBase && provider.api_key) {
      console.log(`[chat-ipc] API key found by URL match for provider "${name}"`);
      return provider.api_key;
    }
  }
  // No API key found - return empty to let the request fail with a clear error
  console.log(`[chat-ipc] No API key found. Requested: "${providerName}", Default: "${defaultProvider}", BaseURL: "${baseUrl}"`);
  return '';
}

function parseSseDelta(line) {
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

function makeHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function completeChatRequest({ baseUrl, apiKey, providerName, body }) {
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey) {
    const cfg = loadConfigFromDisk();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    throw new Error(`No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`);
  }
  const response = await fetch(resolveChatUrl(baseUrl), {
    method: 'POST',
    headers: makeHeaders(realKey),
    body: JSON.stringify({ ...(body || {}), stream: false })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'Request failed');
    throw new Error(detail || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function startChatStream({ baseUrl, apiKey, providerName, body }, win) {
  console.log('[chat-ipc] startChatStream received:', { 
    baseUrl, 
    hasApiKey: !!apiKey, 
    providerName,
    model: body?.model 
  });
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey) {
    const cfg = loadConfigFromDisk();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    const errorMsg = `No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`;
    
    const streamId = crypto.randomUUID();
    const emit = (payload) => {
      try {
        win?.webContents?.send('chat-stream-event', { streamId, ...payload });
      } catch {
        // Ignore renderer event delivery errors
      }
    };
    setTimeout(() => {
      emit({ type: 'error', error: errorMsg });
    }, 0);
    return { streamId };
  }
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  activeStreams.set(streamId, abortController);

  const emit = (payload) => {
    try {
      win?.webContents?.send('chat-stream-event', { streamId, ...payload });
    } catch {
      // Ignore renderer event delivery errors
    }
  };

  (async () => {
    try {
      const response = await fetch(resolveChatUrl(baseUrl), {
        method: 'POST',
        headers: makeHeaders(realKey),
        signal: abortController.signal,
        body: JSON.stringify({ ...(body || {}), stream: true })
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => 'Request failed');
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream available');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const delta = parseSseDelta(line);
          if (!delta) continue;
          emit({ type: 'delta', content: delta.content, reasoning: delta.reasoning });
        }
      }

      const tail = parseSseDelta(buffer);
      if (tail) emit({ type: 'delta', content: tail.content, reasoning: tail.reasoning });
      emit({ type: 'done' });
    } catch (error) {
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        emit({ type: 'error', error: String(error?.message || error || 'Chat stream failed') });
      }
    } finally {
      activeStreams.delete(streamId);
    }
  })();

  return { streamId };
}

export async function cancelChatStream({ streamId }) {
  const key = String(streamId || '');
  const controller = activeStreams.get(key);
  if (!controller) return { cancelled: false };
  controller.abort();
  activeStreams.delete(key);
  return { cancelled: true };
}
