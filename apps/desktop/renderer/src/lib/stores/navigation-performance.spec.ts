// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/utils/storage', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/utils/storage')>(),
  saveChatState: vi.fn(), saveChatStateToDb: vi.fn().mockResolvedValue(undefined)
}));
import { appStore } from './app.svelte';
import { saveChatStateToDb, saveChatState } from '$lib/utils/storage';
import type { ChatSession } from '$lib/types/chat';
beforeEach(() => {
  vi.clearAllMocks();
  appStore.chats = ['one', 'two'].map(id => ({ id, title: id, contextMode: 'home', createdAt: 1, updatedAt: 1, folderId: null, draft: '', searchMode: 'chat', composerMode: 'agent', messages: [] } satisfies ChatSession));
  appStore.currentChatId = 'one'; appStore.activeRunsByChat = {};
  vi.spyOn(appStore, 'refreshModels').mockResolvedValue(undefined);
  vi.spyOn(appStore, 'refreshReasoningCapabilities').mockResolvedValue(undefined);
  // Canonicalize legacy fields and drain dirty chats before measuring navigation.
  appStore.selectChat('one'); appStore.selectChat('two'); vi.clearAllMocks();
});
describe('conversation navigation persistence', () => {
  it('persists selection without resaving unchanged transcripts', () => {
    appStore.selectChat('one'); appStore.selectChat('two');
    expect(saveChatState).toHaveBeenCalledTimes(2);
    expect(saveChatStateToDb).not.toHaveBeenCalled();
    expect(appStore.currentChatId).toBe('two');
  });
  it('still flushes explicitly dirty background chats when navigating', () => {
    appStore.chats[0].title = 'Updated background title'; appStore.markChatDirty('one');
    appStore.selectChat('two');
    expect(saveChatStateToDb).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveChatStateToDb).mock.calls[0][0].id).toBe('one');
  });
});
