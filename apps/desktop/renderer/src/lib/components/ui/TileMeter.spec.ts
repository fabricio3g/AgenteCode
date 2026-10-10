// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import TileMeter from './TileMeter.svelte';
import WritingIndicator from '$lib/features/chat/thread/WritingIndicator.svelte';

afterEach(cleanup);
describe('shared chat rain indicator', () => {
  it.each(['busy', 'attention', 'stopped'] as const)('renders %s with the shared eight-tile pattern', (mode) => {
    const { container } = render(TileMeter, { mode });
    expect(container.querySelectorAll('.tile-rain .tile')).toHaveLength(8);
    expect(container.querySelector(`.tile-rain.is-${mode}`)).not.toBeNull();
    expect(container.querySelector('.tile-rain')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('pending replies preserve a readable status label with decorative rain', () => {
    const { container, getByRole } = render(WritingIndicator, { label: 'Thinking' });
    expect(getByRole('status').getAttribute('aria-label')).toBe('Thinking');
    expect(container.querySelectorAll('.tile-rain .tile')).toHaveLength(8);
    expect(container.querySelector('.feather')).toBeNull();
  });
});
