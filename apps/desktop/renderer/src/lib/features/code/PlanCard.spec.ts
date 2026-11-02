// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import PlanCard from './PlanCard.svelte';

afterEach(cleanup);

it('shows truthful progress without counting cancelled work as completed', () => {
  const view = render(PlanCard, { props: { todos: [
    { content: 'Done', status: 'completed' },
    { content: 'Next', status: 'pending' },
    { content: 'Superseded', status: 'cancelled' }
  ] } });
  expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  expect(view.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('2');
  expect(view.getByText('Superseded').closest('li')?.getAttribute('title')).toBe('Cancelled');
});
