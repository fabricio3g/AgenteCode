<svelte:options runes={true} />

<script lang="ts">
  import { HeadphoneOff } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';

  interface Props {
    isListening: boolean;
    interimTranscript: string;
    exitVoiceMode: () => void;
    audioLevels: number[];
  }

  let { isListening, interimTranscript, exitVoiceMode, audioLevels }: Props = $props();

  const VOICE_WAVE_HEIGHTS = [28, 36, 46, 34, 26, 38, 52, 58, 44, 32, 26, 37, 49, 35, 28];
  const VOICE_WAVE_DOTS = Array.from({ length: 6 }, (_, i) => i);

  const title = $derived.by(() => {
    if (isListening) return 'TalamoLM is listening...';
    if (appStore.loading) return 'Thinking...';
    if (ttsStore.playing) return 'Speaking...';
    return 'Waiting...';
  });

  const caption = $derived(
    isListening
      ? 'Keep speaking naturally, then tap the mic again to stop.'
      : interimTranscript || ''
  );
</script>

{#if appStore.voiceModeActive || isListening || !!interimTranscript}
  <div class="voice-overlay-card" role="status" aria-live="polite">
    <div class="voice-overlay-copy">
      <span class="voice-overlay-title">{title}</span>
      {#if caption}
        <span class="voice-overlay-caption">{caption}</span>
      {/if}
    </div>

    <div class="voice-overlay-right">
      <div class="voice-wave" aria-hidden="true">
        {#each VOICE_WAVE_HEIGHTS as maxH, i}
          {@const level = audioLevels[i] ?? 0}
          {@const minH = Math.max(24, Math.round(maxH * 0.48))}
          {@const colH = Math.round(minH + (maxH - minH) * level)}
          {@const dotGap = colH > 6 ? Math.floor((colH - 6) / 5) : 0}
          <div
            class="voice-wave-column"
            style="height: {colH}px; gap: {dotGap}px;"
          >
            {#each VOICE_WAVE_DOTS as _d}
              <span class="voice-wave-dot"></span>
            {/each}
          </div>
        {/each}
      </div>

      {#if appStore.voiceModeActive}
        <button
          class="voice-overlay-end"
          onclick={exitVoiceMode}
          title="End voice mode"
        >
          <HeadphoneOff class="h-3.5 w-3.5" />
          End
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .voice-overlay-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    padding: 14px 16px;
    margin-bottom: 8px;
    border-radius: 18px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-l);
    backdrop-filter: blur(12px);
    pointer-events: auto;
  }

  .voice-overlay-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .voice-overlay-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .voice-overlay-caption {
    font-size: 0.75rem;
    color: var(--text-muted);
    max-width: 16rem;
    line-height: 1.45;
  }

  .voice-overlay-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .voice-wave {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 58px;
    flex-shrink: 0;
  }

  .voice-wave-column {
    width: 5px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-self: center;
    transition: height 0.07s ease-out, gap 0.07s ease-out;
  }

  .voice-wave-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .voice-overlay-end {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 8px;
    border: 1px solid rgba(239, 68, 68, 0.22);
    background: transparent;
    color: rgb(220, 38, 38);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .voice-overlay-end:hover {
    background: rgba(239, 68, 68, 0.08);
    border-color: rgba(239, 68, 68, 0.3);
  }

  :global(.dark) .voice-overlay-end {
    color: rgb(248, 113, 113);
  }
</style>
