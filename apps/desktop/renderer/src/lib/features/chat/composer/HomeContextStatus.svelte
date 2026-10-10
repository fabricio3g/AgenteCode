<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import ContextUsageRing from './ContextUsageRing.svelte';

  /** `inline` sits in the composer bar beside send; otherwise a strip under the composer. */
  let { inline = false }: { inline?: boolean } = $props();

  const budget = $derived(appStore.contextBudget);
  const visible = $derived(!!budget && (budget.usedTokens ?? 0) > 0);
</script>

{#snippet ring(budget: NonNullable<typeof appStore.contextBudget>)}
      <ContextUsageRing showLabel
        usedTokens={budget.usedTokens ?? 0}
        maxTokens={budget.maxContext ?? Number(appStore.config.llm?.local?.context_length || 4096)}
        reservedTokens={budget.reservedForCompletion ?? 0}
        promptCostPerMillionUsd={budget.promptCostPerMillionUsd}
        completionCostPerMillionUsd={budget.completionCostPerMillionUsd}
        estimatedInputCostUsd={budget.estimatedInputCostUsd}
        remaining={budget.remaining}
        estimated={budget.estimated}
        usagePercent={budget.usagePercent}
      />
{/snippet}

{#if visible && budget}
  {#if inline}
    <div class="inline-context">{@render ring(budget)}</div>
  {:else}
    <div class="composer-secondary">
      <div class="composer-secondary-status">{@render ring(budget)}</div>
    </div>
  {/if}
{/if}

<style>
  .inline-context { display: flex; flex-shrink: 0; align-items: center; color: var(--muted-foreground); }
</style>
