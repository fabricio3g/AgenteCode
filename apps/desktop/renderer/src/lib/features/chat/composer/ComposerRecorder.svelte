<svelte:options runes={true} />

<!--
  Dictation, inside the composer: while you talk, the chip row becomes a
  recorder — cancel, a live scrolling waveform, the elapsed time, and done.
  Replaces the floating voice card for plain dictation (hands-free voice mode
  keeps its own overlay).
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { Check, Loader2, X } from '$lib/icons';
  import type { Dictation } from './use-dictation.svelte';

  let { dictation }: { dictation: Dictation } = $props();

  const phase = $derived(dictation.phase);
  const time = $derived(`${Math.floor(dictation.elapsed / 60)}:${String(dictation.elapsed % 60).padStart(2, '0')}`);
</script>

<div class="recorder" role="status" aria-live="polite">
  {#if phase === 'setup'}
    <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground" />
    <span class="label">{$t('voice.recorder.settingUp')}</span>
    <div class="setup-bar" aria-hidden="true"><span style:width={`${dictation.setupProgress}%`}></span></div>
    <span class="time">{dictation.setupProgress}%</span>
  {:else if phase === 'transcribing'}
    <span class="shimmer ui-shimmer-text">{$t('voice.recorder.transcribing')}</span>
  {:else if phase === 'error'}
    <span class="label">{$t('voice.recorder.failed')}</span>
    <UiButton variant="plain" type="button" class={uiClass("text-btn", "ui-local-053710f5")} onclick={() => dictation.toggle(false)}>{$t('voice.recorder.retry')}</UiButton>
    <IconButton label={$t('voice.recorder.cancel')} size="xs" variant="ghost" type="button" class={uiClass("icon-btn", "ui-local-053710f5")} onclick={() => dictation.dismiss()}  title={$t('voice.recorder.cancel')}>
      <X class="size-4" />
    </IconButton>
  {:else}
    <IconButton label={$t('voice.recorder.cancel')} size="xs" variant="ghost" type="button" class={uiClass("icon-btn", "ui-local-053710f5")} onclick={() => dictation.cancel()}  title={$t('voice.recorder.cancel')}>
      <X class="size-4" />
    </IconButton>
    {#if phase === 'permission'}
      <span class="label">{$t('voice.recorder.waitingMic')}</span>
    {:else}
      <span class="dot" aria-hidden="true"></span>
      <div class="wave" aria-hidden="true">
        {#each dictation.history as level, i (i)}
          <i style:height={`${Math.max(2, level * 24)}px`}></i>
        {/each}
      </div>
      <span class="time">{time}</span>
    {/if}
    <IconButton label={$t('voice.recorder.done')} size="xs" variant="ghost" type="button" class={uiClass("done-btn", "ui-local-053710f5")} onclick={() => dictation.toggle(false)} disabled={phase !== 'recording'}  title={$t('voice.recorder.done')}>
      <Check class="size-4" />
    </IconButton>
  {/if}
</div>

<style>
  .recorder {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 2rem;
    align-items: center;
    gap: 0.5rem;
    animation: rec-in var(--motion-fast) var(--motion-ease);
  }

  :global(.icon-btn.ui-local-053710f5),
  :global(.done-btn.ui-local-053710f5) {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-full);
    transition: background-color var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }

  :global(.icon-btn.ui-local-053710f5) {
    background: transparent;
    color: var(--muted-foreground);
  }

  :global(.icon-btn:hover.ui-local-053710f5) {
    background: var(--muted);
    color: var(--foreground);
  }

  :global(.done-btn.ui-local-053710f5) {
    margin-left: auto;
    background: var(--foreground);
    color: var(--background);
  }

  :global(.done-btn:disabled.ui-local-053710f5) {
    opacity: 0.35;
  }

  .dot {
    width: 0.4rem;
    height: 0.4rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--error, #e5484d);
    animation: rec-blink 1.2s ease-in-out infinite;
  }

  /* Newest level on the right; bars scroll left as you speak. */
  .wave {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 1.75rem;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    overflow: hidden;
    mask-image: linear-gradient(to right, transparent, black 18%);
  }

  .wave i {
    width: 2px;
    flex-shrink: 0;
    border-radius: 2px;
    background: var(--foreground);
    opacity: 0.7;
    transition: height 60ms linear;
  }

  .time {
    min-width: 2.25rem;
    flex-shrink: 0;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
    text-align: right;
  }

  .label {
    font-size: 0.8125rem;
    color: var(--muted-foreground);
    white-space: nowrap;
  }

  .setup-bar {
    flex: 1;
    height: 3px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--muted);
  }

  .setup-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--foreground);
    transition: width 200ms var(--motion-ease);
  }

  :global(.text-btn.ui-local-053710f5) {
    margin-left: auto;
    border: 0;
    background: transparent;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--foreground);
  }

  .shimmer {
    flex: 1;
    font-size: 0.8125rem;
    --shimmer-duration: 1.4s;
  }

  @keyframes rec-in {
    from { opacity: 0; transform: translateY(2px); }
    to { opacity: 1; transform: none; }
  }

  @keyframes rec-blink {
    50% { opacity: 0.25; }
  }

  @media (prefers-reduced-motion: reduce) {
    .recorder, .dot, .shimmer { animation: none; }
    .wave i { transition: none; }
  }
</style>
