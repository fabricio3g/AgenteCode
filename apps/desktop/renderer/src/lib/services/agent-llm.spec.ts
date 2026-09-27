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
    if (command === 'chat_stream_start') return { streamId: 'stream-1' };
    return undefined;
  },
  listen: async (_channel: string, handler: (payload: unknown) => void) => {
    bridge.handlers.push(handler);
    return () => {};
  }
}));

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
  });

  afterEach(() => {
    vi.useRealTimers();
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
