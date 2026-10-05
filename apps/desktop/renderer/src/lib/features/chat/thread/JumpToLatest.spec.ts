// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JumpToLatest from './JumpToLatest.svelte';

afterEach(cleanup);

describe('jump to latest button', () => {
  it('is a labelled button that jumps where it says', async () => {
    const onclick = vi.fn();
    const view = render(JumpToLatest, { onclick });
    const button = view.getByRole('button', { name: 'Jump to latest' });
    expect(button.getAttribute('title')).toBe('Jump to latest');
    await fireEvent.click(button);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('wears the arrow while nothing is running, and no meter at all', () => {
    const view = render(JumpToLatest, { onclick: () => {} });
    expect(view.container.querySelector('.arrow')).not.toBeNull();
    expect(view.container.querySelector('.tile-rain')).toBeNull();
    expect(view.container.querySelector('.jump-latest')!.classList.contains('is-working')).toBe(false);
  });

  it('wears the meter while a run is working, and keeps the arrow for the pointer', () => {
    const view = render(JumpToLatest, { working: true, mode: 'busy', onclick: () => {} });
    expect(view.container.querySelector('.tile-rain.is-busy')).not.toBeNull();
    // The swap is the stylesheet's job, so both glyphs stay in the DOM: hovering
    // reveals the arrow without a re-render.
    expect(view.container.querySelector('.arrow')).not.toBeNull();
    expect(view.container.querySelector('.jump-latest')!.classList.contains('is-working')).toBe(true);
  });

  it('passes the mode through, so a stalled run, an approval and a stop all read differently', () => {
    for (const [mode, expected] of [['quiet', '.tile-rain:not(.is-busy):not(.is-attention):not(.is-stopped)'], ['attention', '.tile-rain.is-attention'], ['stopped', '.tile-rain.is-stopped']] as const) {
      const view = render(JumpToLatest, { working: true, mode, onclick: () => {} });
      expect(view.container.querySelector(expected), mode).not.toBeNull();
      view.unmount();
    }
  });

  it('separates the surface it sits on: chrome on the composer, floating over a transcript', () => {
    const chrome = render(JumpToLatest, { onclick: () => {} });
    expect(chrome.container.querySelector('.jump-latest')!.classList.contains('is-chrome')).toBe(true);
    chrome.unmount();

    const floating = render(JumpToLatest, { variant: 'float', class: 'pointer-events-auto', onclick: () => {} });
    const button = floating.container.querySelector('.jump-latest')!;
    expect(button.classList.contains('is-float')).toBe(true);
    expect(button.classList.contains('pointer-events-auto')).toBe(true);
  });
});
