import { describe, expect, it, vi } from 'vitest';
import {
  createBufferedStreamDispatcher,
  normalizeStreamingContentDelta,
  normalizeStreamingReasoningDelta
} from './streaming';

describe('streaming helpers', () => {
  it('normalizes reasoning deltas consistently', () => {
    expect(normalizeStreamingReasoningDelta('alpha\r\n|\r\n\r\n\r\nbeta')).toBe('alpha\n\nbeta');
  });

  it('preserves content while normalizing newlines', () => {
    expect(normalizeStreamingContentDelta('hello\r\nworld')).toBe('hello\nworld');
  });

  it('buffers small deltas before emitting them', async () => {
    vi.useFakeTimers();
    const content = vi.fn();
    const reasoning = vi.fn();
    const dispatcher = createBufferedStreamDispatcher({
      onContent: content,
      onReasoning: reasoning,
      delayMs: 40
    });

    dispatcher.pushContent('Hel');
    dispatcher.pushContent('lo');
    dispatcher.pushReasoning('A');
    dispatcher.pushReasoning('B');

    expect(content).not.toHaveBeenCalled();
    expect(reasoning).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40);

    expect(content).toHaveBeenCalledWith('Hello');
    expect(reasoning).toHaveBeenCalledWith('AB');
    dispatcher.dispose();
    vi.useRealTimers();
  });
});
