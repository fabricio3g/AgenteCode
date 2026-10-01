// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./bridge', () => ({ isElectron: () => true, invoke: vi.fn(async () => ({ ok: true })) }));
const editor = vi.hoisted(() => ({ factory: vi.fn(), diagnostics: vi.fn(), dispose: vi.fn() }));
vi.mock('monaco-editor', () => ({
  editor: { createModel: () => ({ uri: { toString: () => 'file:///smoke.ts' }, dispose: editor.dispose }) },
  typescript: { getTypeScriptWorker: editor.factory }
}));
import { invoke } from './bridge';
import { notifyDesktopReady } from './desktop-startup';
describe('packaged readiness', () => {
  beforeEach(() => { vi.clearAllMocks(); delete document.documentElement.dataset.desktopReady; });
  afterEach(() => { history.replaceState({}, '', '/'); vi.unstubAllGlobals(); });
  it('requires configuration IPC before announcing readiness', async () => {
    await notifyDesktopReady();
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(['get_config', 'desktop_renderer_ready']);
    expect(document.documentElement.dataset.desktopReady).toBe('true');
  });
  it('never announces success when configuration IPC fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('preload unavailable'));
    await expect(notifyDesktopReady()).rejects.toThrow('preload unavailable');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.desktopReady).toBeUndefined();
  });
  it('waits for language registration and a responding packaged worker', async () => {
    history.replaceState({}, '', '/?smoke=1');
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    editor.factory.mockRejectedValueOnce('TypeScript not registered!').mockResolvedValueOnce(async () => ({ getSyntacticDiagnostics: editor.diagnostics }));
    await notifyDesktopReady();
    expect(editor.factory).toHaveBeenCalledTimes(2);
    expect(editor.diagnostics).toHaveBeenCalledWith('file:///smoke.ts');
    expect(editor.dispose).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenLastCalledWith('desktop_renderer_ready', { worker: true });
  });
  it('fails smoke readiness when the editor worker fails', async () => {
    history.replaceState({}, '', '/?smoke=1');
    editor.factory.mockRejectedValueOnce(new Error('Worker asset missing'));
    await expect(notifyDesktopReady()).rejects.toThrow('Worker asset missing');
    expect(editor.dispose).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
