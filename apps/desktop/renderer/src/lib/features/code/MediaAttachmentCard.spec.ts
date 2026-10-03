// @vitest-environment jsdom
import { render, waitFor, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
const preview = vi.hoisted(() => vi.fn());
vi.mock('$lib/services/bridge', () => ({ invoke: preview, isElectron: () => false }));
vi.mock('$lib/services/files', () => ({ openWorkspaceFile: vi.fn().mockResolvedValue(undefined) }));
import MediaAttachmentCard from './MediaAttachmentCard.svelte';
const image = { kind: 'image' as const, path: '/stored/evidence.png', name: 'evidence.png', mime: 'image/png', bytes: 1024 };

describe('attachment thumbnails', () => {
  it('renders the imported image preview and a removable filename card', async () => {
    preview.mockResolvedValue('data:image/png;base64,fixture');
    const onremove = vi.fn();
    const view = render(MediaAttachmentCard, { attachment: image, onremove });
    await waitFor(() => expect(view.getByRole('img', { name: 'evidence.png' }).getAttribute('src')).toBe('data:image/png;base64,fixture'));
    expect(preview).toHaveBeenCalledWith('agente_media_preview', { path: image.path });
    await fireEvent.click(view.getByRole('button', { name: 'Remove evidence.png' }));
    expect(onremove).toHaveBeenCalledOnce();
  });
  it('renders other attachment types as a compact file tile', () => {
    const view = render(MediaAttachmentCard, { attachment: { ...image, kind: 'pdf', name: 'report.pdf', mime: 'application/pdf' } });
    expect(view.getByText('report.pdf')).toBeTruthy();
    expect(view.queryByRole('img')).toBeNull();
  });
});
