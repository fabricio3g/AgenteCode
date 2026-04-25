<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { t } from 'svelte-i18n';
  import { X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  function save() {
    appStore.saveEditedMessage();
  }
</script>

  <div class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4" role="dialog" aria-modal="true" transition:fade={{ duration: 150 }}>
  <div class="modal-surface w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}>
    <div class="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
      <h2 class="text-base font-semibold text-[var(--text)] font-serif tracking-tight">{$t('chat.editMessageTitle')}</h2>
      <button class="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[var(--text-muted)] transition-all hover:bg-[var(--surface-highlight)] hover:text-[var(--text)] hover:border-[var(--border-light)]" aria-label={$t('chat.closeEditModal')} onclick={() => appStore.closeEditMessage()}>
        <X class="h-4 w-4" />
      </button>
    </div>

    <div class="space-y-4 overflow-y-auto px-6 py-5">
      <textarea
        class="min-h-48 max-h-[calc(100vh-12rem)] w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-3 text-sm text-[var(--text)] outline-none transition focus:border-[var(--border-strong)]"
        value={appStore.editingMessageContent}
        oninput={(event) => appStore.updateEditingMessage((event.currentTarget as HTMLTextAreaElement).value)}
        onkeydown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save();
        }}
      ></textarea>

      <div class="flex items-center justify-end gap-3">
        <button class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-all hover:bg-[var(--surface-highlight)] hover:text-[var(--text)] hover:border-[var(--border-strong)]" onclick={() => appStore.closeEditMessage()}>
          {$t('chat.cancel')}
        </button>
        <button class="rounded-lg border border-[var(--border-strong)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)] transition-all hover:opacity-88 active:scale-[0.98]" onclick={save}>
          {$t('common.save')}
        </button>
      </div>
    </div>
  </div>
</div>
