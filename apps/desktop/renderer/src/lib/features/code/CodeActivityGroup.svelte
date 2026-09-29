<svelte:options runes={true} />

<script lang="ts">
  import { ChevronRight } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { AgentStep } from '$lib/types/chat';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { activitySummary } from './activity';
  import CodeStepRow from './CodeStepRow.svelte';

  let { steps, chatId }: { steps: AgentStep[]; chatId: string } = $props();
  let expanded = $state(false);
  const attention = (step: AgentStep) => step.status === 'error' || step.status === 'awaiting_approval' || approvalsStore.items.some((item) => item.id === step.id);
  const visible = $derived(steps.filter((step) => step.type !== 'approval' || attention(step)));
  const quiet = $derived(visible.filter((step) => !attention(step)));
  const summary = $derived(activitySummary(quiet));
</script>

{#if quiet.length && summary.kind}
  <div class="min-w-0">
    <button type="button" class="activity-trigger" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      <ChevronRight class="size-3 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
      <span>{$t(`code.activity.${summary.kind}.${summary.running ? 'running' : 'done'}`)}</span>
      <span class="tabular-nums">{summary.count}</span>
    </button>
    {#if expanded}
      <div class="ml-3 min-w-0 py-1">
        {#each quiet as step (step.id)}<CodeStepRow {step} {chatId} />{/each}
      </div>
    {/if}
  </div>
{:else}
  {#each quiet as step (step.id)}<CodeStepRow {step} {chatId} />{/each}
{/if}
{#each visible.filter(attention) as step (step.id)}<CodeStepRow {step} {chatId} />{/each}

<style>
  .activity-trigger {
    display: flex;
    max-width: 100%;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
    font-size: 12px;
    text-align: left;
    transition: color var(--motion-fast), background-color var(--motion-fast);
  }
  .activity-trigger:hover,
  .activity-trigger:focus-visible {
    color: var(--foreground);
    background: var(--surface-hover);
  }
</style>
