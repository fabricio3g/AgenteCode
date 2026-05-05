<svelte:options runes={true} />

<script lang="ts">
  import { ArrowRight, LoaderCircle, SkipForward, Square } from 'lucide-svelte';
  import { cancelDeepResearchTask, deepResearchStore, type ResearchQuestion } from '$lib/stores/deep-research.svelte';

  interface Props {
    messageId?: string | null;
  }

  let { messageId = null }: Props = $props();

  const activeTask = $derived.by(() => {
    return deepResearchStore.getActiveTaskForMessage(messageId);
  });

  let answers = $state<Record<string, string>>({});

  $effect(() => {
    if (!activeTask || activeTask.status !== 'awaiting_input') {
      answers = {};
      return;
    }
    const next: Record<string, string> = {};
    for (const question of activeTask.questions || []) {
      next[question.id] = activeTask.answers?.[question.id] || question.suggestedAnswer || '';
    }
    answers = next;
  });

  function stopActiveTask() {
    if (!activeTask) return;
    cancelDeepResearchTask(activeTask.id);
  }

  function phaseLabel(step: string) {
    switch (step) {
      case 'queued':
        return 'Queued';
      case 'awaiting_input':
        return 'Needs input';
      case 'searching':
        return 'Searching';
      case 'crawling':
        return 'Crawling';
      case 'synthesizing':
        return 'Writing summary';
      default:
        return step.replace(/_/g, ' ');
    }
  }

  function setAnswer(id: string, value: string) {
    answers = { ...answers, [id]: value };
  }

  function submitAnswers(skip = false) {
    if (!activeTask) return;
    deepResearchStore.submitTaskAnswers(activeTask.id, answers, skip);
  }

  function isAiSuggested(question: ResearchQuestion) {
    return question.suggestedAnswerSource === 'ai' && !!question.suggestedAnswer;
  }
</script>

{#if activeTask}
  <div class="research-row mb-4">
    <div class="research-content">
      <span class="research-label">
        <LoaderCircle class="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
        {activeTask.mode === 'max' ? 'Max research' : 'Deep research'}
        <span class="research-phase">{phaseLabel(activeTask.currentStep)}</span>
      </span>
      <span class="research-query">{activeTask.query}</span>

      {#if activeTask.status === 'awaiting_input' && activeTask.questions?.length}
        <div class="question-box">
          {#each activeTask.questions as question (question.id)}
            <label class="question-field" for={`research-question-${question.id}`}>
              <span class="question-header">
                <span class="question-label">{question.question}</span>
                {#if isAiSuggested(question)}
                  <span class="suggestion-badge">AI suggested</span>
                {/if}
              </span>
              {#if question.hint}
                <span class="question-hint">{question.hint}</span>
              {/if}
              <textarea
                id={`research-question-${question.id}`}
                class="question-input"
                rows={2}
                value={answers[question.id] || ''}
                oninput={(event) => setAnswer(question.id, (event.currentTarget as HTMLTextAreaElement).value)}
                placeholder="Optional"
              ></textarea>
            </label>
          {/each}
          <div class="question-actions">
            <button class="question-btn" onclick={() => submitAnswers(true)}>
              <SkipForward class="h-3.5 w-3.5" />
              Skip & search
            </button>
            <button class="question-btn primary" onclick={() => submitAnswers(false)}>
              <ArrowRight class="h-3.5 w-3.5" />
              Apply answers
            </button>
          </div>
        </div>
      {/if}
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

  .research-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    flex: 1;
  }

  .research-label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
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
    background: var(--surface-hover);
    color: var(--text);
  }

  .question-box {
    margin-top: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 0.65rem;
    padding: 0.65rem;
    display: grid;
    gap: 0.55rem;
  }

  .question-field {
    display: grid;
    gap: 0.3rem;
  }

  .question-label {
    font-size: 0.76rem;
    color: var(--text);
    font-weight: 600;
  }

  .question-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .suggestion-badge {
    font-size: 0.62rem;
    line-height: 1;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.2rem 0.45rem;
    background: var(--surface);
    white-space: nowrap;
  }

  .question-hint {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .question-input {
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    padding: 0.45rem 0.55rem;
    font-size: 0.76rem;
    color: var(--text);
    background: var(--surface);
    outline: none;
    width: 100%;
    min-height: 2.3rem;
    resize: vertical;
    line-height: 1.35;
  }

  .question-input:focus {
    border-color: var(--border-hover);
  }

  .question-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
  }

  .question-btn {
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 0.72rem;
    padding: 0.35rem 0.55rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .question-btn:hover {
    color: var(--text);
    border-color: var(--border);
    background: var(--surface-hover);
  }

  .question-btn.primary {
    background: var(--surface);
    border-color: var(--border-hover);
    color: var(--text);
  }
</style>
