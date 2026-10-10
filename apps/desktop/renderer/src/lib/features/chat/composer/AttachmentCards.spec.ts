// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import AttachmentCards from './AttachmentCards.svelte';
import { appStore } from '$lib/stores/app.svelte';
import type { Attachment } from '$lib/types/chat';

afterEach(() => {
  cleanup();
  appStore.pendingAttachments = [];
});

function pdf(index: number): Attachment {
  return {
    id: `doc-${index}`,
    name: `file-${index}.pdf`,
    size: 1024,
    type: 'application/pdf',
    kind: 'document',
    status: 'ready'
  };
}

describe('AttachmentCards', () => {
  it('caps the collapsed list and reports the rest', async () => {
    appStore.pendingAttachments = Array.from({ length: 9 }, (_, index) => pdf(index));
    const view = render(AttachmentCards);

    expect(view.getAllByText(/file-\d+\.pdf/).length).toBe(6);
    const chip = view.getByRole('button', { name: '+3 more' });
    await fireEvent.click(chip);

    expect(view.getAllByText(/file-\d+\.pdf/).length).toBe(9);
    expect(view.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('collapses again from the expanded list', async () => {
    appStore.pendingAttachments = Array.from({ length: 8 }, (_, index) => pdf(index));
    const view = render(AttachmentCards);

    await fireEvent.click(view.getByRole('button', { name: '+2 more' }));
    await fireEvent.click(view.getByRole('button', { name: 'Show less' }));

    expect(view.getAllByText(/file-\d+\.pdf/).length).toBe(6);
    expect(view.getByRole('button', { name: '+2 more' })).toBeTruthy();
  });

  it('shows every card when nothing is hidden', () => {
    appStore.pendingAttachments = [pdf(1), pdf(2)];
    const view = render(AttachmentCards);

    expect(view.getAllByText(/file-\d+\.pdf/).length).toBe(2);
    expect(view.queryByRole('button', { name: /more|Show less/ })).toBeNull();
  });
});
