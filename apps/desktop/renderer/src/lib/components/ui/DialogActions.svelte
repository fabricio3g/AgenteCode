<script lang="ts">
  import Button from './Button.svelte';
  import { cn } from '$lib/utils/cn';
  let { cancelLabel, confirmLabel, oncancel, onconfirm, danger = false, disabled = false, busy = false, confirmTitle, busyLabel, confirmType = 'button', form, autofocusConfirm = false, class: className = '' }: {
    cancelLabel: string;
    confirmLabel?: string;
    oncancel: () => void;
    onconfirm?: () => void;
    danger?: boolean;
    disabled?: boolean;
    busy?: boolean;
    confirmTitle?: string;
    busyLabel?: string;
    confirmType?: 'button' | 'submit';
    form?: string;
    autofocusConfirm?: boolean;
    class?: string;
  } = $props();
</script>
<div class={cn('ui-dialog-actions', className)}>
  <Button variant="outline" size="dialog" onclick={oncancel}>{cancelLabel}</Button>
  {#if confirmLabel && (onconfirm || confirmType === 'submit')}
    <Button variant={danger ? 'destructive' : 'default'} size="dialog" type={confirmType} {form} disabled={disabled} loading={busy} loadingLabel={busyLabel} title={confirmTitle} data-confirm data-autofocus={autofocusConfirm || undefined} onclick={onconfirm}>{confirmLabel}</Button>
  {/if}
</div>
<style>.ui-dialog-actions { display:flex; min-width:0; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:0.5rem; }</style>
