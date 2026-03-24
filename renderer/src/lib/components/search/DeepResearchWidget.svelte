<svelte:options runes={true} />

<script lang="ts">
  import { LoaderCircle, Square } from 'lucide-svelte';
  import { cancelDeepResearchTask, deepResearchStore } from '$lib/stores/deep-research.svelte';

  interface Props {
    messageId?: string | null;
  }

  let { messageId = null }: Props = $props();

  const activeTask = $derived.by(() => {
    const task = deepResearchStore.activeTask;
    if (!task || !messageId) return null;
    return task.messageId === messageId ? task : null;
  });

  function stopActiveTask() {
    if (!activeTask) return;
    cancelDeepResearchTask(activeTask.id);
  }

  function phaseLabel(step: string) {
    switch (step) {
      case 'queued':
        return 'Queued';
      case 'searching':
        return 'Searching';
      case 'synthesizing':
        return 'Writing summary';
      default:
        return step.replace(/_/g, ' ');
    }
  }
</script>

{#if activeTask}
  <div class="research-row mb-4">
    <div class="research-indicator">
      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
    </div>
    <div class="research-content">
      <span class="research-label">
        {activeTask.mode === 'max' ? 'Searching all sources' : 'Searching'}
        <span class="research-phase">{phaseLabel(activeTask.currentStep)}</span>
      </span>
      <span class="research-query">{activeTask.query}</span>
    </div>
    <button class="stop-btn" onclick={stopActiveTask} aria-label="Stop" title="Stop">
      <Square class="h-3 w-3 fill-current" />
    </button>
  </div>
{/if}

<style>
  .research-row {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
  }

  .research-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    margin-top: 0.125rem;
    color: var(--text-muted);
  }

  .research-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    flex: 1;
  }

  .research-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
  }

  .research-phase {
    margin-left: 0.375rem;
    color: var(--text-muted);
    font-weight: 400;
  }

  .research-query {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stop-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    color: var(--text-muted);
    background: transparent;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
    margin-top: -0.125rem;
  }

  .stop-btn:hover {
    background: var(--surface-highlight);
    color: var(--text);
  }
</style>
