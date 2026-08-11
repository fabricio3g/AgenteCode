import { describe, expect, it } from 'vitest';
import { approvalsStore } from './approvals.svelte';

function req(id: string, chatId = 'c1') {
  return approvalsStore.request({ id, chatId, command: 'ls -la', cwd: '/tmp' });
}

describe('approvalsStore', () => {
  it('settles the promise when the user answers', async () => {
    const pending = req('a1');
    expect(approvalsStore.forChat('c1')).toHaveLength(1);

    approvalsStore.resolve('a1', true);
    await expect(pending).resolves.toBe(true);
    expect(approvalsStore.forChat('c1')).toHaveLength(0);
  });

  it('keeps both approvals alive when two callers pick the same id', async () => {
    /*
     * Callers mint ids like `bash-<Date.now()>-<4 random chars>`, so two parallel
     * `bash` calls in one batch can collide. The second `request` used to overwrite
     * the first's resolver, so that first promise could never settle — the agent
     * waited forever on an approval nothing could answer — and the duplicate id was
     * also a duplicate key in the UI's keyed `{#each}`.
     */
    const first = req('dup', 'chat-dup');
    const second = req('dup', 'chat-dup');

    const ids = approvalsStore.forChat('chat-dup').map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    for (const id of ids) approvalsStore.resolve(id, true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(approvalsStore.forChat('chat-dup')).toHaveLength(0);
  });

  it('scopes lookups to a chat, so a step id is never needed to find one', async () => {
    const a = req('a2', 'chat-a');
    const b = req('a3', 'chat-b');

    expect(approvalsStore.forChat('chat-a').map((i) => i.id)).toEqual(['a2']);
    expect(approvalsStore.forChat('chat-b').map((i) => i.id)).toEqual(['a3']);

    approvalsStore.resolve('a2', true);
    approvalsStore.resolve('a3', false);
    await Promise.all([a, b]);
  });

  it('denies and drops everything pending when a run is torn down', async () => {
    const pending = req('a4', 'chat-c');
    approvalsStore.clearForChat('chat-c');

    // Without this the agent would await a promise nothing could ever settle.
    await expect(pending).resolves.toBe(false);
    expect(approvalsStore.forChat('chat-c')).toHaveLength(0);
  });

  it('ignores an unknown id', () => {
    expect(() => approvalsStore.resolve('nope', true)).not.toThrow();
  });

  it('leaves other chats untouched when one is cleared', async () => {
    const keep = req('a5', 'chat-keep');
    const drop = req('a6', 'chat-drop');

    approvalsStore.clearForChat('chat-drop');
    await expect(drop).resolves.toBe(false);
    expect(approvalsStore.forChat('chat-keep')).toHaveLength(1);

    approvalsStore.resolve('a5', true);
    await expect(keep).resolves.toBe(true);
  });
});
