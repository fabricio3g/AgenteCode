<svelte:options runes={true} />

<!--
  Current failures can interrupt with an alert. The transcript renders past
  failures as a quiet disclosure with the same redacted diagnostics.
-->

<script lang="ts">
  import { AlertCircle, X } from '$lib/icons';
  import { tick } from 'svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { copy } from '$lib/copy';
  import { t } from 'svelte-i18n';
  import { codeErrorSummaryKey, safeCodeErrorDetails } from './code-error';

  let { detail, compact = false, onDismiss }: { detail: string; compact?: boolean; onDismiss?: () => void } = $props();
  const summary = $derived($t(codeErrorSummaryKey(detail)));
  const safeDetail = $derived(safeCodeErrorDetails(detail));
  const hasDetail = $derived(!!safeDetail.trim());

  let dismissedDetail = $state<string | null>(null);
  const dismissed = $derived(dismissedDetail === detail);
  let historicalSummary = $state<HTMLElement>();

  async function dismiss() {
    if (!onDismiss) {
      dismissedDetail = detail;
      return;
    }
    onDismiss();
    await tick();
    historicalSummary?.focus();
  }
</script>

{#snippet diagnostic()}
  <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{safeDetail}</pre>
{/snippet}

{#if compact}
  {#if hasDetail}
    <details class="text-xs text-muted-foreground">
      <summary bind:this={historicalSummary} class="cursor-pointer hover:text-foreground">{summary}</summary>
      {@render diagnostic()}
    </details>
  {:else}
    <p class="text-xs text-muted-foreground">{summary}</p>
  {/if}
{:else if !dismissed}
  <div class="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground" role="alert">
    <AlertCircle class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    <div class="min-w-0 flex-1">
      <p>{summary}</p>
      {#if hasDetail}
        <details class="mt-1.5 text-muted-foreground">
          <summary class="cursor-pointer hover:text-foreground">{$t('code.errors.details')}</summary>
          {@render diagnostic()}
        </details>
      {/if}
    </div>
    <IconButton
      label={copy.actions.close}
      size="xs"
      variant="ghost"
      type="button"
      class="notice-close shrink-0"
      onclick={dismiss}
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
