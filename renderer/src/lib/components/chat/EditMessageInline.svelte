<svelte:options runes={true} />

<script lang="ts">
  import { Check, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { onMount } from 'svelte';

  interface Props {
    messageId: string;
    initialContent: string;
    role: 'user' | 'assistant';
    onCancel: () => void;
    onDone?: () => void;
  }

  let { messageId, initialContent, role, onCancel, onDone }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined;
  let content = $state(initialContent);

  onMount(() => {
    const timer = setTimeout(() => {
      textarea?.focus();
      const len = textarea?.value.length || 0;
      textarea?.setSelectionRange(len, len);
    }, 50);
    return () => clearTimeout(timer);
  });

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
    onDone?.();
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      onDone?.();
    }
  }
</script>

<div class="edit-card overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
  <div class="p-3.5">
    <textarea
      bind:this={textarea}
      class="edit-input w-full min-h-[96px] max-h-[320px] resize-y rounded-xl border border-[var(--border)] bg-transparent px-3 py-2.5 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)]"
      value={content}
      oninput={(e) => content = (e.currentTarget as HTMLTextAreaElement).value}
      onkeydown={onKeydown}
    ></textarea>

    <div class="mt-3 flex items-center justify-end gap-2">
      <span class="mr-auto text-[11px] text-[var(--text-muted)]">Esc to cancel · Ctrl/Cmd+Enter to save</span>
      <button class="edit-btn inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition" onclick={onCancel}>
        <X class="h-3 w-3" />
        Cancel
      </button>
      <button class="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-fg)] transition hover:opacity-90" onclick={save}>
        <Check class="h-3.5 w-3.5" />
        Save
      </button>
    </div>
  </div>
</div>

<style>
  .edit-input:focus {
    border-color: var(--border-hover);
    background: color-mix(in srgb, var(--surface-hover) 60%, transparent);
  }

  .edit-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
</style>
