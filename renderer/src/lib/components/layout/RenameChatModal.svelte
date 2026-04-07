<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { t } from 'svelte-i18n';
  import { Pencil, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    chatId: string;
    currentTitle: string;
    onClose: () => void;
  }

  let { chatId, currentTitle, onClose }: Props = $props();

  let value = $state(currentTitle);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  $effect(() => {
    setTimeout(() => { inputEl?.select(); inputEl?.focus(); }, 50);
  });

  function commit() {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentTitle) {
      appStore.renameChat(chatId, trimmed);
    }
    onClose();
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-backdrop fixed inset-0 z-[300] flex items-center justify-center px-4"
  role="dialog"
  aria-modal="true"
  transition:fade={{ duration: 150 }}
  onclick={e => { if (e.target === e.currentTarget) onClose(); }}
>
  <div
    class="modal-surface w-full max-w-sm overflow-hidden rounded-2xl"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={e => e.stopPropagation()}
  >
    <!-- Header -->
    <div class="modal-header">
      <div class="flex items-center gap-2.5">
        <div class="modal-icon">
          <Pencil class="h-4 w-4" />
        </div>
        <h2 class="modal-title">{$t('sidebar.rename')}</h2>
      </div>
      <button
        type="button"
        class="close-btn"
        onclick={onClose}
        aria-label={$t('common.close')}
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <!-- Body -->
    <div class="modal-body">
      <label class="input-label" for="rename-chat-input">
        {$t('chat.chatName')}
      </label>
      <input
        id="rename-chat-input"
        bind:this={inputEl}
        bind:value
        type="text"
        maxlength="120"
        placeholder={$t('chat.enterNamePlaceholder')}
        class="input-field"
      />
      <p class="char-count">{value.length}/120</p>
    </div>

    <!-- Footer -->
    <div class="modal-footer">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={onClose}
      >{$t('chat.cancel')}</button>
      <button
        type="button"
        class="btn btn-primary"
        onclick={commit}
        disabled={!value.trim()}
      >{$t('sidebar.rename')}</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-surface {
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-xl);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .modal-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    color: var(--text-secondary);
    background: var(--surface-highlight);
  }

  .modal-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.375rem;
    border-radius: 0.5rem;
    color: var(--text-muted);
    background: transparent;
    transition: color 0.12s, background 0.12s;
  }

  .close-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .modal-body {
    padding: 1.25rem;
  }

  .input-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-muted);
  }

  .input-field {
    width: 100%;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    background: var(--surface-highlight);
    color: var(--text);
    font-size: 0.9375rem;
    outline: none;
    transition: border-color 0.12s;
  }

  .input-field::placeholder {
    color: var(--text-muted);
  }

  .input-field:focus {
    border-color: var(--border-strong);
  }

  .char-count {
    margin-top: 0.5rem;
    font-size: 0.75rem;
    text-align: right;
    color: var(--text-muted);
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    border-top: 1px solid var(--border);
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.12s;
  }

  .btn-secondary {
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
  }

  .btn-secondary:hover {
    color: var(--text);
    background: var(--surface-highlight);
    border-color: var(--border-strong);
  }

  .btn-primary {
    color: var(--primary-fg);
    background: var(--primary);
    border: 1px solid var(--primary);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
