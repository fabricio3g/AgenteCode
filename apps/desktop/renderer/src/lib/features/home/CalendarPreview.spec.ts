// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { addTodo } from '$lib/services/home-productivity';
import CalendarPreview from './CalendarPreview.svelte';

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

it('shows the current month and marks dates with local tasks', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 5, 12));
  addTodo({ text: 'Review the draft', due: '2026-11-06' });
  const view = render(CalendarPreview);
  expect(screen.getByText('November 2026')).toBeTruthy();
  expect(view.container.querySelector('.current')?.textContent?.trim()).toBe('5');
  expect(screen.getByText('6').querySelector('.dot')).toBeTruthy();
});
