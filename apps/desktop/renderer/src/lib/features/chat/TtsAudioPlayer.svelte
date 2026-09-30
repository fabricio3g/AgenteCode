<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage, AppConfig } from '$lib/types/chat';
  import { Pause, Play, X } from 'lucide-svelte';
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
  <div class="tts-player" role="group" aria-label="Voice playback">
    <button type="button" class="tts-play aui-icon-button" onclick={() => void togglePlayback()} aria-label={playing ? 'Pause audio' : active ? 'Resume audio' : 'Play audio'}>
      {#if playing}<Pause class="size-3.5" />{:else}<Play class="size-3.5" />{/if}
    </button>
    {#if active || hasBuffer || message.ttsAudio}<input class="tts-progress" type="range" min="0" max="100" step="0.1" value={progress} disabled={!hasBuffer}
      aria-label="Audio position" aria-valuetext={`${formatTime(elapsed)} of ${formatTime(duration)}`}
      style={`--audio-progress: ${progress}%;`} onchange={(event) => void ttsStore.seek(message.id, Number(event.currentTarget.value) / 100)} />
    <span class="tts-time">{formatTime(elapsed)} <span class="tts-time-separator">/</span> {formatTime(duration)}</span>
    <button type="button" class="aui-icon-button tts-close" onclick={dismiss} aria-label="Close audio player"><X class="size-3" /></button>
    {:else}<span class="tts-time">Listen</span>{/if}
  </div>
{/if}

<style>
  .tts-player { display: flex; align-items: center; gap: 0.75rem; width: 20rem; max-width: 100%; min-width: 0; padding: 0.25rem 0; color: var(--text-secondary); }
  .tts-play { width: 1.5rem; height: 1.5rem; color: var(--text-secondary); border-radius: var(--radius-md); }
  .tts-close { width: 1.25rem; height: 1.25rem; opacity: 0; transition: opacity var(--motion-fast); }
  .tts-player:hover .tts-close, .tts-player:focus-within .tts-close { opacity: 1; }
  .tts-time { flex-shrink: 0; color: var(--text-secondary); font-size: 0.6875rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tts-time-separator { opacity: 0.5; padding: 0 0.125rem; }
  .tts-progress { appearance: none; flex: 1; min-width: 2rem; height: 2px; border-radius: var(--radius-full); background: linear-gradient(to right, var(--text-secondary) var(--audio-progress), color-mix(in srgb, var(--foreground) 12%, transparent) var(--audio-progress)); cursor: pointer; }
  .tts-progress:disabled { cursor: default; }
  .tts-progress::-webkit-slider-thumb { appearance: none; width: 7px; height: 7px; border-radius: 50%; background: transparent; }
  .tts-progress::-moz-range-thumb { width: 7px; height: 7px; border: 0; border-radius: 50%; background: transparent; }
  .tts-progress:not(:disabled):hover::-webkit-slider-thumb, .tts-progress:focus-visible::-webkit-slider-thumb { background: var(--text-secondary); }
  .tts-progress:not(:disabled):hover::-moz-range-thumb, .tts-progress:focus-visible::-moz-range-thumb { background: var(--text-secondary); }
  .tts-progress:focus-visible { outline: 2px solid var(--ring); outline-offset: 5px; }
</style>
