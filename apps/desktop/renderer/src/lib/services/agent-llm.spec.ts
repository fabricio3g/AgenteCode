import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_IDLE_TIMEOUT_MS } from './chat-stream-idle';

const bridge = vi.hoisted(() => ({
  handlers: [] as Array<(payload: unknown) => void>,
  invokes: [] as Array<{ command: string; args?: Record<string, unknown> }>
}));

vi.mock('$lib/services/bridge', () => ({
  isElectron: () => true,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    bridge.invokes.push({ command, args });
    if (command === 'chat_stream_start') return { streamId: stream.id };
    return undefined;
  },
  listen: async (_channel: string, handler: (payload: unknown) => void) => {
    bridge.handlers.push(handler);
    return () => { stream.unsubscribed++; };
  }
}));

const stream = vi.hoisted(() => ({ id: 'stream-1', unsubscribed: 0 }));

vi.mock('$lib/utils/storage', () => ({ loadAppConfig: async () => CONFIG }));

import { streamAssistantReply } from './chat-api';
import { agentStreamComplete } from './agent-llm';

const CONFIG = {
  llm: {
    backend_mode: 'api',
    provider: 'openai',
    providers: { openai: { base_url: 'https://example.test/v1', model: 'test-model', api_key: 'test-key' } }
  }
} as never;

function emit(event: Record<string, unknown>): void {
  for (const handler of bridge.handlers) handler(event);
}

describe('agentStreamComplete idle watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge.handlers.length = 0;
    bridge.invokes.length = 0;
    stream.id = 'stream-1';
    stream.unsubscribed = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes chat deltas and usage, ignores other streams, and clears the watchdog on completion', async () => {
    const onChunk = vi.fn(), onReasoning = vi.fn(), onUsage = vi.fn();
    const pending = streamAssistantReply({ messages: [{ role: 'user', content: 'hi' }], onChunk, onReasoning, onUsage });
    await vi.advanceTimersByTimeAsync(0);
    emit({ streamId: 'other', type: 'delta', content: 'ignored' });
    emit({ streamId: 'stream-1', type: 'delta', content: 'hello', reasoning: 'plan' });
    emit({ streamId: 'stream-1', type: 'done', usage: { total_tokens: 12 } });
    await pending;
    expect(onChunk).toHaveBeenCalledExactlyOnceWith('hello');
    expect(onReasoning).toHaveBeenCalledExactlyOnceWith('plan');
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ total_tokens: 12 });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
    expect(bridge.invokes.filter((entry) => entry.command === 'chat_stream_cancel')).toHaveLength(0);
    expect(stream.unsubscribed).toBe(1);
  });

  it('cancels an aborted chat stream and removes the abort listener after it settles', async () => {
    const controller = new AbortController();
    const pending = streamAssistantReply({ messages: [], onChunk: vi.fn(), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(bridge.invokes.at(-1)).toEqual({ command: 'chat_stream_cancel', args: { streamId: 'stream-1' } });
    emit({ streamId: 'stream-1', type: 'cancelled' });
    await pending;
    controller.signal.dispatchEvent(new Event('abort'));
    expect(bridge.invokes.filter((entry) => entry.command === 'chat_stream_cancel')).toHaveLength(1);
  });

  it('rejects a silent chat stream and releases its subscription', async () => {
    const pending = streamAssistantReply({ messages: [], onChunk: vi.fn() });
    const failed = expect(pending).rejects.toThrow('Stream timed out');
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
    await failed;
    expect(stream.unsubscribed).toBe(1);
  });

  it('reports a missing chat stream id instead of waiting for events', async () => {
    stream.id = '';
    await expect(streamAssistantReply({ messages: [], onChunk: vi.fn() })).rejects.toThrow('Failed to start chat stream');
    expect(stream.unsubscribed).toBe(1);
  });

  it('fails a stream that never sends a single event instead of hanging forever', async () => {
    const onError = vi.fn();
    const pending = agentStreamComplete({
      messages: [{ role: 'user', content: 'hi' }],
      config: CONFIG,
      onError
    });

    // Let listen + chat_stream_start resolve so the watchdog is armed.
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.invokes.some((entry) => entry.command === 'chat_stream_start')).toBe(true);

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
    const result = await pending;

    // No partial output -> the caller gets the normal null + visible error.
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(bridge.invokes.some((entry) => entry.command === 'chat_stream_cancel')).toBe(true);
  });

  it('resets on every event and completes normally on done', async () => {
    const onContent = vi.fn();
    const pending = agentStreamComplete({
      messages: [{ role: 'user', content: 'hi' }],
      config: CONFIG,
      onContent
    });

    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 2; i++) {
      emit({ streamId: 'stream-1', type: 'delta', content: 'chunk' });
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000);
    }
    emit({ streamId: 'stream-1', type: 'done', toolCalls: [], usage: null, providerState: null });

    const result = await pending;
    expect(result?.content).toBe('chunkchunk');
    expect(bridge.invokes.some((entry) => entry.command === 'chat_stream_cancel')).toBe(false);
  });
});
