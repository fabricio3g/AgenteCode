<svelte:options runes={true} />

<script lang="ts">
  import { ArrowRight, LoaderCircle, SkipForward, Square } from 'lucide-svelte';
  import { cancelDeepResearchTask, deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    messageId?: string | null;
  }

  let { messageId = null }: Props = $props();

  const activeTask = $derived.by(() => deepResearchStore.getActiveTaskForMessage(messageId));
  const isWorking = $derived(activeTask && ['queued', 'searching', 'crawling', 'synthesizing'].includes(activeTask.status));

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
  <section class="research-card mb-4">
    <header class="research-head">
      <div class="left">
        {#if isWorking}
          <LoaderCircle class="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
        {/if}
      </div>

    </header>

    <p class="query">{activeTask.query}</p>
    {#if activeTask.detail?.toLowerCase().includes('auto-options failed')}
      <p class="query" style="margin-top:0.25rem;">Couldn’t generate suggestions this time. Please write your own direction.</p>
    {/if}

    {#if activeTask.status === 'awaiting_input' && activeTask.questions?.length}
      <div class="questions">
        <div class="selector-row">
          <button class={`selector-chip ${!useCustom ? 'is-active' : ''}`} onclick={() => (useCustom = false)}>
            Use suggested
          </button>
          <button class={`selector-chip ${useCustom ? 'is-active' : ''}`} onclick={() => (useCustom = true)}>
            Write my own
          </button>
        </div>

        {#if !useCustom}
          <div class="options">
            {#each activeTask.questions as question (question.id)}
              <button
                class={`option ${selectedOptionId === question.id ? 'is-active' : ''}`}
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
            placeholder="Write your own research direction"
          ></textarea>
        {/if}

        <div class="actions">
          <button class="btn" onclick={stopActiveTask} aria-label="Stop research" title="Stop">
            <Square class="h-3 w-3 fill-current" />
            Stop
          </button>
          <button class="btn" onclick={() => submitAnswers(true)}>
            <SkipForward class="h-3.5 w-3.5" />
            Skip
          </button>
          <button class="btn primary" onclick={() => submitAnswers(false)}>
            <ArrowRight class="h-3.5 w-3.5" />
            Continue
          </button>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .research-card {
    border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
    background: color-mix(in srgb, var(--surface) 96%, transparent);
    border-radius: 12px;
    padding: 12px;
    max-width: 680px;
    width: 100%;
    margin-inline: auto;
  }

  .research-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .left { display: inline-flex; align-items: center; gap: 0.42rem; min-width: 0; }

  .query {
    margin: 0.45rem 0 0;
    font-size: 13px;
    font-weight: 450;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .questions { margin-top: 0.7rem; display: grid; gap: 0.55rem; padding-top: 0.6rem; }
  .selector-row { display: inline-flex; gap: 0.4rem; }

  .selector-chip {
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 500;
    padding: 5px 11px;
    transition: all 120ms ease;
  }
  .selector-chip:hover { background: var(--surface-hover); color: var(--text); }
  .selector-chip.is-active {
    border-color: color-mix(in srgb, var(--border) 90%, transparent);
    color: var(--text);
    background: color-mix(in srgb, var(--surface-hover) 85%, transparent);
  }

  .options { display: grid; gap: 0.4rem; }

  .option {
    text-align: left;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.45;
    font-weight: 450;
    padding: 9px 10px;
    transition: all 120ms ease;
  }
  .option:hover { background: var(--surface-hover); color: var(--text); }
  .option.is-active {
    border-color: color-mix(in srgb, var(--border) 90%, transparent);
    background: color-mix(in srgb, var(--surface-hover) 75%, transparent);
    color: var(--text);
  }

  .input {
    border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
    background: transparent;
    border-radius: 9px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    font-weight: 450;
    padding: 8px 10px;
    resize: vertical;
    min-height: 52px;
    outline: none;
  }
  .input:focus {
    border-color: var(--border-hover);
    background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
    opacity: 0;
    transform: translateY(3px);
    transition: opacity 140ms ease, transform 140ms ease;
  }

  .research-card:hover .actions,
  .research-card:focus-within .actions {
    opacity: 1;
    transform: translateY(0);
  }

  .btn {
    border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
    border-radius: 8px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    padding: 6px 10px;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .btn:hover { background: var(--surface-hover); color: var(--text); }
  .btn.primary {
    color: var(--text);
    border-color: var(--border-hover);
    background: color-mix(in srgb, var(--surface-hover) 55%, transparent);
  }
</style>
