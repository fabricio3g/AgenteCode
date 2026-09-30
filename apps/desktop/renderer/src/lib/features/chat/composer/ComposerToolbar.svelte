<svelte:options runes={true} />

<!--
  Home composer's right-hand cluster, the same shape as Code's: the status
  line (the last reply's tokens and speed, and the context ring), dictation,
  and the shared send/stop button.
-->

<script lang="ts">
  import { Mic } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
  import ContextUsageRing from './ContextUsageRing.svelte';
  import ComposerStatus from '$lib/features/shared/composer/ComposerStatus.svelte';
  import SendButton from '$lib/features/shared/composer/SendButton.svelte';
  import type { Dictation } from './use-dictation.svelte';

  interface Props {
    dictation: Dictation;
    generating: boolean;
    sendDisabled: boolean;
    onsubmit: () => void;
    onstop: () => void;
  }

  let { dictation, generating, sendDisabled, onsubmit, onstop }: Props = $props();

  const contextBudget = $derived(appStore.contextBudget);
  // An empty ring reads as a broken control, so it only appears once there is
  // actual context to report.
  const showContextRing = $derived(!!contextBudget && (contextBudget.usedTokens ?? 0) > 0);
  const hasDraft = $derived(!!appStore.composer.trim());

  const micTitle = $derived(
    !dictation.supported
      ? $t('chat.dictation.unavailable')
      : dictation.phase === 'transcribing'
        ? say.inProgress(copy.status.transcribing)
        : dictation.listening
          ? say.inProgress(copy.status.listening)
          : $t('chat.dictation.start')
  );
</script>

{#snippet contextRing()}
  {#if contextBudget}
    <ContextUsageRing
      usedTokens={contextBudget.usedTokens ?? 0}
      maxTokens={contextBudget.maxContext ?? Number(appStore.config.llm?.local?.context_length || 4096)}
      reservedTokens={contextBudget.reservedForCompletion ?? 0}
      promptCostPerMillionUsd={contextBudget.promptCostPerMillionUsd}
      completionCostPerMillionUsd={contextBudget.completionCostPerMillionUsd}
      estimatedInputCostUsd={contextBudget.estimatedInputCostUsd}
    />
  {/if}
{/snippet}

<div class="composer-bar-trailing">
  <ComposerStatus ring={showContextRing ? contextRing : undefined} />

  {#if !generating}
    <button
      type="button"
      class="aui-icon-button mic-btn size-8"
      class:is-listening={dictation.uiActive}
      class:unavailable={!dictation.supported}
      onclick={dictation.supported ? () => dictation.toggle(false) : undefined}
      disabled={!dictation.supported}
      aria-label={dictation.listening ? $t('chat.dictation.stop') : copy.composer.dictate}
      title={micTitle}
    >
      {#if dictation.listening}
        <span class="mic-lines">
          {#each [0, 1, 2, 3, 4] as index (index)}
            <span class="mic-line" style={`animation-delay: ${index * 0.12}s;`}></span>
          {/each}
        </span>
      {:else}
        <Mic class="size-4" />
      {/if}
    </button>
  {/if}

  <SendButton
    running={generating}
    disabled={sendDisabled || !hasDraft}
    sendLabel={copy.composer.send}
    stopLabel={copy.composer.stop}
    onsend={onsubmit}
    {onstop}
  />
</div>

<style>
  .mic-btn { color: var(--text-secondary); }
  .mic-btn.unavailable { opacity: 0.4; cursor: not-allowed; }
  .mic-btn.is-listening { background: var(--primary); color: var(--primary-foreground); }
  .mic-btn.is-listening:hover { opacity: 0.9; }

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

  @media (prefers-reduced-motion: reduce) {
    .mic-line { animation: none !important; }
  }
</style>
