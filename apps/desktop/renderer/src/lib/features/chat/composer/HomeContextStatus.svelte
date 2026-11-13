<svelte:options runes={true} />

<script lang="ts">
  import GenerationSpeed from '$lib/features/shared/composer/GenerationSpeed.svelte';
  import { latestGenerationSpeed } from '$lib/utils/generation-speed';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import ContextUsageRing from './ContextUsageRing.svelte';
  import { conversationSpend } from '$lib/features/code/accounting';

  const budget = $derived(appStore.contextBudget);
  const speed = $derived(latestGenerationSpeed(appStore.currentChat?.messages ?? []));
  const spend = $derived(conversationSpend(appStore.currentChat?.messages ?? []));
  const visible = $derived(!!budget && (budget.usedTokens ?? 0) > 0);
</script>

{#snippet ring(budget: NonNullable<typeof appStore.contextBudget>)}
      <ContextUsageRing showLabel
        {spend}
        usedTokens={budget.usedTokens ?? 0}
        maxTokens={budget.maxContext ?? Number(modelsStore.status?.n_ctx || appStore.activeLoadConfig.context_length || 4096)}
        reservedTokens={budget.reservedForCompletion ?? 0}
        promptCostPerMillionUsd={budget.promptCostPerMillionUsd}
        completionCostPerMillionUsd={budget.completionCostPerMillionUsd}
        remaining={budget.remaining}
        estimated={budget.estimated}
        usagePercent={budget.usagePercent}
        breakdown={budget.breakdown}
      />
{/snippet}

<GenerationSpeed value={speed} />
{#if visible && budget}{@render ring(budget)}{/if}
