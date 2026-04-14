<svelte:options runes={true} />

<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { X } from 'lucide-svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  const COLOR_MAP = {
    success: 'var(--success)',
    error: 'var(--error)',
    warning: 'var(--warning)',
    info: 'var(--info)',
  } as const;
</script>

<div
  class="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2"
  aria-live="polite"
  aria-atomic="false"
>
  {#each toastStore.toasts as toast (toast.id)}
    <div
      class="toast pointer-events-auto flex items-center gap-3 rounded-full border px-4 py-2.5"
      style="color: {COLOR_MAP[toast.type]}"
      role="alert"
      in:fly={{ y: 12, duration: 200 }}
      out:fade={{ duration: 150 }}
    >
      <span class="text-[13px] font-medium">{toast.message}</span>
      <button
        class="flex shrink-0 items-center justify-center rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
        onclick={() => toastStore.dismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X class="h-3 w-3" />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast {
    background: var(--surface);
    border-color: var(--border);
    box-shadow: var(--shadow-l);
    min-width: 16rem;
    max-width: 18rem;
  }
</style>
