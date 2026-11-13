<svelte:options runes={true} />

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Tooltip } from '$lib/components/ui';
  import { motionFly, motionFade } from '$lib/utils/transitions';
  import { X } from '$lib/icons';
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
      <span class="text-[length:var(--text-sm)] font-medium leading-none text-foreground">{toast.message}</span>
      {#if toast.action}
        <UiButton variant="plain" type="button" class={uiClass("toast-action", "ui-local-2a4781e7")} onclick={toast.action.run}>{toast.action.label}</UiButton>
      {/if}
      <Tooltip label="Dismiss" position="bottom"><UiIconButton label={"Dismiss"} size="xs"
        type="button"
        class={uiClass("  shrink-0", "ui-local-2a4781e7")}
        onclick={() => toastStore.dismiss(toast.id)}

      >
        <X class="size-3" />
      </UiIconButton></Tooltip>
    </div>
  {/each}
</div>

<style>
  .toast {
    background: var(--float-bg);
    border: 1px solid var(--float-border);
    box-shadow: var(--float-shadow);
    border-radius: var(--float-radius);
    max-width: 22rem;
  }
  :global(.toast-action.ui-local-2a4781e7) {
    flex-shrink: 0;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-full);
    color: var(--brand-accent, var(--foreground));
    font-size: var(--text-sm);
    font-weight: 600;
  }
  :global(.toast-action:hover.ui-local-2a4781e7) {
    background: var(--surface-hover);
  }
</style>
