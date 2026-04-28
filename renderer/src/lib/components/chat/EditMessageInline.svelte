<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { Check, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    messageId: string;
    initialContent: string;
    role: 'user' | 'assistant';
    onCancel: () => void;
  }

  let { messageId, initialContent, role, onCancel }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined;
  let content = $state(initialContent);

  function save() {
    if (!content.trim()) return;
    const chat = appStore.currentChat;
    if (!chat) return;
    const message = chat.messages.find((entry) => entry.id === messageId);
    if (!message) return;

    if (message.role === 'user') {
      message.content = content.trim();
    } else {
      if (message.activeVersion !== undefined && message.versions?.[message.activeVersion]) {
        message.versions[message.activeVersion].content = content.trim();
      } else {
        message.content = content.trim();
      }
    }

    chat.updatedAt = Date.now();
    appStore.editingMessageId = null;
    appStore.editingMessageContent = '';
    appStore.touchChats();
    appStore.persist();
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<div transition:fade={{ duration: 150 }} class="rounded-xl border border-[var(--border-hover)] bg-[var(--surface)] overflow-hidden">
  <div class="p-3">
    <textarea
      bind:this={textarea}
      class="w-full min-h-[80px] max-h-[320px] resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]"
      value={content}
      oninput={(e) => content = (e.currentTarget as HTMLTextAreaElement).value}
      onkeydown={onKeydown}
      autofocus
    ></textarea>

    <div class="flex items-center justify-end gap-2 mt-3">
      <span class="mr-auto text-xs text-[var(--text-muted)]">Esc to cancel</span>
      <button class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]" onclick={onCancel}>
        <X class="h-3 w-3" />
        Cancel
      </button>
      <button class="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition hover:opacity-90" onclick={save}>
        <Check class="h-3.5 w-3.5" />
        Save
      </button>
    </div>
  </div>
</div>
