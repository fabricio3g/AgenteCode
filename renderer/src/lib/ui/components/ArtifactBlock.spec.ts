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

  it('hides the backing JSON file card for inline info cards', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: {
          title: 'weather-card.json',
          files: {
            'weather-card.json': JSON.stringify({
              kind: 'info_card',
              title: 'Paris',
              rows: [{ label: 'Temperature', value: '18°C' }]
            })
          },
          inline: {
            kind: 'info_card',
            title: 'Paris',
            rows: [{ label: 'Temperature', value: '18°C' }]
          },
          manifest: {
            schemaVersion: 1,
            kind: 'info_card',
            presentation: 'inline',
            entryPath: 'weather-card.json',
            status: 'ready'
          }
        },
        onOpen: vi.fn()
      }
    });
    // The card preview itself still renders…
    expect(view.getByText('Paris')).toBeTruthy();
    // …but the storage file never surfaces: no filename, no file chrome.
    expect(view.queryByText('weather-card.json')).toBeNull();
    expect(view.queryByRole('button', { name: 'Open artifact studio' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Download artifact' })).toBeNull();
  });

  it('renders a single document without a duplicate file-card header', () => {
    const onOpen = vi.fn();
    const view = render(ArtifactBlock, {
      props: {
        artifact: {
          title: 'example_document.docx',
          files: {
            'example_document.docx':
              'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA'
          },
          manifest: {
            schemaVersion: 1,
            kind: 'document',
            presentation: 'document',
            entryPath: 'example_document.docx',
            status: 'ready'
          }
        },
        onOpen
      }
    });
    // The filename surfaces once, in the document tile — not twice.
    expect(view.queryAllByText('example_document.docx')).toHaveLength(1);
    expect(view.queryByRole('button', { name: 'Open artifact studio' })).toBeNull();
    // The tile offers exactly one open (the reader); studio lives in the
    // reader header, so no second open button sits beside download.
    expect(view.getByRole('button', { name: 'Download example_document.docx' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Open in artifact studio' })).toBeNull();
  });

  it('keeps the file-card header when several documents share one artifact', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: {
          title: 'Two docs',
          files: {
            'a.docx': 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA',
            'b.docx': 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA'
          },
          manifest: {
            schemaVersion: 1,
            kind: 'document',
            presentation: 'document',
            entryPath: 'a.docx',
            status: 'ready'
          }
        },
        onOpen: vi.fn()
      }
    });
    expect(view.getByRole('button', { name: 'Open artifact studio' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Open in artifact studio' })).toBeNull();
  });
});
