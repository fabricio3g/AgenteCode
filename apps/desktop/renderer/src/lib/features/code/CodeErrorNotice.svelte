<svelte:options runes={true} />

<script lang="ts">
  import { AlertCircle } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { classifyCodeError, safeCodeErrorDetails } from './code-error';

  let { detail }: { detail: string } = $props();
  const kind = $derived(classifyCodeError(detail));
  const safeDetail = $derived(safeCodeErrorDetails(detail));
</script>

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
</div>
