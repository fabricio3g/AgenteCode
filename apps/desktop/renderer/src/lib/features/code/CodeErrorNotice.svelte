<svelte:options runes={true} />

<!--
  A failed turn's one-line explanation, shared by the transcript and subagent
  cards. The X is a UI-only dismissal: it hides this notice from the surface,
  it does not rewrite the conversation or delete the error from a saved
  session. A different failure in the same component brings the notice back.
-->

<script lang="ts">
  import { AlertCircle, X } from '$lib/icons';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { copy } from '$lib/copy';
  import { t } from 'svelte-i18n';
  import { classifyCodeError, safeCodeErrorDetails } from './code-error';

  let { detail }: { detail: string } = $props();
  const kind = $derived(classifyCodeError(detail));
  const safeDetail = $derived(safeCodeErrorDetails(detail));

  let dismissedDetail = $state<string | null>(null);
  const dismissed = $derived(dismissedDetail === detail);
</script>

{#if !dismissed}
  <div class="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground" role="alert">
    <AlertCircle class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    <div class="min-w-0 flex-1">
      <p>{$t(kind === 'localModelNotRunning' ? 'code.runtimeLocalModelNotRunning' : `code.errors.${kind}`)}</p>
      {#if safeDetail.trim()}
        <details class="mt-1.5 text-muted-foreground">
          <summary class="cursor-pointer hover:text-foreground">{$t('code.errors.details')}</summary>
          <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{safeDetail}</pre>
        </details>
      {/if}
    </div>
    <IconButton
      label={copy.actions.close}
      size="xs"
      variant="ghost"
      type="button"
      class="notice-close shrink-0"
      onclick={() => (dismissedDetail = detail)}
    >
      <X class="size-3" />
    </IconButton>
  </div>
{/if}

<style>
  /* The dismissal is the composer's icon control at the notice's scale: flat,
     a round hover band, grey until the pointer finds it. */
  :global(.notice-close) {
    color: var(--muted-foreground);
    border-radius: var(--radius-full);
  }
  :global(.notice-close:hover) {
    background: var(--float-row-hover);
    color: var(--foreground);
  }
</style>
