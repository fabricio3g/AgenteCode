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
  /** "Read 8 files · searched 2 · ran 1 command", first letter capitalised. */
  const line = $derived.by(() => {
    const state = summary.running ? 'running' : 'done';
    const text = summary.counts.map(({ kind, count }) => $t(`code.activity.${state}.${kind}`, { values: { n: count } })).join(' · ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  });
</script>

{#if quiet.length > 1}
  <div class="min-w-0">
    <button type="button" class="activity-trigger" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      <ChevronRight class="size-3 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
      <span class="min-w-0 truncate tabular-nums">{line}</span>
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
