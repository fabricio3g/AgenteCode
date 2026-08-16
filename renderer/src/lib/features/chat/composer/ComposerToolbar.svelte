<svelte:options runes={true} />

<!--
  The trailing control cluster, sitting inline at the end of the composer row:
  mode chips, context ring, then the single circular send / dictate / stop
  control. Previously this was a separate row stacked under the input, which
  made the composer read as a panel rather than as one input.
-->

<script lang="ts">
  import { ArrowUp, Mic, Paperclip, Square } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
  import ContextUsageRing from './ContextUsageRing.svelte';
  import ModeSelector from './ModeSelector.svelte';
  import ReasoningLevelSelector from './ReasoningLevelSelector.svelte';
  import SearchModeSelector from './SearchModeSelector.svelte';
  import type { Dictation } from './use-dictation.svelte';

  interface Props {
    dictation: Dictation;
    /** Narrow composer: selectors scroll horizontally instead of wrapping. */
    compact: boolean;
    generating: boolean;
    sendDisabled: boolean;
    onsubmit: () => void;
    onstop: () => void;
  }

  let { dictation, compact, generating, sendDisabled, onsubmit, onstop }: Props = $props();

  const contextBudget = $derived(appStore.contextBudget);

  // An empty ring reads as a broken control, so it only appears once there is
  // actual context to report.
  const showContextRing = $derived(!!contextBudget && (contextBudget.usedTokens ?? 0) > 0);

  const hasDraft = $derived(!!appStore.composer.trim());
  // Send is always present so the control row keeps its shape, and greys out
  // until there is something to send. Dictation sits beside it rather than
  // being swapped out from under the cursor mid-sentence.
  const canSend = $derived(!sendDisabled && (hasDraft || generating));

  const micTitle = $derived(
    !dictation.supported
      ? 'Speech recognition not available'
      : dictation.phase === 'transcribing'
        ? say.inProgress(copy.status.transcribing)
        : dictation.listening
          ? say.inProgress(copy.status.listening)
          : 'Tap to speak'
  );
</script>

<div class="trailing" class:compact>
  <!-- Search and reasoning moved into the composer's "+" menu; only the mode
       tabs (an opt-in setting) still sit inline. -->
  <div class="chips" class:overflow-x-auto={compact}>
    {#if appStore.composerModeControl === 'tabs'}
      <ModeSelector />
    {/if}
  </div>

  <div class="controls">
    {#if contextBudget && showContextRing}
      <ContextUsageRing
        usedTokens={contextBudget.usedTokens ?? 0}
        maxTokens={contextBudget.maxContext ??
          Number(appStore.config.llm?.local?.context_length || 4096)}
        reservedTokens={contextBudget.reservedForCompletion ?? 0}
        promptCostPerMillionUsd={contextBudget.promptCostPerMillionUsd}
        completionCostPerMillionUsd={contextBudget.completionCostPerMillionUsd}
        estimatedInputCostUsd={contextBudget.estimatedInputCostUsd}
      />
    {/if}

    {#if !generating}
      <button
        type="button"
        class="aui-icon-button mic-btn size-8"
        class:is-listening={dictation.uiActive}
        class:unavailable={!dictation.supported}
        onclick={dictation.supported ? () => dictation.toggle(false) : undefined}
        disabled={!dictation.supported}
        aria-label={dictation.listening ? 'Stop listening' : copy.composer.dictate}
        title={micTitle}
      >
        {#if dictation.listening}
          <span class="mic-lines">
            {#each [0, 1, 2, 3, 4] as index}
              <span class="mic-line" style={`animation-delay: ${index * 0.12}s;`}></span>
            {/each}
          </span>
        {:else}
          <Mic class="size-4" />
        {/if}
      </button>
    {/if}

    <button
      type="button"
      class="send-btn flex size-8 items-center justify-center rounded-full transition"
      onclick={() => (generating ? onstop() : onsubmit())}
      disabled={!canSend}
      aria-label={generating ? copy.composer.stop : copy.composer.send}
      title={generating ? copy.composer.stop : copy.composer.send}
    >
      {#if generating}
        <Square class="size-3.5 fill-current stroke-[2.75]" />
      {:else}
        <span class="send-icon inline-flex">
          <ArrowUp class="size-4 stroke-[2.75]" />
        </span>
      {/if}
    </button>
  </div>
</div>

<style>
  /* Spans the composer's action row: mode chips stay left beside the attach
     button, dictate/send are pushed to the far right. */
  .trailing {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem;
    min-width: 0;
  }

  .chips {
    display: flex;
    min-width: 0;
    flex: 0 1 auto;
    align-items: center;
    gap: 0.25rem;
  }

  .controls {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
  }

  .send-btn {
    border: none;
    background: var(--primary);
    color: var(--primary-foreground);
    box-shadow: none;
    transition:
      background-color 150ms ease,
      opacity 150ms ease,
      transform 150ms var(--motion-ease);
  }

  .send-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  /* Idle send: a quiet filled circle that still reads as the primary action,
     rather than the black button at half opacity that `disabled:opacity-50`
     produced. */
  .send-btn:disabled {
    background: color-mix(in srgb, var(--foreground) 26%, transparent);
    color: var(--background);
    cursor: default;
  }

  .send-btn:active:not(:disabled) {
    transform: scale(0.96);
  }

  .send-icon {
    transform-origin: center;
    transition: transform 200ms var(--motion-ease);
  }

  .send-btn:hover:not(:disabled) .send-icon {
    transform: translateY(-1px);
  }

  /* Scale on hover lives on the button: a scoped rule cannot reach the icon,
     which is rendered by a child component. */
  /* Matches the add button and model chip on the same row. */
  .mic-btn {
    color: var(--text-secondary);
  }

  .mic-btn :global(svg) {
    transition: transform 0.3s ease;
  }

  .mic-btn:hover :global(svg) {
    transform: scale(1.1);
  }

  .mic-btn.unavailable {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .mic-btn.is-listening {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .mic-btn.is-listening:hover {
    opacity: 0.9;
  }

  .mic-lines {
    display: flex;
    height: 14px;
    align-items: center;
    justify-content: center;
    gap: 2px;
  }

  .mic-line {
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: currentColor;
    animation: micLineBounce 0.8s ease-in-out infinite;
  }

  @keyframes micLineBounce {
    0%, 100% { height: 5px; opacity: 0.5; }
    50% { height: 14px; opacity: 1; }
  }

  /* Narrow composer: the chips scroll rather than pushing the send control out
     of the row. */
  .trailing.compact .chips {
    max-width: 9rem;
    scrollbar-width: none;
  }

  .trailing.compact .chips::-webkit-scrollbar {
    display: none;
  }

  .trailing.compact .chips :global(.mode-selector-trigger),
  .trailing.compact .chips :global(.search-selector-trigger) {
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .mic-line { animation: none !important; }
  }
</style>
