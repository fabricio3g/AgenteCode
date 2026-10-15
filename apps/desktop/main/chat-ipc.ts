import crypto from 'node:crypto';
import { getCachedConfig, resolveApiKey } from './provider-auth.ts';
import { resolveProvider } from './providers/registry.ts';
import { safeParseJson } from './providers/helpers.ts';
import { classifyError, LlmStreamError } from './providers/protocol.ts';
import { GenerationTimer } from '../shared/generation-speed.ts';

const activeStreams = new Map();

function mergeToolCallText(currentValue, nextValue, { append = false } = {}) {
  const current = String(currentValue || '');
  const next = String(nextValue || '');
  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  if (!append) return next.length > current.length ? next : current;
  if (current.endsWith(next)) return current;
  return current + next;
}

export function accumulateToolCallDelta(toolCallAccumulator, delta, { appendArguments = true } = {}) {
  if (!delta) return;
  const index = Number.isFinite(delta.index) ? delta.index : 0;
  const existing = toolCallAccumulator.get(index) || { id: '', name: '', arguments: '' };
  existing.id = mergeToolCallText(existing.id, delta.id, { append: false });
  existing.name = mergeToolCallText(existing.name, delta.name, { append: false });
  existing.arguments = mergeToolCallText(existing.arguments, delta.arguments, { append: appendArguments });
  toolCallAccumulator.set(index, existing);
}

export function finalizeToolCalls(toolCallAccumulator) {
  if (!toolCallAccumulator?.size) return undefined;
  return Array.from(toolCallAccumulator.values()).map(tc => ({
    id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
    name: tc.name,
    arguments: safeParseJson(tc.arguments) || tc.arguments
  })).filter(tc => tc.name);
}

// ── Public API ──

function authenticationError(provider: { name: string }, apiKey: string, providerName: string): string | null {
  if (apiKey || ['local', 'lmstudio', 'ollama', 'custom'].includes(provider.name)) return null;
  const cfg = getCachedConfig();
  const defaultProvider = cfg?.llm?.provider || 'none';
  const availableProviders = Object.keys(cfg?.llm?.providers || {}).join(', ') || 'none';
  return `No API key configured for "${providerName || defaultProvider}". Available providers: ${availableProviders}. Please add your API key in Settings > API.`;
}

export async function completeChatRequest({ baseUrl, apiKey, providerName, body }) {
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  const error = authenticationError(provider, realKey, providerName);
  if (error) throw new Error(error);

  const params = Object.fromEntries(
    Object.entries({
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: body.stop,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
      ...body.extra_params
    }).filter(([, v]) => v !== undefined)
  );

  /*
   * No `signal` here. There used to be a `signal: abortController.signal`, but
   * `abortController` is local to `startChatStream` below — so this threw
   * `ReferenceError: abortController is not defined` on every single
   * `chat_complete` call, taking down the whole non-streaming path.
   *
   * It cannot be fixed by moving a controller here either: an `AbortSignal` does
   * not survive IPC structured cloning, and the renderer sends only
   * `{ baseUrl, apiKey, providerName, body }`. Cancelling a non-streaming
   * completion needs a request id plus a matching cancel channel, the way
   * `startChatStream`/`cancelChatStream` are paired.
   */
  return provider.complete({
    apiKey: realKey,
    baseUrl,
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    reasoning: await thinkingFor(providerName, body),
    ...params
  });
}

/** The request's thinking level with the core's fields for it attached. */
async function thinkingFor(providerName: string, body: { model?: string; reasoning?: unknown }) {
  const { withThinkingBody } = await import('./agente/thinking.ts');
  return withThinkingBody(String(providerName || ''), body.model, body.reasoning as never);
}

export async function startChatStream({ baseUrl, apiKey, providerName, body }, win) {
  const provider = resolveProvider(providerName, baseUrl);
  const realKey = resolveApiKey(apiKey, baseUrl, providerName);
  const errorMsg = authenticationError(provider, realKey, providerName);
  if (errorMsg) {
    const streamId = crypto.randomUUID();
    const emit = (payload) => {
      try {
        win?.webContents?.send('chat-stream-event', { streamId, ...payload });
      } catch {
      }
    };
    setTimeout(() => {
      emit({ type: 'error', error: errorMsg, errorCode: 'AUTH' });
    }, 0);
    return { streamId };
  }

  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  activeStreams.set(streamId, abortController);

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
        reasoning: await thinkingFor(providerName, body),
        signal: abortController.signal,
        ...Object.fromEntries(
          Object.entries({
            max_tokens: body.max_tokens,
            temperature: body.temperature,
            top_p: body.top_p,
            stop: body.stop,
            ...body.extra_params
          }).filter(([, v]) => v !== undefined)
        )
      };

      const toolCallAccumulator = new Map();
      let finalUsage = null;
      const generationTimer = new GenerationTimer();
      let providerState;

      // One normalized chunk protocol for every provider — the renderer
      // events keep their shape; usage may carry additive stream timing.
      for await (const chunk of provider.stream(streamParams)) {
        if (abortController.signal.aborted) {
          break;
        }
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text || chunk.type === 'tool-call-delta' && chunk.delta.argumentsDelta) {
          generationTimer.record(performance.now());
        }

        switch (chunk.type) {
          case 'text-delta':
            emit({ type: 'delta', content: chunk.text, reasoning: '' });
            break;
          case 'reasoning-delta':
            emit({ type: 'delta', content: '', reasoning: chunk.text });
            break;
          case 'tool-call-delta':
            accumulateToolCallDelta(toolCallAccumulator, {
              index: chunk.delta.index,
              id: chunk.delta.id,
              name: chunk.delta.name,
              arguments: chunk.delta.argumentsDelta
            }, { appendArguments: true });
            break;
          case 'usage':
            finalUsage = chunk.usage;
            break;
          case 'provider-state':
            providerState = chunk.state;
            break;
          case 'finish':
             if (chunk.reason.kind === 'error') throw new LlmStreamError(chunk.reason.failure);
            break;
        }
      }

      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
        return;
      }

      const finalToolCalls = finalizeToolCalls(toolCallAccumulator);
      const outputStreamMs = generationTimer.duration(performance.now());
      if (finalUsage && outputStreamMs !== undefined) {
        finalUsage = { ...finalUsage, timings: { ...finalUsage.timings, output_stream_ms: outputStreamMs } };
      }
      emit({ type: 'done', toolCalls: finalToolCalls, usage: finalUsage, providerState });
    } catch (error) {
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        const failure = classifyError(error);
        emit({ type: 'error', error: failure.message, errorCode: failure.code });
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
