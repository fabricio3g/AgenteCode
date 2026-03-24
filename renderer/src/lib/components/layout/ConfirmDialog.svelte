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
      class="modal-surface w-full max-w-sm rounded-[1.5rem] border border-[var(--border)] p-5"
      style="background:var(--surface); box-shadow:var(--shadow-xl);"
      transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h2 id="confirm-title" class="text-lg font-semibold text-[var(--text)]">
        {confirmStore.options.title}
      </h2>
      <p class="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
        {confirmStore.options.message}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="cancel-btn rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium transition"
          onclick={() => confirmStore.cancel()}
        >
          {confirmStore.options.cancelLabel || 'Cancel'}
        </button>
        <button
          type="button"
          bind:this={confirmBtnEl}
          class={`confirm-btn rounded-xl px-4 py-2 text-sm font-medium transition ${confirmStore.options.danger ? 'danger' : ''}`}
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
  }
  .cancel-btn:hover {
    background: var(--surface-highlight);
    color: var(--text);
  }
  .confirm-btn {
    background: var(--primary);
    color: var(--primary-fg);
  }
  .confirm-btn:hover {
    opacity: 0.9;
  }
  .confirm-btn.danger {
    background: var(--error);
    color: white;
  }
  .confirm-btn.danger:hover {
    background: color-mix(in srgb, var(--error) 85%, black);
  }
</style>
