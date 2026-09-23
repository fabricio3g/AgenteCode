// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DocxViewer from './DocxViewer.svelte';

afterEach(cleanup);

function docxDataUrl(): string {
  const bytes = readFileSync(join(__dirname, '__fixtures__/tables.docx'));
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${bytes.toString('base64')}`;
}

/**
 * The viewer previously reported "Converting document…" forever on a real
 * document. This mounts the component with the same data-URL shape the chat
 * reader passes and asserts the pages actually land — so a load that never
 * settles fails here instead of in front of the user.
 */
describe('DocxViewer', () => {
  it('renders pages from a data URL and leaves the loading state', async () => {
    const view = render(DocxViewer, {
      props: { src: docxDataUrl(), filename: 'tables.docx' }
    });

    await waitFor(() => {
      expect(view.container.querySelector('section.docx')).not.toBeNull();
    }, { timeout: 15_000 });
    expect(view.queryByText('Converting document…')).toBeNull();
  }, 30_000);
});
