// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/svelte';
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
  it('keeps three previews in the draft and offers the rest in the gallery', () => {
    appStore.pendingAttachments = Array.from({ length: 9 }, (_, index) => pdf(index));
    const view = render(AttachmentCards);

    expect(view.getAllByRole('button', { name: /^Preview file-/ })).toHaveLength(3);
    expect(view.getByRole('button', { name: 'View all 9 attachments' })).toBeTruthy();
  });

  it('shows every card when nothing is hidden', () => {
    appStore.pendingAttachments = [pdf(1), pdf(2)];
    const view = render(AttachmentCards);

    expect(view.getAllByRole('button', { name: /^Preview file-/ })).toHaveLength(2);
    expect(view.queryByRole('button', { name: /^View all/ })).toBeNull();
  });
});
