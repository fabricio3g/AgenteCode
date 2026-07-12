<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
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
    setTimeout(() => {
      inputEl?.select();
      inputEl?.focus();
    }, 50);
  });

  function commit() {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentTitle) {
      appStore.renameChat(chatId, trimmed);
    }
    onClose();
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="aui-modal-backdrop z-[300]"
  role="dialog"
  aria-modal="true"
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="aui-modal-surface max-w-sm"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="aui-modal-header">
      <div class="flex items-center gap-2.5">
        <div class="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Pencil class="size-4" />
        </div>
        <h2 class="aui-modal-title">{$t('sidebar.rename')}</h2>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={onClose} aria-label={$t('common.close')}>
        <X class="size-4" />
      </button>
    </div>

    <div class="aui-modal-body !pt-0">
      <label class="mb-1.5 block text-xs font-medium text-muted-foreground" for="rename-chat-input">
        {$t('chat.chatName')}
      </label>
      <input
        id="rename-chat-input"
        bind:this={inputEl}
        bind:value
        type="text"
        maxlength="120"
        placeholder={$t('chat.enterNamePlaceholder')}
        class="aui-input"
      />
      <p class="mt-1.5 text-right text-xs text-muted-foreground">{value.length}/120</p>
    </div>

    <div class="aui-modal-footer">
      <button type="button" class="aui-btn aui-btn-ghost" onclick={onClose}>{$t('chat.cancel')}</button>
      <button type="button" class="aui-btn aui-btn-primary" onclick={commit} disabled={!value.trim()}>
        {$t('sidebar.rename')}
      </button>
    </div>
  </div>
</div>
