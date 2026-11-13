<svelte:options runes={true} />

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiRange from '$lib/components/ui/Range.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Tooltip } from '$lib/components/ui';
  import type { ChatMessage, AppConfig } from '$lib/types/chat';
  import { Pause, Play, X } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { appStore } from '$lib/stores/app.svelte';

  let { message, onDone, config, showIdle = false }: { message: ChatMessage; onDone?: () => void; config?: AppConfig; showIdle?: boolean } = $props();
  let dismissed = $state(false);
  const active = $derived(ttsStore.currentMessageId === message.id && (ttsStore.playing || ttsStore.paused));
  const playing = $derived(active && ttsStore.playing);
  const hasBuffer = $derived(ttsStore.hasStoredAudio(message.id));
  const duration = $derived(active ? ttsStore.totalDuration : message.ttsAudio?.duration ?? (hasBuffer ? (ttsStore.audioBuffers.get(message.id)?.length ?? 0) / 24000 : 0));
  const elapsed = $derived(active ? ttsStore.elapsedTime : 0);
  const progress = $derived(duration > 0 ? Math.min(100, Math.max(0, elapsed / duration * 100)) : 0);

  function formatTime(seconds: number): string {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, '0')}`;
  }
  async function togglePlayback() {
    if (playing) await ttsStore.pause();
    else if (active && ttsStore.paused) await ttsStore.resume();
    else if (message.content.trim()) await ttsStore.speak(message.id, message.content, config ?? appStore.config);
  }
  function dismiss() {
    if (active) ttsStore.stop();
    dismissed = true;
    onDone?.();
  }
  $effect(() => { if (active) dismissed = false; });
</script>

{#if !dismissed && (showIdle || active || hasBuffer || message.ttsAudio)}
  <div class="tts-player" role="group" aria-label={$t('tts.player.label')}>
    <Tooltip label={playing ? $t('tts.player.pause') : active ? $t('tts.player.resume') : $t('tts.player.play')} position="bottom"><UiIconButton label={playing ? $t('tts.player.pause') : active ? $t('tts.player.resume') : $t('tts.player.play')} size="sm" type="button" class={uiClass("tts-play ", "ui-local-72f54e69")} onclick={() => void togglePlayback()} >
      {#if playing}<Pause class="size-3.5" />{:else}<Play class="size-3.5" />{/if}
    </UiIconButton></Tooltip>
    {#if active || hasBuffer || message.ttsAudio}<UiRange class={uiClass("tts-progress", "ui-local-72f54e69")}  min="0" max="100" step="0.1" value={progress} disabled={!hasBuffer}
      aria-label={$t('tts.player.position')} aria-valuetext={$t('tts.player.positionValue', { values: { elapsed: formatTime(elapsed), duration: formatTime(duration) } })}
      style={`--audio-progress: ${progress}%;`} onchange={(event) => void ttsStore.seek(message.id, Number(event.currentTarget.value) / 100)} />
    <span class="tts-time">{formatTime(elapsed)} <span class="tts-time-separator">/</span> {formatTime(duration)}</span>
    <Tooltip label={$t('tts.player.close')} position="bottom"><UiIconButton label={$t('tts.player.close')} size="sm" type="button" class={uiClass(" tts-close", "ui-local-72f54e69")} onclick={dismiss} ><X class="size-3" /></UiIconButton></Tooltip>
    {:else}<span class="tts-time">{$t('tts.player.listen')}</span>{/if}
  </div>
{/if}

<style>
  .tts-player { display: flex; align-items: center; gap: 0.75rem; width: 20rem; max-width: 100%; min-width: 0; padding: 0.25rem 0; color: var(--text-secondary); }
  :global(.tts-play.ui-local-72f54e69) { width: 1.5rem; height: 1.5rem; color: var(--text-secondary); border-radius: var(--radius-md); }
  :global(.tts-close.ui-local-72f54e69) { width: 1.25rem; height: 1.25rem; opacity: 0; transition: opacity var(--motion-fast); }
  .tts-player:hover :global(.tts-close.ui-local-72f54e69), .tts-player:focus-within :global(.tts-close.ui-local-72f54e69) { opacity: 1; }
  .tts-time { flex-shrink: 0; color: var(--text-secondary); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tts-time-separator { opacity: 0.5; padding: 0 0.125rem; }
  :global(.tts-progress.ui-local-72f54e69) { appearance: none; flex: 1; min-width: 2rem; height: 2px; border-radius: var(--radius-full); background: linear-gradient(to right, var(--text-secondary) var(--audio-progress), color-mix(in srgb, var(--foreground) 12%, transparent) var(--audio-progress)); cursor: pointer; }
  :global(.tts-progress:disabled.ui-local-72f54e69) { cursor: default; }
  :global(.tts-progress.ui-local-72f54e69::-webkit-slider-thumb) { appearance: none; width: 7px; height: 7px; border-radius: 50%; background: transparent; }
  :global(.tts-progress.ui-local-72f54e69::-moz-range-thumb) { width: 7px; height: 7px; border: 0; border-radius: 50%; background: transparent; }
  :global(.tts-progress:not(:disabled):hover.ui-local-72f54e69::-webkit-slider-thumb), :global(.tts-progress:focus-visible.ui-local-72f54e69::-webkit-slider-thumb) { background: var(--text-secondary); }
  :global(.tts-progress:not(:disabled):hover.ui-local-72f54e69::-moz-range-thumb), :global(.tts-progress:focus-visible.ui-local-72f54e69::-moz-range-thumb) { background: var(--text-secondary); }
  :global(.tts-progress:focus-visible.ui-local-72f54e69) { outline: 2px solid var(--ring); outline-offset: 5px; }
</style>
