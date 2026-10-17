<svelte:options runes={true} />

<script lang="ts">
  import GenerationSpeed from '$lib/features/shared/composer/GenerationSpeed.svelte';
  import { latestGenerationSpeed } from '$lib/utils/generation-speed';
  import { appStore } from '$lib/stores/app.svelte';
  import type { Snippet } from 'svelte';
  import ContextUsageRing from './ContextUsageRing.svelte';

  /** `lead` sits hard left in the strip (Home's Agent | Instant switch). */
  let { lead }: { lead?: Snippet } = $props();

  const budget = $derived(appStore.contextBudget);
  const speed = $derived(latestGenerationSpeed(appStore.currentChat?.messages ?? []));
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

{#if lead || visible || speed !== undefined}
  <div class="composer-secondary">
    {@render lead?.()}
    <div class="composer-secondary-status">
      <GenerationSpeed value={speed} />
      {#if visible && budget}{@render ring(budget)}{/if}
    </div>
  </div>
{/if}
