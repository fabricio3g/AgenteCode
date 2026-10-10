import { describe, expect, it, vi } from 'vitest';
import type { DesignFiles, DesignVersion } from '$shared/design';
import { DesignWorkspaceController } from './design-workspace.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const files = (text: string): DesignFiles => ({ files: { 'index.html': text }, pages: ['index.html'], variants: [] });

describe('design workspace request ownership', () => {
  it('keeps the newer refresh loading and rejects an older same-workspace result', async () => {
    const old = deferred<DesignFiles>();
    const next = deferred<DesignFiles>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const workspace = new DesignWorkspaceController({ read, versions: async () => [] });
    workspace.reset('design-1');
    const first = workspace.refresh();
    const second = workspace.refresh();
    old.resolve(files('old'));
    expect(await first).toBe(false);
    expect(workspace.loading).toBe(true);
    next.resolve(files('new'));
    expect(await second).toBe(true);
    expect(workspace.data.files['index.html']).toBe('new');
    expect(workspace.loading).toBe(false);
  });

  it('rejects a response from an earlier visit even when the same chat is reopened', async () => {
    const pending = deferred<DesignFiles>();
    const workspace = new DesignWorkspaceController({ read: () => pending.promise, versions: async () => [] });
    workspace.reset('design-1');
    const refresh = workspace.refresh();
    workspace.reset(null);
    workspace.reset('design-1');
    pending.resolve(files('previous visit'));
    expect(await refresh).toBe(false);
    expect(workspace.data.pages).toEqual([]);
    expect(workspace.loading).toBe(false);
  });

  it('orders version reads independently and resets them when leaving a design', async () => {
    const old = deferred<DesignVersion[]>();
    const latest = deferred<DesignVersion[]>();
    const versions = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const workspace = new DesignWorkspaceController({ read: async () => files('page'), versions });
    workspace.reset('design-1');
    const first = workspace.refreshVersions();
    const second = workspace.refreshVersions();
    latest.resolve([]);
    await second;
    old.resolve([{ id: 1 } as DesignVersion]);
    await first;
    expect(workspace.versions).toEqual([]);
    workspace.reset(null);
    expect(workspace.chatId).toBeNull();
  });

  it('retains readable content after a transient read failure', async () => {
    const read = vi.fn().mockResolvedValueOnce(files('saved')).mockRejectedValueOnce(new Error('offline'));
    const workspace = new DesignWorkspaceController({ read, versions: async () => [] });
    workspace.reset('design-1');
    await workspace.refresh();
    expect(await workspace.refresh()).toBe(false);
    expect(workspace.data.files['index.html']).toBe('saved');
    expect(workspace.loading).toBe(false);
  });
});
