<svelte:options runes={true} />

<script lang="ts">
  import { motionFly, motionFade } from '$lib/utils/transitions';
  import { X } from 'lucide-svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  const COLOR_MAP = {
    success: 'var(--success)',
    error: 'var(--error)',
    warning: 'var(--warning)',
    info: 'var(--foreground)'
  } as const;
</script>

<div
  class="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2"
  aria-live="polite"
  aria-atomic="false"
>
  {#each toastStore.toasts as toast (toast.id)}
    <div
      class="toast pointer-events-auto flex items-center justify-center gap-2.5 px-4 py-2.5"
      style="color: {COLOR_MAP[toast.type]}"
      role="alert"
      in:motionFly={{ y: 12, duration: 200 }}
      out:motionFade={{ duration: 150 }}
    >
      <span class="text-[13px] font-medium leading-none text-foreground">{toast.message}</span>
      {#if toast.action}
        <button type="button" class="toast-action" onclick={toast.action.run}>{toast.action.label}</button>
      {/if}
      <button
        type="button"
        class="ui-icon-button is-xs shrink-0"
        onclick={() => toastStore.dismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X class="size-3" />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast {
    background: var(--popover);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    border-radius: var(--radius-lg);
    max-width: 22rem;
  }
  .toast-action {
    flex-shrink: 0;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-full);
    color: var(--brand-accent, var(--foreground));
    font-size: 12.5px;
    font-weight: 600;
  }
  .toast-action:hover {
    background: var(--surface-hover);
  }
</style>
