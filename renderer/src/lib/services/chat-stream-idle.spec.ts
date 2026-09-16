import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamIdleWatchdog, STREAM_IDLE_TIMEOUT_MS, streamIdleTimeoutMessage } from './chat-stream-idle';

describe('createStreamIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after complete silence, exactly once', () => {
    const onStall = vi.fn();
    const idle = createStreamIdleWatchdog({ onStall });

    idle.arm();
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);

    // The stall is terminal for this arm; it must not keep firing.
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS * 2);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('resets while the stream keeps talking', () => {
    const onStall = vi.fn();
    const idle = createStreamIdleWatchdog({ onStall });

    idle.arm();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1000);
      idle.arm(); // an event arrived
    }
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1000);

    expect(onStall).not.toHaveBeenCalled();
  });

  it('clear cancels a pending stall', () => {
    const onStall = vi.fn();
    const idle = createStreamIdleWatchdog({ onStall });

    idle.arm();
    idle.clear();
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS * 2);

    expect(onStall).not.toHaveBeenCalled();
  });

  it('exposes a timeout message the transient-error matcher recognizes', () => {
    expect(streamIdleTimeoutMessage()).toContain('timed out');
  });
});
