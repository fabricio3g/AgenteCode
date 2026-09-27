import { describe, expect, it, vi } from 'vitest';
import { createAutosaveController, type AutosaveSnapshot } from './autosave';

describe('createAutosaveController', () => {
  it('debounces changes and persists only the latest value', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const states: AutosaveSnapshot<number>[] = [];
    const controller = createAutosaveController<number>(save, (state) => states.push(state));

    controller.schedule(1);
    controller.schedule(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(2);
    expect(states.at(-1)?.state).toBe('saved');
    controller.dispose();
    vi.useRealTimers();
  });

  it('serializes stale requests so the newest write wins', async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    const save = vi.fn((value: number) => {
      if (value === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
      return Promise.resolve();
    });
    const states: AutosaveSnapshot<number>[] = [];
    const controller = createAutosaveController(save, (state) => states.push(state), 10);

    controller.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    controller.schedule(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(states.at(-1)).toMatchObject({ state: 'saved', value: 2 });
    controller.dispose();
    vi.useRealTimers();
  });

  it('keeps failed values for retry and supports blocked state', async () => {
    vi.useFakeTimers();
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const states: AutosaveSnapshot<string>[] = [];
    const controller = createAutosaveController(save, (state) => states.push(state), 10);

    controller.schedule('draft');
    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toMatchObject({ state: 'error', error: 'offline', value: 'draft' });

    controller.retry();
    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toMatchObject({ state: 'saved', value: 'draft' });

    controller.block('Choose one engine', 'empty');
    expect(states.at(-1)).toMatchObject({ state: 'blocked', error: 'Choose one engine', value: 'empty' });
    controller.dispose();
    vi.useRealTimers();
  });
});
