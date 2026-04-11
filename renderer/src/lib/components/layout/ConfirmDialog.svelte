<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { confirmStore } from '$lib/stores/confirm.svelte';

  let confirmBtnEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (confirmStore.open && confirmBtnEl) {
      confirmBtnEl.focus();
    }
  });

  $effect(() => {
    if (!confirmStore.open) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        confirmStore.cancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        confirmStore.confirm();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if confirmStore.open && confirmStore.options}
  <div
    class="modal-backdrop fixed inset-0 z-[200] flex items-center justify-center bg-black/25 px-4"
    role="presentation"
    onclick={() => confirmStore.cancel()}
    transition:fade={{ duration: 150 }}
  >
    <div
      class="modal-surface w-full max-w-sm rounded-xl border border-[var(--border)] p-5"
      style="background:var(--surface); box-shadow:var(--shadow-xl);"
      transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h2 id="confirm-title" class="text-base font-semibold text-[var(--text)] font-serif tracking-tight">
        {confirmStore.options.title}
      </h2>
      <p class="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
        {confirmStore.options.message}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="cancel-btn rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition"
          onclick={() => confirmStore.cancel()}
        >
          {confirmStore.options.cancelLabel || 'Cancel'}
        </button>
        <button
          type="button"
          bind:this={confirmBtnEl}
          class={`confirm-btn rounded-lg px-4 py-2 text-sm font-medium transition ${confirmStore.options.danger ? 'danger' : ''}`}
          onclick={() => confirmStore.confirm()}
        >
          {confirmStore.options.confirmLabel || 'Confirm'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cancel-btn {
    background: var(--surface);
    color: var(--text-secondary);
    border-radius: var(--radius-s);
  }
  .cancel-btn:hover {
    background: var(--surface-highlight);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .confirm-btn {
    background: var(--primary);
    color: var(--primary-fg);
    border-radius: var(--radius-s);
  }
  .confirm-btn:hover {
    opacity: 0.88;
  }
  .confirm-btn:active {
    transform: scale(0.98);
  }
  .confirm-btn.danger {
    background: var(--error);
    color: white;
  }
  .confirm-btn.danger:hover {
    opacity: 0.88;
  }
  .confirm-btn.danger:active {
    transform: scale(0.98);
  }
</style>
