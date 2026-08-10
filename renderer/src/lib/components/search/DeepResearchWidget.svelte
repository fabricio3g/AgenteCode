<svelte:options runes={true} />

<script lang="ts">
  import { ArrowRight, Loader2, SkipForward, Square } from 'lucide-svelte';
  import { cancelDeepResearchTask, deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { activityLabel } from '$lib/utils/tool-ui';

  interface Props {
    messageId?: string | null;
  }

  let { messageId = null }: Props = $props();

  const activeTask = $derived.by(() => deepResearchStore.getActiveTaskForMessage(messageId));
  const isWorking = $derived(activeTask && ['queued', 'searching', 'crawling', 'synthesizing'].includes(activeTask.status));

  // Research stages map onto the shared activity vocabulary so the widget uses
  // the same verbs as the inline tool-status line above it.
  const stageLabel = $derived.by(() => {
    if (!activeTask) return '';
    switch (activeTask.status) {
      case 'queued': return 'Queued';
      case 'searching': return activityLabel('searching');
      case 'crawling': return activityLabel('reading');
      case 'synthesizing': return activityLabel('writing');
      case 'awaiting_input': return 'Direction needed';
      case 'completed': return 'Done';
      case 'failed': return 'Failed';
      case 'cancelled': return 'Stopped';
      default: return activeTask.status || '';
    }
  });

  let selectedOptionId = $state<string>('');
  let customText = $state('');
  let useCustom = $state(false);

  $effect(() => {
    if (!activeTask || activeTask.status !== 'awaiting_input') {
      selectedOptionId = '';
      customText = '';
      useCustom = false;
      return;
    }

    const firstWithSuggestion = (activeTask.questions || []).find((q) => q.suggestedAnswer)?.id || activeTask.questions?.[0]?.id || '';
    if (!selectedOptionId) selectedOptionId = firstWithSuggestion;
    if (!(activeTask.questions || []).some((q) => q.suggestedAnswer)) useCustom = true;
  });

  function stopActiveTask() {
    if (!activeTask) return;
    appStore.stopStreaming(activeTask.chatId || appStore.currentChatId || '');
    cancelDeepResearchTask(activeTask.id);
  }

  function submitAnswers(skip = false) {
    if (!activeTask) return;
    if (skip) {
      deepResearchStore.submitTaskAnswers(activeTask.id, {}, true);
      return;
    }

    const answers: Record<string, string> = {};

    if (useCustom) {
      const firstId = activeTask.questions?.[0]?.id;
      if (firstId && customText.trim()) answers[firstId] = customText.trim();
    } else {
      const selected = (activeTask.questions || []).find((q) => q.id === selectedOptionId);
      if (selected?.suggestedAnswer?.trim()) answers[selected.id] = selected.suggestedAnswer.trim();
    }

    deepResearchStore.submitTaskAnswers(activeTask.id, answers, false);
  }
</script>

{#if activeTask}
  <section class="research-card" aria-label="Deep research">
    <div class="status-row">
      {#if isWorking}
        <Loader2 class="status-icon spin" aria-hidden="true" />
      {/if}
      <span class="status-text">{stageLabel}</span>
      {#if activeTask.mode === 'max' || activeTask.mode === 'deep'}
        <span class="mode-chip">{activeTask.mode === 'max' ? 'Max' : 'Deep'}</span>
      {/if}
    </div>

    <p class="query">{activeTask.query}</p>
    {#if activeTask.detail && !isWorking}
      <p class="detail">{activeTask.detail}</p>
    {/if}
    {#if activeTask.detail?.toLowerCase().includes('auto-options failed')}
      <p class="detail">Couldn’t generate suggestions. Write your own direction below.</p>
    {/if}

    {#if activeTask.status === 'awaiting_input' && activeTask.questions?.length}
      <div class="questions">
        <div class="selector-row">
          <button type="button" class="selector-chip {!useCustom ? 'is-active' : ''}" onclick={() => (useCustom = false)}>
            Suggested
          </button>
          <button type="button" class="selector-chip {useCustom ? 'is-active' : ''}" onclick={() => (useCustom = true)}>
            Custom
          </button>
        </div>

        {#if !useCustom}
          <div class="options">
            {#each activeTask.questions as question (question.id)}
              <button
                type="button"
                class="option {selectedOptionId === question.id ? 'is-active' : ''}"
                onclick={() => (selectedOptionId = question.id)}
                disabled={!question.suggestedAnswer}
              >
                {question.suggestedAnswer || question.question}
              </button>
            {/each}
          </div>
        {:else}
          <textarea
            rows={3}
            class="input"
            bind:value={customText}
            placeholder="Write your research direction"
          ></textarea>
        {/if}

        <div class="actions">
          <button type="button" class="btn" onclick={stopActiveTask}>
            <Square class="h-3 w-3 fill-current" />
            Stop
          </button>
          <button type="button" class="btn" onclick={() => submitAnswers(true)}>
            <SkipForward class="h-3.5 w-3.5" />
            Skip
          </button>
          <button type="button" class="btn primary" onclick={() => submitAnswers(false)}>
            <ArrowRight class="h-3.5 w-3.5" />
            Continue
          </button>
        </div>
      </div>
    {:else if isWorking}
      <div class="actions always">
        <button type="button" class="btn" onclick={stopActiveTask}>
          <Square class="h-3 w-3 fill-current" />
          Stop
        </button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .research-card {
    border: 0;
    border-radius: var(--artifact-radius, var(--radius-md));
    background: var(--artifact-surface, color-mix(in srgb, var(--surface) 88%, var(--chat-bg)));
    box-shadow: var(--artifact-elev, none);
    padding: 0.75rem 0.85rem;
    max-width: 42rem;
    width: 100%;
    margin: 0.5rem 0 0.75rem;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted-foreground);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .status-icon {
    width: 0.85rem;
    height: 0.85rem;
    flex-shrink: 0;
  }

  .status-icon.spin {
    animation: spin 0.75s linear infinite;
  }

  .mode-chip {
    margin-left: 0.15rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--foreground);
    font-size: 0.65rem;
    font-weight: 650;
    letter-spacing: 0.02em;
  }

  .query {
    margin: 0.4rem 0 0;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.45;
  }

  .detail {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    line-height: 1.4;
  }

  .questions {
    margin-top: 0.65rem;
    display: grid;
    gap: 0.5rem;
  }

  .selector-row {
    display: inline-flex;
    gap: 0.3rem;
  }

  .selector-chip {
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 0.7rem;
    font-weight: 550;
    padding: 0.3rem 0.65rem;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .selector-chip:hover {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  .selector-chip.is-active {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  .options {
    display: grid;
    gap: 0.3rem;
  }

  .option {
    text-align: left;
    border: 0;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--chat-bg) 40%, transparent);
    color: var(--text-secondary);
    font-size: 0.78rem;
    line-height: 1.4;
    font-weight: 450;
    padding: 0.55rem 0.65rem;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .option:hover:not(:disabled) {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  .option.is-active {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
    font-weight: 550;
  }

  .option:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .input {
    border: 0;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--chat-bg) 45%, transparent);
    color: var(--text);
    font-size: 0.8125rem;
    line-height: 1.45;
    padding: 0.55rem 0.65rem;
    resize: vertical;
    min-height: 3.2rem;
    outline: none;
  }

  .input:focus {
    box-shadow: var(--artifact-focus, 0 0 0 2px color-mix(in srgb, var(--primary) 30%, transparent));
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.35rem;
    margin-top: 0.15rem;
  }

  .actions.always {
    margin-top: 0.5rem;
  }

  .btn {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 550;
    padding: 0.35rem 0.55rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .btn:hover {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  .btn.primary {
    color: var(--text);
    background: color-mix(in srgb, var(--artifact-surface-hover, var(--surface-hover)) 80%, transparent);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-icon.spin { animation: none; }
  }
</style>
