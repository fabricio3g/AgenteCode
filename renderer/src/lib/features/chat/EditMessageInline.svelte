<svelte:options runes={true} />

<script lang="ts">
  import { Check, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { onMount, tick } from 'svelte';

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

  const minHeight = 44;
  const maxHeight = 300;

  function resizeTextarea() {
    if (!textarea) return;
    textarea.style.height = `${minHeight}px`;
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  onMount(() => {
    const timer = setTimeout(async () => {
      await tick();
      resizeTextarea();
      textarea?.focus({ preventScroll: true });
      const len = textarea?.value.length || 0;
      textarea?.setSelectionRange(len, len);
    }, 30);
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

  function handleInput(event: Event) {
    content = (event.currentTarget as HTMLTextAreaElement).value;
    resizeTextarea();
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

<div class={`edit-card ${role === 'user' ? 'is-user' : 'is-assistant'}`}>
  <textarea
    bind:this={textarea}
    class="edit-input"
    value={content}
    rows="1"
    oninput={handleInput}
    onkeydown={onKeydown}
    aria-label="Edit message"
  ></textarea>

  <div class="edit-footer">
    <span class="edit-hint">Esc cancel · Ctrl/⌘ Enter save</span>
    <div class="edit-actions">
      <button class="edit-action" type="button" onclick={onCancel} aria-label="Cancel edit" title="Cancel">
        <X class="h-3.5 w-3.5" />
      </button>
      <button class="edit-action is-primary" type="button" onclick={save} disabled={!content.trim()} aria-label="Save edit" title="Save">
        <Check class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</div>

<style>
  .edit-card {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--surface) 92%, var(--chat-bg));
    box-shadow: var(--shadow-xs);
    padding: 0.5rem;
    animation: editScaleIn 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
  }

  .edit-card:focus-within {
    border-color: color-mix(in srgb, var(--border-hover) 76%, transparent);
    background: color-mix(in srgb, var(--surface) 96%, var(--chat-bg));
    box-shadow: var(--shadow-sm);
  }

  .edit-card.is-user {
    background: color-mix(in srgb, var(--user-bubble, var(--primary)) 10%, var(--surface));
  }

  .edit-input {
    display: block;
    width: 100%;
    min-height: 44px;
    max-height: 300px;
    resize: none;
    border: 0;
    outline: none;
    border-radius: 0.7rem;
    background: transparent;
    color: var(--text);
    padding: 0.55rem 0.65rem;
    font-size: 14px;
    line-height: 1.5;
    transition: height 160ms cubic-bezier(0.2, 0.8, 0.2, 1), background 0.14s ease;
    scrollbar-width: thin;
  }

  .edit-input:focus {
    background: color-mix(in srgb, var(--surface-hover) 42%, transparent);
  }

  .edit-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.25rem 0 0.55rem;
  }

  .edit-hint {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .edit-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .edit-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.8rem;
    height: 1.8rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease, opacity 0.14s ease;
  }

  .edit-action:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
    transform: translateY(-1px);
  }

  .edit-action.is-primary {
    background: var(--primary);
    color: var(--primary-fg);
  }

  .edit-action.is-primary:hover:not(:disabled) {
    filter: brightness(1.03);
  }

  .edit-action:disabled {
    cursor: default;
    opacity: 0.45;
  }

  @keyframes editScaleIn {
    from {
      opacity: 0;
      transform: translateY(3px) scale(0.992);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
</style>
