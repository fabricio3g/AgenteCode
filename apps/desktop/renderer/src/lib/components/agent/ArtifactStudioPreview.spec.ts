// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ArtifactStudioPreview from './ArtifactStudioPreview.svelte';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }), destroy: () => Promise.resolve() })
}));
afterEach(cleanup);

it('routes saved PDF artifacts to the PDF viewer instead of a blocked nested iframe', async () => {
  const view = render(ArtifactStudioPreview, { artifact: {
    title: 'Report',
    files: { 'report.pdf': 'data:application/pdf;base64,JVBERi0=' },
    previewHtml: '<iframe src="data:application/pdf;base64,JVBERi0="></iframe>'
  } });
  await waitFor(() => expect(view.container.querySelector('.pdf-viewer')).toBeTruthy());
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(view.queryByRole('button', { name: 'Run preview' })).toBeNull();
});
