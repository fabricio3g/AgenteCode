// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const loadChatMessagesFromDb = vi.fn();
vi.mock('$lib/utils/storage', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/utils/storage')>(),
  saveChatState: vi.fn(), saveChatStateToDb: vi.fn().mockResolvedValue(undefined),
  loadChatMessagesFromDb: (...args: unknown[]) => loadChatMessagesFromDb(...args)
}));
import { appStore } from './app.svelte';
import { savePayload } from '$lib/utils/storage';
import type { ChatSession } from '$lib/types/chat';

const codeChat = (): ChatSession => ({ id: 'code', title: 'Code', contextMode: 'code', createdAt: 1, updatedAt: 1, folderId: null, draft: '', searchMode: 'chat', composerMode: 'agent', messagesLoaded: false, messages: [] });

beforeEach(() => {
  loadChatMessagesFromDb.mockReset();
  appStore.chats = [codeChat()];
});

describe('Code transcripts that load on open', () => {
  it('saves an unloaded chat as its row only, never as an empty transcript', () => {
    const payload = savePayload(codeChat());
    expect('messages' in payload).toBe(false);
    expect(payload.title).toBe('Code');
    const loaded = { ...codeChat(), messagesLoaded: undefined, messages: [] };
    expect(savePayload(loaded)).toBe(loaded);
  });

  it('loads once, keeps what was added meanwhile, then reads as loaded', async () => {
    let finish!: (rows: unknown[]) => void;
    loadChatMessagesFromDb.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = appStore.ensureChatMessages('code');
    const second = appStore.ensureChatMessages('code');
    // A message sent while the history was still loading.
    appStore.findChat('code')!.messages.push({ id: 'new', role: 'user', content: 'sent now', createdAt: 9, done: true, status: 'idle' });
    finish([{ id: 'old', role: 'assistant', content: 'history', createdAt: 1, done: true, status: 'idle' }]);
    await Promise.all([first, second]);
    const chat = appStore.findChat('code')!;
    expect(loadChatMessagesFromDb).toHaveBeenCalledTimes(1);
    expect(chat.messages.map(message => message.id)).toEqual(['old', 'new']);
    expect(chat.messagesLoaded).toBeUndefined();
    await appStore.ensureChatMessages('code');
    expect(loadChatMessagesFromDb).toHaveBeenCalledTimes(1);
  });

  it('stays unloaded (so stays safe to save) when loading fails', async () => {
    loadChatMessagesFromDb.mockRejectedValue(new Error('worker gone'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await appStore.ensureChatMessages('code');
    expect(appStore.findChat('code')!.messagesLoaded).toBe(false);
    expect('messages' in savePayload(appStore.findChat('code')!)).toBe(false);
  });
});
