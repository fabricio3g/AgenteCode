<svelte:options runes={true} />

<script lang="ts">
  import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
</script>

<div class="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2" aria-live="polite" aria-atomic="false">
  {#each toastStore.toasts as toast (toast.id)}
    <div
      class={`toast toast-${toast.type} pointer-events-auto flex min-w-[20rem] max-w-[22rem] items-center gap-3 rounded-2xl border px-4 py-3 shadow-lg transition-all duration-300`}
      role="alert"
    >
      <div class="shrink-0">
        {#if toast.type === 'success'}
          <CheckCircle2 class="h-4.5 w-4.5" />
        {:else if toast.type === 'error'}
          <XCircle class="h-4.5 w-4.5" />
        {:else if toast.type === 'warning'}
          <AlertTriangle class="h-4.5 w-4.5" />
        {:else}
          <Info class="h-4.5 w-4.5" />
        {/if}
      </div>
      <span class="flex-1 text-sm font-medium">{toast.message}</span>
      <button
        class="shrink-0 rounded-lg p-1 opacity-60 transition hover:opacity-100"
        onclick={() => toastStore.dismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }
  .toast-success {
    border-color: var(--success-border);
    background: var(--success-bg);
    color: var(--success);
  }
  .toast-error {
    border-color: var(--error-border);
    background: var(--error-bg);
    color: var(--error);
  }
  .toast-warning {
    border-color: var(--warning-border);
    background: var(--warning-bg);
    color: var(--warning);
  }
  .toast-info {
    border-color: var(--info-border);
    background: var(--info-bg);
    color: var(--info);
  }
  .toast-success :global(svg),
  .toast-error :global(svg),
  .toast-warning :global(svg),
  .toast-info :global(svg) {
    color: inherit;
  }
</style>
