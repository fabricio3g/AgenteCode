// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import TileMeter from './TileMeter.svelte';
import WritingIndicator from '$lib/features/chat/thread/WritingIndicator.svelte';

afterEach(cleanup);
describe('shared chat rain indicator', () => {
  it.each(['busy', 'attention', 'stopped'] as const)('renders %s with the simplified 2x2 four-tile pattern', (mode) => {
    const { container } = render(TileMeter, { mode });
    expect(container.querySelectorAll('.tile-rain .tile')).toHaveLength(4);
    expect(container.querySelector(`.tile-rain.is-${mode}`)).not.toBeNull();
    expect(container.querySelector('.tile-rain')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('pending replies preserve a readable status label with decorative rain', () => {
    const { container, getByRole } = render(WritingIndicator, { label: 'Thinking' });
    expect(getByRole('status').getAttribute('aria-label')).toBe('Thinking');
    expect(container.querySelectorAll('.tile-rain .tile')).toHaveLength(4);
    expect(container.querySelector('.feather')).toBeNull();
  });
  it('a task colour tints the rain and leaves the brand default otherwise', () => {
    const tinted = render(TileMeter, { mode: 'busy', color: 'var(--accent-sky)' });
    const rain = tinted.container.querySelector('.tile-rain')!;
    expect(rain.classList.contains('is-tinted')).toBe(true);
    expect(rain.getAttribute('style')).toContain('--rain-color: var(--accent-sky)');

    cleanup();
    const plain = render(TileMeter, { mode: 'busy' });
    const plainRain = plain.container.querySelector('.tile-rain')!;
    expect(plainRain.classList.contains('is-tinted')).toBe(false);
    expect(plainRain.getAttribute('style')).toBe('');
  });
});
