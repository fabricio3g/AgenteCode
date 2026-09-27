// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArtifactBlock from './ArtifactBlock.svelte';

afterEach(cleanup);

const DOCX = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA';

describe('ArtifactBlock', () => {
  it('shows a file artifact as one card that opens it', async () => {
    const onOpen = vi.fn();
    const view = render(ArtifactBlock, {
      props: {
        artifact: { title: 'Landing page', files: { 'index.html': '<h1>Hello</h1>' } },
        onOpen
      }
    });
    expect(view.getByText('Landing page')).toBeTruthy();
    expect(view.getByText('Web page · HTML')).toBeTruthy();
    await fireEvent.click(view.getByTitle('Open'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('keeps file-only artifacts openable and downloadable', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: { title: 'Sources', files: { 'data.bin': 'raw-data' } },
        onOpen: vi.fn()
      }
    });
    expect(view.getByText('Sources')).toBeTruthy();
    expect(view.getByTitle('Open')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('shows a recovery message for invalid artifacts', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: { title: 'Broken', files: {} },
        onOpen: vi.fn()
      }
    });
    expect(view.getByText('This artifact couldn’t be shown')).toBeTruthy();
  });

  it('renders inline cards as the preview itself, with no file chrome', () => {
    const onOpen = vi.fn();
    const view = render(ArtifactBlock, {
      props: {
        artifact: {
          title: 'weather-card.json',
          files: {
            'weather-card.json': JSON.stringify({ kind: 'info_card', title: 'Paris', rows: [{ label: 'Temperature', value: '18°C' }] })
          },
          inline: { kind: 'info_card', title: 'Paris', rows: [{ label: 'Temperature', value: '18°C' }] },
          manifest: { schemaVersion: 1, kind: 'info_card', presentation: 'inline', entryPath: 'weather-card.json', status: 'ready' }
        },
        onOpen
      }
    });
    expect(view.getByText('Paris')).toBeTruthy();
    expect(view.queryByText('weather-card.json')).toBeNull();
    expect(view.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(view.getByRole('button', { name: 'Open full size' })).toBeTruthy();
  });

  it('names a single document once, with its type', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: {
          title: 'example_document.docx',
          files: { 'example_document.docx': DOCX },
          manifest: { schemaVersion: 1, kind: 'document', presentation: 'document', entryPath: 'example_document.docx', status: 'ready' }
        },
        onOpen: vi.fn()
      }
    });
    expect(view.queryAllByText('example_document.docx')).toHaveLength(1);
    expect(view.getByText('Document · DOCX')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('counts files when several documents share one artifact', () => {
    const view = render(ArtifactBlock, {
      props: {
        artifact: {
          title: 'Two docs',
          files: { 'a.docx': DOCX, 'b.docx': DOCX },
          manifest: { schemaVersion: 1, kind: 'document', presentation: 'document', entryPath: 'a.docx', status: 'ready' }
        },
        onOpen: vi.fn()
      }
    });
    expect(view.getByText(/Document · 2 files/)).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
