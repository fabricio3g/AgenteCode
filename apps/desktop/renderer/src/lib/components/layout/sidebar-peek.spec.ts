// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEEK_CLOSE_MS, PEEK_OPEN_MS, SidebarPeek } from './sidebar-peek.svelte';

describe('sidebar hover preview', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
  });
  afterEach(() => vi.useRealTimers());

  const leaveTo = (peek: SidebarPeek) => peek.leave({ relatedTarget: null } as unknown as PointerEvent);

  it('opens after a short hover and closes a moment after leaving', () => {
    const peek = new SidebarPeek(() => false, () => now);
    peek.show();
    expect(peek.open).toBe(false);
    vi.advanceTimersByTime(PEEK_OPEN_MS);
    expect(peek.open).toBe(true);
    leaveTo(peek);
    vi.advanceTimersByTime(PEEK_CLOSE_MS - 1);
    expect(peek.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(peek.open).toBe(false);
  });

  it('a quick pass over the toggle does not open it', () => {
    const peek = new SidebarPeek(() => false, () => now);
    peek.show();
    leaveTo(peek);
    vi.advanceTimersByTime(PEEK_OPEN_MS + PEEK_CLOSE_MS);
    expect(peek.open).toBe(false);
  });

  it('never previews when pinned, or right after the toggle was clicked', () => {
    const pinned = new SidebarPeek(() => true, () => now);
    pinned.show();
    vi.advanceTimersByTime(PEEK_OPEN_MS);
    expect(pinned.open).toBe(false);

    const peek = new SidebarPeek(() => false, () => now);
    peek.toggled();
    peek.show();
    vi.advanceTimersByTime(PEEK_OPEN_MS);
    expect(peek.open).toBe(false);
    now += 300;
    peek.show();
    vi.advanceTimersByTime(PEEK_OPEN_MS);
    expect(peek.open).toBe(true);
  });
});
