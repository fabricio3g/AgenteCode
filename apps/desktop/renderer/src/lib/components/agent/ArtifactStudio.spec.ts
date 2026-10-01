// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SourceEditor from '$lib/features/chat/viewers/__fixtures__/SourceEditor.svelte';
import ArtifactStudioModal from './ArtifactStudioModal.svelte';
const state = vi.hoisted(() => ({
  appStore: { currentArtifact: { title: 'Notes', files: { 'notes.md': '# Original notes' }, manifest: { schemaVersion: 1, kind: 'document', presentation: 'document', entryPath: 'notes.md', status: 'ready' } }, currentChatId: 'chat', currentArtifactMessageId: 'message', artifactStudioOpen: true, saveArtifactToMessage: vi.fn(() => true) },
  confirm: vi.fn(), toast: vi.fn()
}));
vi.mock('$lib/stores/app.svelte', () => ({ appStore: state.appStore }));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmStore: { show: state.confirm } }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: { success: state.toast, error: state.toast } }));
vi.mock('$lib/ui/components/CodeEditor.svelte', () => ({ default: SourceEditor }));
beforeEach(() => {
  state.appStore.artifactStudioOpen = true;
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function action(label: string) {
  await fireEvent.click(screen.getByRole('button', { name: 'More' }));
  await fireEvent.click(await screen.findByRole('menuitem', { name: label }));
}
describe('document artifact studio', () => {
  it('uses one toolbar, keeps source in the menu, and preserves save/discard', async () => {
    const view = render(ArtifactStudioModal);
    expect(view.container.ownerDocument.querySelectorAll('.viewer-toolbar')).toHaveLength(1);
    await action('Source');
    const source = await view.findByRole('textbox', { name: 'Source editor' });
    await fireEvent.input(source, { target: { value: '# Changed notes' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Save' }));
    expect(state.appStore.saveArtifactToMessage).toHaveBeenCalledWith('chat', 'message', expect.objectContaining({ files: { 'notes.md': '# Changed notes' } }));
    await fireEvent.input(source, { target: { value: '# Unsaved' } });
    await action('Discard');
    await waitFor(() => expect((source as HTMLTextAreaElement).value).toBe('# Changed notes'));
  });
  it('asks before closing a dirty document through its toolbar', async () => {
    const view = render(ArtifactStudioModal);
    await action('Source');
    await fireEvent.input(await view.findByRole('textbox', { name: 'Source editor' }), { target: { value: '# Unsaved' } });
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.appStore.artifactStudioOpen).toBe(true);
    state.confirm.mock.calls[0][0].onConfirm();
    expect(state.appStore.artifactStudioOpen).toBe(false);
  });
});
