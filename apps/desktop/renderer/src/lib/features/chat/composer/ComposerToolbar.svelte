<svelte:options runes={true} />

<!--
  Home composer's right-hand cluster, the same shape as Code's: the status
  context ring with its details card, dictation,
  and the shared send/stop button.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Tooltip } from '$lib/components/ui';
  import { Mic, Phone, Settings2 } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
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
  <div class="mic-control">
    <UiIconButton label={dictation.listening ? $t('chat.dictation.stop') : copy.composer.dictate} size="sm"
      type="button"
      class={uiClass("mic-btn composer-icon-control", "ui-local-b54fdc09", {"is-listening": dictation.uiActive, "unavailable": !dictation.supported})}


      onclick={dictation.supported ? () => appStore.voiceModeActive ? oncall() : dictation.toggle(false) : undefined}
      disabled={!dictation.supported}

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
    </UiIconButton>
    <div class="mic-preview" id="home-microphone-preview" role="group" aria-label={$t('voice.call.title')}>
      <Tooltip label={appStore.voiceModeActive ? $t('voice.call.end') : $t('voice.call.start')} position="top">
        <UiIconButton label={appStore.voiceModeActive ? $t('voice.call.end') : $t('voice.call.start')} size="sm" type="button" class={uiClass("", "ui-local-b54fdc09", {"selected": appStore.voiceModeActive})}   onclick={oncall} disabled={!dictation.supported}><Phone class="size-4" /></UiIconButton>
      </Tooltip>
      <Tooltip label={micTitle} position="top">
        <UiIconButton label={copy.composer.dictate} size="sm" type="button" class={uiClass("", "ui-local-b54fdc09", {"selected": dictation.listening})}   onclick={() => { if (appStore.voiceModeActive) oncall(); dictation.toggle(false); }} disabled={!dictation.supported}><Mic class="size-4" /></UiIconButton>
      </Tooltip>
      <Tooltip label={$t('voice.call.settings')} position="top">
        <UiIconButton label={$t('voice.call.settings')} size="sm" type="button" class={uiClass("", "ui-local-b54fdc09")}  onclick={() => appStore.openSettings('voice')}><Settings2 class="size-4" /></UiIconButton>
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
  .mic-preview { position: absolute; right: -0.25rem; bottom: calc(100% + 0.25rem); z-index: var(--z-float); padding: var(--float-pad); display: none; align-items: center; gap: .2rem; background: var(--float-bg); color: var(--popover-foreground); border: 1px solid var(--float-border); border-radius: var(--float-radius); box-shadow: var(--float-shadow); }
  /* Bridges the gap to the button so the pointer can travel up into the card. */
  .mic-preview::after { content: ''; position: absolute; inset-inline: 0; top: 100%; height: 0.5rem; }
  .mic-control:hover .mic-preview, .mic-control:focus-within .mic-preview { display: flex; }
  .mic-preview :global(.selected.ui-local-b54fdc09) { background: var(--muted); color: var(--foreground); }
  :global(.mic-btn.ui-local-b54fdc09) { color: var(--text-secondary); }
  :global(.mic-btn.unavailable.ui-local-b54fdc09) { opacity: 0.4; cursor: not-allowed; }
  :global(.mic-btn.is-listening.ui-local-b54fdc09) { background: var(--primary); color: var(--primary-foreground); }
  :global(.mic-btn.is-listening:hover.ui-local-b54fdc09) { opacity: 0.9; }

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
