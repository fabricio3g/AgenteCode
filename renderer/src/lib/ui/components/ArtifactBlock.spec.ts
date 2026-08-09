// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArtifactBlock from './ArtifactBlock.svelte';

afterEach(cleanup);

describe('ArtifactBlock', () => {
  it('gives previewable artifacts a consistent studio action', async () => {
    const onOpen = vi.fn();
    const view = render(ArtifactBlock, {
      props: {
        artifact: { title: 'Landing page', files: { 'index.html': '<h1>Hello</h1>' } },
        onOpen
      }
    });
    expect(view.getByText('Landing page')).toBeTruthy();
    expect(view.getByTitle('Landing page')).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Open artifact studio' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('keeps file-only artifacts actionable instead of rendering an empty surface', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: { title: 'Sources', files: { 'data.bin': 'raw-data' } },
        onOpen: vi.fn()
      }
    });
    expect(view.getByText('Source files are ready')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Open artifact studio' })).toBeTruthy();
  });

  it('shows a recovery message for invalid artifacts', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: { title: 'Broken', files: {} },
        onOpen: vi.fn()
      }
    });
    expect(view.getByText('Artifact could not be rendered')).toBeTruthy();
  });
});
