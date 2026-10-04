<svelte:options runes={true} />

<!--
  Home composer's right-hand cluster, the same shape as Code's: the status
  context ring with its details card, dictation,
  and the shared send/stop button.
-->

<script lang="ts">
  import { Tooltip } from '$lib/components/ui';
  import { Mic, Phone, Settings2 } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
  import ContextUsageRing from './ContextUsageRing.svelte';
  import SendButton from '$lib/features/shared/composer/SendButton.svelte';
  import type { Dictation } from './use-dictation.svelte';

  interface Props {
    dictation: Dictation;
    generating: boolean;
    sendDisabled: boolean;
    oncall: () => void;
    onsubmit: () => void;
    onstop: () => void;
  }

  let { dictation, generating, sendDisabled, oncall, onsubmit, onstop }: Props = $props();

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

<div class="composer-bar-trailing">
  {#if showContextRing && contextBudget}
    <ContextUsageRing
      usedTokens={contextBudget.usedTokens ?? 0}
      maxTokens={contextBudget.maxContext ?? Number(appStore.config.llm?.local?.context_length || 4096)}
      reservedTokens={contextBudget.reservedForCompletion ?? 0}
      promptCostPerMillionUsd={contextBudget.promptCostPerMillionUsd}
      completionCostPerMillionUsd={contextBudget.completionCostPerMillionUsd}
      estimatedInputCostUsd={contextBudget.estimatedInputCostUsd}
      remaining={contextBudget.remaining}
      estimated={contextBudget.estimated}
      usagePercent={contextBudget.usagePercent}
    />
  {/if}

  <div class="mic-control">
    <button
      type="button"
      class="ui-icon-button mic-btn"
      class:is-listening={dictation.uiActive}
      class:unavailable={!dictation.supported}
      onclick={dictation.supported ? () => appStore.voiceModeActive ? oncall() : dictation.toggle(false) : undefined}
      disabled={!dictation.supported}
      aria-label={dictation.listening ? $t('chat.dictation.stop') : copy.composer.dictate}
      aria-describedby="home-microphone-preview"
    >
      {#if dictation.listening}
        <span class="mic-lines">
          {#each [0, 1, 2, 3, 4] as index (index)}
            <span class="mic-line" style={`animation-delay: ${index * 0.12}s;`}></span>
          {/each}
        </span>
      {:else}
        <Mic class="size-3.5" />
      {/if}
    </button>
    <div class="mic-preview" id="home-microphone-preview" role="group" aria-label={$t('voice.call.title')}>
      <Tooltip label={appStore.voiceModeActive ? $t('voice.call.end') : $t('voice.call.start')} position="top">
        <button type="button" class="ui-icon-button" class:selected={appStore.voiceModeActive} aria-label={appStore.voiceModeActive ? $t('voice.call.end') : $t('voice.call.start')} onclick={oncall} disabled={!dictation.supported}><Phone class="size-4" /></button>
      </Tooltip>
      <Tooltip label={micTitle} position="top">
        <button type="button" class="ui-icon-button" class:selected={dictation.listening} aria-label={copy.composer.dictate} onclick={() => { if (appStore.voiceModeActive) oncall(); dictation.toggle(false); }} disabled={!dictation.supported}><Mic class="size-4" /></button>
      </Tooltip>
      <Tooltip label={$t('voice.call.settings')} position="top">
        <button type="button" class="ui-icon-button" aria-label={$t('voice.call.settings')} onclick={() => appStore.openSettings('voice')}><Settings2 class="size-4" /></button>
      </Tooltip>
    </div>
  </div>

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
  .mic-control { position: relative; }
  .mic-preview { position: absolute; right: 0; bottom: 100%; z-index: 60; padding: .35rem; display: none; align-items: center; gap: .2rem; background: var(--popover); color: var(--popover-foreground); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); }
  .mic-control:hover .mic-preview, .mic-control:focus-within .mic-preview { display: flex; }
  .mic-preview .selected { background: var(--muted); color: var(--foreground); }
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
