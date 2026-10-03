// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from './app.svelte';
import type { ChatSession } from '$lib/types/chat';

beforeEach(() => {
  appStore.activeRunsByChat = {};
  appStore.chats = ['one', 'two'].map(id => ({ id, title: id, contextMode: 'home', createdAt: 1, updatedAt: 1, folderId: null, draft: '', messages: [] } satisfies ChatSession));
  appStore.currentChatId = 'one';
  appStore.composer = '';
  appStore.pendingAttachments = [];
});

describe('Home conversation queue', () => {
  it('queues Enter without a bubble, permits edits, and a second Enter interrupts only its owner', async () => {
    const owner = new AbortController();
    const other = new AbortController();
    appStore.activeRunsByChat = {
      one: { controller: owner, messageId: 'first', backendMode: 'api', mode: 'agent', startedAt: 1 },
      two: { controller: other, messageId: 'second', backendMode: 'api', mode: 'agent', startedAt: 1 }
    };
    appStore.composer = 'Follow-up prompt';
    appStore.pendingAttachments = [{ id: 'media', name: 'evidence.png', size: 1, type: 'image/png', kind: 'image', base64: 'data:image/png;base64,fixture' }];
    await appStore.sendCurrentMessage();
    const chat = appStore.chats[0]!;
    expect(chat.messages).toEqual([]);
    expect(chat.pendingPrompts?.[0]?.attachments?.[0]?.id).toBe('media');
    expect(appStore.composer).toBe('');
    expect(owner.signal.aborted).toBe(false);
    appStore.updateQueuedPrompt('one', chat.pendingPrompts![0]!.id, 'Edited follow-up');
    expect(chat.pendingPrompts![0]!.content).toBe('Edited follow-up');
    await appStore.sendCurrentMessage();
    expect(owner.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(chat.messages).toEqual([]);
    expect(appStore.removeQueuedPrompt('one', chat.pendingPrompts![0]!.id)?.content).toBe('Edited follow-up');
    expect(chat.pendingPrompts).toEqual([]);
  });
});
