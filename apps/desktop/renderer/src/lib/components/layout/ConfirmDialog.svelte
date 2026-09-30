<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import Portal from '$lib/components/ui/Portal.svelte';
  import { copy } from '$lib/copy';

  function onSurfaceKeydown(event: KeyboardEvent) {
    // Enter confirms unless a button other than confirm has focus (then the
    // browser's own activation handles it).
    if (event.key !== 'Enter' || event.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'BUTTON' && !target.hasAttribute('data-confirm')) return;
    event.preventDefault();
    confirmStore.confirm();
  }
</script>

{#if confirmStore.open && confirmStore.options}
  {@const options = confirmStore.options}
  <Portal>
    <div
      class="aui-modal-backdrop"
      role="presentation"
      use:modalLayer={{ onclose: () => confirmStore.cancel(), zToken: '--z-confirm' }}
      onclick={() => confirmStore.cancel()}
      transition:motionFade={{ duration: 150 }}
    >
      <div
        class="aui-modal-surface max-w-sm"
        transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
        onkeydown={onSurfaceKeydown}
      >
        <div class="aui-modal-header">
          <h2 id="confirm-title" class="aui-modal-title">{options.title}</h2>
        </div>
        <div class="aui-modal-body !pt-0">
          <p id="confirm-message" class="m-0 text-sm leading-6 text-muted-foreground">{options.message}</p>
          {#if options.details?.length}
            <ul class="mt-3 max-h-40 space-y-0.5 overflow-auto rounded-lg bg-muted/60 px-3 py-2 text-[11.5px] leading-5 text-foreground">
              {#each options.details as line (line)}
                <li class="truncate" title={line}>{line}</li>
              {/each}
            </ul>
          {/if}
        </div>
        <div class="aui-modal-footer">
          <button type="button" class="aui-btn aui-btn-ghost" onclick={() => confirmStore.cancel()}>
            {options.cancelLabel || copy.actions.cancel}
          </button>
          <button
            type="button"
            data-confirm
            data-autofocus
            class="aui-btn {options.danger ? 'aui-btn-danger' : 'aui-btn-primary'}"
            onclick={() => confirmStore.confirm()}
          >
            {options.confirmLabel || copy.actions.confirm}
          </button>
        </div>
      </div>
    </div>
  </Portal>
{/if}
