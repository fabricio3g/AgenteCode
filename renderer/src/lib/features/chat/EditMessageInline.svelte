<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { onMount, tick, untrack } from 'svelte';

  interface Props {
    messageId: string;
    initialContent: string;
    role: 'user' | 'assistant';
    onCancel: () => void;
    onDone?: () => void;
  }

  let { messageId, initialContent, role, onCancel, onDone }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined;
  // Edited draft starts from the message and must not be clobbered if the
  // prop changes while the editor is open (same message is saved on done).
  let content = $state(untrack(() => initialContent));

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
    aria-label={$t('chat.editor.label')}
  ></textarea>

  <div class="edit-footer">
    <span class="edit-hint">{$t('chat.editor.hint')}</span>
    <button class="edit-btn" type="button" onclick={onCancel}>{$t('chat.editor.cancel')}</button>
    <button class="edit-btn is-primary" type="button" onclick={save} disabled={!content.trim()}>{$t('chat.editor.save')}</button>
  </div>
</div>

<style>
  /* The composer's language: one white field with a hairline edge, text
     buttons that say what they do. */
  .edit-card {
    width: 100%;
    padding: 0.75rem 0.75rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 1.25rem;
    background: var(--background);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.03);
    animation: editIn 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    transition: border-color var(--motion-fast) var(--motion-ease), box-shadow var(--motion-fast) var(--motion-ease);
  }

  .edit-card:focus-within {
    border-color: color-mix(in srgb, var(--foreground) 22%, var(--border));
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 4px 14px -6px rgb(0 0 0 / 0.1);
  }

  .edit-input {
    display: block;
    width: 100%;
    min-height: 44px;
    max-height: 300px;
    padding: 0 0.25rem;
    border: 0;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--foreground);
    font-size: 15px;
    line-height: 1.55;
    scrollbar-width: thin;
  }

  .edit-footer {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.4rem;
  }

  .edit-hint {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    padding-left: 0.25rem;
    color: var(--muted-foreground);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .edit-btn {
    height: 2rem;
    padding: 0 0.85rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }

  .edit-btn:hover:not(:disabled) {
    background: var(--muted);
    color: var(--foreground);
  }

  .edit-btn.is-primary {
    background: var(--foreground);
    color: var(--background);
  }

  .edit-btn.is-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--foreground) 88%, var(--background));
    color: var(--background);
  }

  .edit-btn:disabled {
    cursor: default;
    opacity: 0.35;
  }

  @keyframes editIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .edit-card { animation: none; }
  }
</style>
