<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage } from '$lib/types/chat';
  import { Pause, Play, X } from 'lucide-svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    message: ChatMessage;
    onDone?: () => void;
  }

  let { message, onDone }: Props = $props();

  function formatTime(seconds: number): string {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, '0')}`;
  }

  const isCurrentlyPlaying = $derived(
    ttsStore.playing && ttsStore.currentMessageId === message.id
  );

  const isGeneratingThis = $derived(
    ttsStore.isGenerating && ttsStore.currentMessageId === message.id
  );

  const hasBuffer = $derived(ttsStore.hasStoredAudio(message.id));
  const hasPersistedAudio = $derived(!!message.ttsAudio);
  const wasGenerating = $derived(isGeneratingThis);

  const elapsed = $derived(
    isCurrentlyPlaying ? ttsStore.elapsedTime : ttsStore.totalDuration
  );

  const duration = $derived(
    isCurrentlyPlaying ? ttsStore.totalDuration : (message.ttsAudio?.duration ?? ttsStore.totalDuration)
  );

  const progress = $derived(duration > 0 ? elapsed / duration : 0);

  // Generate deterministic waveform heights using seeded PRNG
  const barHeights: number[] = [];
  for (let i = 0; i < 32; i++) {
    barHeights.push(((i * 7919 + 104729) % 98311) / 98311);
  }

  function handlePlayPause() {
    if (isCurrentlyPlaying) {
      ttsStore.stop();
      return;
    }
    if (hasBuffer) {
      ttsStore.replay(message.id);
      return;
    }
    const text = message.content || '';
    if (!text.trim()) return;
    ttsStore.speak(message.id, text, appStore.config);
  }

  function handleSeek(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, fraction));
    ttsStore.seek(message.id, clamped);
  }

  function handleStop() {
    ttsStore.stop();
    onDone?.();
  }

  $effect(() => {
    const id = message.id;
    const handler = (msgId: string, dur: number) => {
      if (msgId === id && !message.ttsAudio) {
        message.ttsAudio = {
          duration: dur,
          voice: appStore.config.tts?.voice || 'af_heart',
          generatedAt: Date.now()
        };
        appStore.persist();
      }
    };
    ttsStore.onAudioComplete = handler;
    return () => {
      if (ttsStore.onAudioComplete === handler) ttsStore.onAudioComplete = null;
    };
  });
</script>

<!-- Only render the player when there's active TTS state -->
{#if isGeneratingThis || isCurrentlyPlaying || hasPersistedAudio || hasBuffer}
  {#if isGeneratingThis}
    <!-- Generating: compact waveform with shimmer -->
    <div class="tts-player tts-generating">
      <div class="tts-waveform-live">
        {#each barHeights as h, i}
          <div
            class="tts-bar"
            style="--bar-h: {Math.max(2, h * 16)}px;"
          ></div>
        {/each}
      </div>
      <span class="tts-label">
        {#if ttsStore.progress}
          {ttsStore.progress.index}/{ttsStore.progress.total}
        {:else}
          Generating…
        {/if}
      </span>
      <button class="tts-stop-btn" onclick={handleStop} aria-label="Stop" title="Stop">
        <X class="h-3 w-3" />
      </button>
    </div>
  {:else if isCurrentlyPlaying}
    <!-- Playing: pause + waveform + time + stop -->
    <div class="tts-player tts-playing">
      <button class="tts-play-btn" onclick={handlePlayPause} aria-label="Pause">
        <Pause class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="tts-waveform" onclick={handleSeek} aria-label="Seek audio">
        {#each barHeights as h, i}
          {@const barPlayed = i / 32 <= progress}
          <div
            class="tts-bar-play"
            class:played={barPlayed}
            style="height: {Math.max(2, h * 16)}px;"
          ></div>
        {/each}
      </button>
      <span class="tts-time">
        {formatTime(elapsed)} / {formatTime(duration)}
      </span>
      <button class="tts-stop-btn" onclick={handleStop} aria-label="Stop" title="Stop">
        <X class="h-3 w-3" />
      </button>
    </div>
  {:else}
    <!-- Finished: replay + waveform + duration + close -->
    <div class="tts-player tts-finished">
      <button class="tts-play-btn" onclick={handlePlayPause} aria-label="Replay">
        <Play class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="tts-waveform" onclick={handleSeek} aria-label="Seek audio">
        {#each barHeights as h, i}
          {@const barPlayed = i / 32 <= progress}
          <div
            class="tts-bar-play"
            class:played={barPlayed}
            style="height: {Math.max(2, h * 16)}px;"
          ></div>
        {/each}
      </button>
      <span class="tts-time">
        {formatTime(duration)}
      </span>
      <button class="tts-stop-btn" onclick={handleStop} aria-label="Close" title="Close">
        <X class="h-3 w-3" />
      </button>
    </div>
  {/if}
{/if}

<style>
  .tts-player {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.375rem;
    border-radius: 9999px;
    max-width: 240px;
    transition: all 0.3s ease;
  }

  /* ─── Generating state ─── */
  .tts-generating {
    animation: ttsGeneratingPulse 2s ease-in-out infinite;
  }

  @keyframes ttsGeneratingPulse {
    0%, 100% { border-color: var(--border); }
    50% { border-color: var(--border); }
  }

  .tts-waveform-live {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 18px;
    min-width: 80px;
    max-width: 96px;
  }

  .tts-waveform-live .tts-bar {
    width: 2.5px;
    border-radius: 1.5px;
    background: var(--primary);
    height: var(--bar-h, 4px);
    transform-origin: center;
    backface-visibility: hidden;
    animation: ttsGeneratingBar 0.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  @keyframes ttsGeneratingBar {
    0%, 100% { transform: scaleY(0.35); opacity: 0.5; }
    50% { transform: scaleY(1); opacity: 1; }
  }

  .tts-waveform-live .tts-bar:nth-child(4n+1) { animation-delay: 0s; }
  .tts-waveform-live .tts-bar:nth-child(4n+2) { animation-delay: 0.06s; }
  .tts-waveform-live .tts-bar:nth-child(4n+3) { animation-delay: 0.12s; }
  .tts-waveform-live .tts-bar:nth-child(4n) { animation-delay: 0.18s; }

  .tts-generating .tts-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 48px;
  }

  /* ─── Playing / Finished states ─── */
  .tts-finished {
    animation: ttsFinishFlash 500ms ease-out;
  }

  @keyframes ttsFinishFlash {
    0% { transform: scale(0.96); opacity: 0.6; border-color: var(--primary); }
    40% { transform: scale(1.02); opacity: 1; }
    100% { transform: scale(1); opacity: 1; border-color: var(--border); }
  }

  .tts-waveform {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 18px;
    min-width: 80px;
    max-width: 96px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .tts-waveform .tts-bar-play {
    width: 2.5px;
    border-radius: 1.5px;
    background: var(--border);
    transform-origin: center;
    transition: background 0.12s ease;
  }

  .tts-waveform .tts-bar-play.played {
    background: var(--primary);
  }

  .tts-playing .tts-waveform .tts-bar-play {
    animation: ttsPlayBar 0.8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  @keyframes ttsPlayBar {
    0%, 100% { transform: scaleY(1); }
    50% { transform: scaleY(0.85); }
  }

  .tts-playing .tts-waveform .tts-bar-play:nth-child(4n+1) { animation-delay: 0s; }
  .tts-playing .tts-waveform .tts-bar-play:nth-child(4n+2) { animation-delay: 0.1s; }
  .tts-playing .tts-waveform .tts-bar-play:nth-child(4n+3) { animation-delay: 0.2s; }
  .tts-playing .tts-waveform .tts-bar-play:nth-child(4n) { animation-delay: 0.3s; }

  .tts-time {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    min-width: 48px;
    text-align: right;
  }

  /* ─── Buttons ─── */
  .tts-play-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 9999px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.12s ease, background 0.12s ease;
  }
  .tts-play-btn:hover {
    color: var(--text);
    background: var(--surface);
  }

  .tts-stop-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 9999px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.12s ease, background 0.12s ease;
  }
  .tts-stop-btn:hover {
    color: var(--text);
    background: var(--surface);
  }
</style>
