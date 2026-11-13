<script lang="ts">
  import { AlertCircle, Check, LoaderCircle } from '$lib/icons';
  import Button from './Button.svelte';
  import type { AutosaveState } from '$lib/utils/autosave';

  let {
    state,
    message,
    onretry,
  }: {
    state: AutosaveState;
    message?: string;
    onretry?: () => void;
  } = $props();
</script>

<div class="flex min-h-7 items-center justify-end gap-2 text-xs text-muted-foreground" aria-live="polite">
  {#if state === 'saving'}
    <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
    <span>Saving…</span>
  {:else if state === 'saved'}
    <Check class="size-3.5 text-success" aria-hidden="true" />
    <span>Saved</span>
  {:else if state === 'blocked'}
    <AlertCircle class="size-3.5 text-warning" aria-hidden="true" />
    <span class="text-warning">{message || 'Changes need attention'}</span>
  {:else if state === 'error'}
    <AlertCircle class="size-3.5 text-error" aria-hidden="true" />
    <span class="text-error">{message || 'Could not save changes'}</span>
    {#if onretry}
      <Button variant="outline" size="xs" onclick={onretry}>Retry</Button>
    {/if}
  {/if}
</div>
