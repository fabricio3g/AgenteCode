import crypto from 'node:crypto';
import { loadConfigFromDisk } from './config.js';
import { resolveProvider } from './providers/registry.js';
import { normalizeBaseUrl } from './providers/helpers.js';

const activeStreams = new Map();

// Resolve the real API key: use the provided key if present, otherwise look it up
// from the on-disk config by providerName first, then by matching base_url.
export function resolveApiKey(apiKey, baseUrl, providerName) {
  if (apiKey) return apiKey;
  const cfg = loadConfigFromDisk();
  const providers = cfg?.llm?.providers || {};
  const defaultProvider = cfg?.llm?.provider;

  if (providerName && providers[providerName]?.api_key) {
    return providers[providerName].api_key;
  }
  if (providerName && defaultProvider && defaultProvider !== providerName && providers[defaultProvider]?.api_key) {
    console.log(`[chat-ipc] Provider "${providerName}" has no key, using default provider "${defaultProvider}" key`);
    return providers[defaultProvider].api_key;
  }
  if (!providerName && defaultProvider && providers[defaultProvider]?.api_key) {
    return providers[defaultProvider].api_key;
  }
  const normalizedBase = normalizeBaseUrl(baseUrl);
  for (const [name, provider] of Object.entries(providers)) {
    if (normalizeBaseUrl(provider.base_url) === normalizedBase && provider.api_key) {
      console.log(`[chat-ipc] API key found by URL match for provider "${name}"`);
      return provider.api_key;
    }
  }
  console.log(`[chat-ipc] No API key found. Requested: "${providerName}", Default: "${defaultProvider}", BaseURL: "${baseUrl}"`);
  return '';
}

// ── Public API ──

export async function completeChatRequest({ baseUrl, apiKey, providerName, body }) {
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey && provider.name !== 'local') {
    const cfg = loadConfigFromDisk();
    const defaultProvider = cfg?.llm?.provider || 'none';
    const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
    throw new Error(`No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > Model Hub > API Providers.`);
  }

  return provider.completeChat({
    apiKey: realKey,
    baseUrl,
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p
  });
}

export async function startChatStream({ baseUrl, apiKey, providerName, body }, win) {
  console.log('[chat-ipc] startChatStream received:', {
    baseUrl,
    hasApiKey: !!apiKey,
    providerName,
    model: body?.model
  });

  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  if (!realKey && provider.name !== 'local') {
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

  // Safety timeout: abort and clean up stale streams after 10 minutes
  const streamTimeout = setTimeout(() => {
    if (activeStreams.has(streamId)) {
      abortController.abort();
      activeStreams.delete(streamId);
    }
  }, 10 * 60 * 1000);

  const emit = (payload) => {
    try {
      win?.webContents?.send('chat-stream-event', { streamId, ...payload });
    } catch {
      // Ignore renderer event delivery errors
    }
  };

  (async () => {
    try {
      const streamParams = {
        apiKey: realKey,
        baseUrl,
        model: body.model,
        messages: body.messages,
        tools: body.tools,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        top_p: body.top_p,
        ...body.extra_params
      };

      for await (const delta of provider.streamChat(streamParams)) {
        emit({ type: 'delta', content: delta.content, reasoning: delta.reasoning });
      }

      emit({ type: 'done' });
    } catch (error) {
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        emit({ type: 'error', error: String(error?.message || error || 'Chat stream failed') });
      }
    } finally {
      clearTimeout(streamTimeout);
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
