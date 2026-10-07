<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import ContextUsageRing from './ContextUsageRing.svelte';

  const budget = $derived(appStore.contextBudget);
  const visible = $derived(!!budget && (budget.usedTokens ?? 0) > 0);
</script>

{#if visible && budget}
  <div class="composer-secondary">
    <div class="composer-secondary-status">
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
    </div>
  </div>
{/if}
