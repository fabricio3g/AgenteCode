<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
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
    class="aui-modal-backdrop"
    style="z-index: var(--z-confirm);"
    role="presentation"
    onclick={() => confirmStore.cancel()}
    transition:motionFade={{ duration: 150 }}
  >
    <div
      class="aui-modal-surface max-w-sm"
      transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="aui-modal-header">
        <h2 id="confirm-title" class="aui-modal-title">
          {confirmStore.options.title}
        </h2>
      </div>
      <div class="aui-modal-body !pt-0">
        <p class="m-0 text-sm leading-6 text-muted-foreground">
          {confirmStore.options.message}
        </p>
      </div>
      <div class="aui-modal-footer">
        <button type="button" class="aui-btn aui-btn-ghost" onclick={() => confirmStore.cancel()}>
          {confirmStore.options.cancelLabel || 'Cancel'}
        </button>
        <button
          type="button"
          bind:this={confirmBtnEl}
          class="aui-btn {confirmStore.options.danger ? 'aui-btn-danger' : 'aui-btn-primary'}"
          onclick={() => confirmStore.confirm()}
        >
          {confirmStore.options.confirmLabel || 'Confirm'}
        </button>
      </div>
    </div>
  </div>
{/if}
