<svelte:options runes={true} />

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import UiButton from '$lib/components/ui/Button.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { ArrowRight, SkipForward, Square } from 'lucide-svelte';
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
        <TileMeter mode="busy" />
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
          <UiButton variant="plain" type="button" class={uiClass(`selector-chip ${!useCustom ? 'is-active' : ''}`, "ui-local-f6d100e7")} onclick={() => (useCustom = false)}>
            Suggested
          </UiButton>
          <UiButton variant="plain" type="button" class={uiClass(`selector-chip ${useCustom ? 'is-active' : ''}`, "ui-local-f6d100e7")} onclick={() => (useCustom = true)}>
            Custom
          </UiButton>
        </div>

        {#if !useCustom}
          <div class="options">
            {#each activeTask.questions as question (question.id)}
              <UiButton variant="plain"
                type="button"
                class={uiClass(`option ${selectedOptionId === question.id ? 'is-active' : ''}`, "ui-local-f6d100e7")}
                onclick={() => (selectedOptionId = question.id)}
                disabled={!question.suggestedAnswer}
              >
                {question.suggestedAnswer || question.question}
              </UiButton>
            {/each}
          </div>
        {:else}
          <UiTextarea
            rows={3}
            class={uiClass("input", "ui-local-f6d100e7")}
            bind:value={customText}
            placeholder="Write your research direction"
          ></UiTextarea>
        {/if}

        <div class="actions">
          <UiButton variant="plain" type="button" class={uiClass("btn", "ui-local-f6d100e7")} onclick={stopActiveTask}>
            <Square class="h-3 w-3 fill-current" />
            Stop
          </UiButton>
          <UiButton variant="plain" type="button" class={uiClass("btn", "ui-local-f6d100e7")} onclick={() => submitAnswers(true)}>
            <SkipForward class="h-3.5 w-3.5" />
            Skip
          </UiButton>
          <UiButton variant="plain" type="button" class={uiClass("btn primary", "ui-local-f6d100e7")} onclick={() => submitAnswers(false)}>
            <ArrowRight class="h-3.5 w-3.5" />
            Continue
          </UiButton>
        </div>
      </div>
    {:else if isWorking}
      <div class="actions always">
        <UiButton variant="plain" type="button" class={uiClass("btn", "ui-local-f6d100e7")} onclick={stopActiveTask}>
          <Square class="h-3 w-3 fill-current" />
          Stop
        </UiButton>
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

  .mode-chip {
    margin-left: 0.15rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--foreground);
    font-size: var(--text-xs);
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

  :global(.selector-chip.ui-local-f6d100e7) {
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

  :global(.selector-chip:hover.ui-local-f6d100e7) {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  :global(.selector-chip.is-active.ui-local-f6d100e7) {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  .options {
    display: grid;
    gap: 0.3rem;
  }

  :global(.option.ui-local-f6d100e7) {
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

  :global(.option:hover:not(:disabled).ui-local-f6d100e7) {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  :global(.option.is-active.ui-local-f6d100e7) {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
    font-weight: 550;
  }

  :global(.option:disabled.ui-local-f6d100e7) {
    opacity: 0.5;
    cursor: default;
  }

  :global(.input.ui-local-f6d100e7) {
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

  :global(.input:focus.ui-local-f6d100e7) {
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

  :global(.btn.ui-local-f6d100e7) {
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

  :global(.btn:hover.ui-local-f6d100e7) {
    background: var(--artifact-surface-hover, var(--surface-hover));
    color: var(--text);
  }

  :global(.btn.primary.ui-local-f6d100e7) {
    color: var(--text);
    background: color-mix(in srgb, var(--artifact-surface-hover, var(--surface-hover)) 80%, transparent);
  }

</style>
