import { invoke } from '$lib/services/bridge';
import { toastStore } from '$lib/stores/toast.svelte';
import { saveChatStateToDb } from '$lib/utils/storage';
import { appStore } from '$lib/stores/app.svelte';

export async function openConversationWindow(chatId: string): Promise<void> {
  try {
    const chat = appStore.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error('Conversation no longer exists');
    await saveChatStateToDb(chat);
    appStore.persist({ navigationOnly: true });
    await invoke('window:open-conversation', { chatId });
  } catch (error) { toastStore.error(String(error instanceof Error ? error.message : error)); }
}
