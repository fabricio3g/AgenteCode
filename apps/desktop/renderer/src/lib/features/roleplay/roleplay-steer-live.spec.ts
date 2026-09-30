// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/services/chat-api', async (original) => ({
  ...(await original<typeof import('$lib/services/chat-api')>()),
  streamAssistantReply: vi.fn(async ({ onChunk }: { onChunk: (value: string) => void }) => { onChunk(' away'); onChunk(' slowly.'); }),
  completeAssistantReply: vi.fn(async () => ({ content: 'Kai: "I follow her."', usage: null }))
}));

const { appStore } = await import('$lib/stores/app.svelte');
const { roleplayStore } = await import('./roleplay.svelte');
const { charactersStore } = await import('./characters.svelte');
const { emptyCharacter } = await import('$lib/services/character-card');

describe('Continue and Write for me', () => {
  beforeEach(() => {
    localStorage.clear();
    charactersStore.characters = [];
    appStore.chats = [];
    appStore.activeRunsByChat = {};
    appStore.composer = '';
    // No provider is configured in tests; the model itself is mocked above.
    vi.spyOn(appStore as unknown as { canStartGeneration: () => boolean }, 'canStartGeneration').mockReturnValue(true);
  });

  async function scene() {
    const ren = emptyCharacter({ id: 'ren', name: 'Ren' });
    await charactersStore.save(ren);
    const chat = roleplayStore.startScene({ characters: [ren], openingSource: 'none' })!;
    appStore.appendMessageToChat(chat.id, { id: 'u', role: 'user', content: 'Ren?', createdAt: 1, done: true });
    appStore.appendMessageToChat(chat.id, { id: 'r', role: 'assistant', content: 'She turned', createdAt: 2, done: true, status: 'idle', speakerId: 'ren', versions: [{ content: 'She turned', createdAt: 2 }], activeVersion: 0 });
    return chat;
  }

  it('continues the last reply in place, in the same version', async () => {
    await scene();
    await appStore.continueMessage('r');
    const reply = appStore.currentChat!.messages.at(-1)!;
    expect(reply.content).toBe('She turned away slowly.');
    expect(reply.versions).toHaveLength(1);
    expect(reply.versions?.[0].content).toBe('She turned away slowly.');
    expect(reply.status).toBe('idle');
  });

  it('only continues the latest reply', async () => {
    await scene();
    await appStore.continueMessage('u');
    expect(appStore.currentChat!.messages.at(-1)!.content).toBe('She turned');
  });

  it('drafts your next line into the composer without sending it', async () => {
    await scene();
    const send = vi.spyOn(appStore, 'sendCurrentMessage');
    appStore.userName = 'Kai';
    await roleplayStore.impersonate();
    expect(appStore.composer).toBe('I follow her.');
    expect(send).not.toHaveBeenCalled();
  });
});
