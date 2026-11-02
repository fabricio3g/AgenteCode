// @vitest-environment jsdom
import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { Telescope } from 'lucide-svelte';
import StarterList from './StarterList.svelte';
import type { Starter } from './starter-list';

const starters: Starter[] = [
  { id: 'explain', icon: Telescope, hue: 325, label: 'Explain the codebase', hint: 'A map of the folders' },
  { id: 'bug', icon: Telescope, hue: 8, label: 'Find and fix a bug', hint: 'Reproduces it first', slot: 'symptom or file', key: 'Ctrl Alt 2' }
];

describe('starter list', () => {
  it('renders the rows look by default: hint, slot and key on the row', () => {
    const view = render(StarterList, { starters, label: 'Try one of these', onpick: vi.fn() });
    expect(view.getByLabelText('Try one of these')).toBeTruthy();
    expect(view.getByText('A map of the folders')).toBeTruthy();
    expect(view.getByText('symptom or file')).toBeTruthy();
    expect(view.getByText('Ctrl Alt 2')).toBeTruthy();
  });

  /* The links variant is the composer's own sentence: labels and separators,
     never the hint, the blank or the key — and no heading on screen either, so
     `label` names the group for assistive tech only. */
  it('renders the links look as one line of labels, without the row tokens', () => {
    const view = render(StarterList, { starters, label: 'Try one of these', onpick: vi.fn(), variant: 'links' });
    expect(view.getByRole('navigation', { name: 'Try one of these' })).toBeTruthy();
    expect(view.queryByText('Try one of these')).toBeNull();
    expect(view.getByRole('button', { name: 'Explain the codebase' })).toBeTruthy();
    expect(view.queryByText('A map of the folders')).toBeNull();
    expect(view.queryByText('symptom or file')).toBeNull();
    expect(view.queryByText('Ctrl Alt 2')).toBeNull();
    expect(view.getAllByText('·').length).toBe(1);
  });

  it('reports the picked starter whichever look it is drawn in', async () => {
    const onpick = vi.fn();
    const links = render(StarterList, { starters, label: 'Try one of these', onpick, variant: 'links' });
    await fireEvent.click(links.getByRole('button', { name: 'Find and fix a bug' }));
    expect(onpick).toHaveBeenCalledWith('bug');
    links.unmount();
    const rows = render(StarterList, { starters, label: 'Try one of these', onpick });
    await fireEvent.click(rows.getByRole('button', { name: /Explain the codebase/ }));
    expect(onpick).toHaveBeenCalledWith('explain');
  });

  /* The hint the row look prints has nowhere to live in a line of links: it
     rides on a tooltip. Anything else would change the line's height on hover,
     which is what moved the link out from under the pointer and made the
     composer flicker. */
  it('keeps each hint out of the line, on the link\'s tooltip anchor', () => {
    const view = render(StarterList, { starters, label: 'Try one of these', onpick: vi.fn(), variant: 'links' });
    const link = view.getByRole('button', { name: 'Explain the codebase' });
    expect(link.parentElement?.className).toContain('tooltip-anchor');
    expect(view.container.textContent).not.toContain('A map of the folders');
  });
});
